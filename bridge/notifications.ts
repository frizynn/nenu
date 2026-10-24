import { describeAlert, type AlertDetail, type NotifiableStatus } from "./alert-detail.ts";
import { pushActions } from "./interactions.ts";
import type { PushMessage } from "./push.ts";
import type { AgentStatus, AgentView, Interaction } from "./types.ts";

// A notification shouldn't be fire-and-forget. This coordinator gives every blocked/done alert a
// lifecycle, and each agent its own notification (.adr/0070):
//
//   • Debounce + cancel — an agent that blocks and unblocks within the window (you handled it at your
//     desk) never reaches your phone. Herdr exposes no "user present" signal (only a `focused` pane,
//     no activity timestamp), so we infer presence: a quickly-resolved transition is an at-desk one.
//   • One per agent — each agent's alert is its own notification, tagged by its pane, saying who it is,
//     what it answered and where. A herd digest ("3 agents finished") rewrote one slot on every new
//     alert, so each agent's arrival buzzed a count that named nobody.
//   • Once until seen — an agent that finishes again before you looked at it in Nenu does not notify
//     again; a different kind (finished, then waiting on you) still does.
//   • Never silent — every push shows a notification. iOS revokes a web-push subscription after a few
//     pushes that show nothing, so nothing is retracted by push: the app closes what you handled when
//     it opens, and nothing is sent while Nenu is open on a screen (the sink's mute gate). ADR 0072.
//   • Name — each alert says who it is to the operator (the pane's own label, else its workspace),
//     what started its turn, and the first line of what it answered
//     (alert-detail.ts). A turn a subagent's result started answers to its own switch.
//
// Pure and clock-injected so `bun test` drives it without real timers: the bridge passes
// setTimeout/clearTimeout (see server.ts); tests pass a fake clock they fire on demand.


/** The timer primitive the coordinator schedules against — real setTimeout in the bridge, fake in tests. */
export interface NotifyClock<H> {
  schedule(fn: () => void, delayMs: number): H;
  cancel(handle: H): void;
}

/** One agent's notification. */
export interface AgentNotice {
  /** Who and what: "t-0093 Wholesale orders finished", "api needs you". */
  title: string;
  /** What it answered (first line) and where it runs. */
  body: string;
  /** The agent's pane: the notification's slot and its deep-link target. */
  paneId: string;
  /** Alert (buzz) the device. */
  renotify: boolean;
}

/** What became of a notice: pushed, or held back by a snooze or by Nenu open on a screen. */
export type NoticeOutcome = "sent" | "snoozed" | "open";

export interface NotifySink {
  /** Show (or replace) this agent's notification. */
  render(notice: AgentNotice): NoticeOutcome;
}

/** Just the transport the sink needs — "deliver this message to the devices". */
export interface PushSender {
  send(msg: PushMessage): unknown;
}
/** Just the check the sink needs — "should nothing be pushed right now, and why?": a snooze, or Nenu open on a screen. */
export interface MuteGate {
  muted(): Exclude<NoticeOutcome, "sent"> | null;
}

/**
 * Build the {@link NotifySink} the coordinator drives. Each agent gets its own notification slot,
 * `<herdTag>:<paneId>`, so its render replaces only its own; the mute gate (a snooze, or Nenu open on
 * a screen) sends nothing. `sessionName` (the registry name) is stamped into the push payload so the
 * service worker can deep-link to the right session — omit it (undefined) for the primary. Kept here,
 * decoupled from `Push`/`Snooze`, so the gating and notice→message mapping are unit-testable.
 */
export function makeNotifySink(
  push: PushSender,
  mute: MuteGate,
  herdTag: string,
  sessionName?: string,
): NotifySink {
  return {
    render: (n) => {
      const held = mute.muted();
      if (held) return held;
      const msg: PushMessage = { title: n.title, body: n.body, tag: `${herdTag}:${n.paneId}`, paneId: n.paneId, renotify: n.renotify };
      if (sessionName !== undefined) msg.session = sessionName;
      void push.send(msg);
      return "sent";
    },
  };
}

/** The dialog a push carries: enough for the service worker to answer it without opening Nenu. */
export interface PushInteraction {
  signature: string;
  /** One-tap answers; empty when the dialog must be answered in the app. */
  actions: Array<{ optionIndex: number; title: string }>;
}

/** Longest body the alert shows; a detail that does not fit is never answerable from the notification. */
const ALERT_BODY_MAX = 300;

/**
 * A single-pane alert rewritten around its detected dialog: the question (and the command or file it
 * is about) becomes the body. Answer actions ride along only when the whole detail fits in the body,
 * so a permission is never approved from a notification that cut its command off.
 */
export function interactionAlert(msg: PushMessage, interaction: Interaction): PushMessage {
  const detail = interaction.kind === "permission" ? interaction.context : undefined;
  const body = detail ? `${interaction.question}\n${detail}` : interaction.question;
  const fits = body.length <= ALERT_BODY_MAX;
  return {
    ...msg,
    body: fits ? body : `${body.slice(0, ALERT_BODY_MAX - 1)}…`,
    interaction: { signature: interaction.signature, actions: fits ? pushActions(interaction) : [] },
  };
}

/** Which alerts push: `maybe` before the debounce (by status), `wants` once the alert is described. */
export interface NotifyPolicy {
  maybe(status: AgentStatus): boolean;
  wants(alert: AlertDetail): boolean;
}

/** Who an alert is about; may answer later (it reads the pane's journal). */
export type DescribeAlert = (agent: AgentView, status: NotifiableStatus) => AlertDetail | Promise<AlertDetail>;

/** Late-bound {@link DescribeAlert}: coordinators exist before the server's projects and journals do. */
export class AlertDescriber {
  private impl: ((session: string, agent: AgentView, status: NotifiableStatus) => Promise<AlertDetail>) | null = null;
  use(impl: (session: string, agent: AgentView, status: NotifiableStatus) => Promise<AlertDetail>): void {
    this.impl = impl;
  }
  for(session: string): DescribeAlert {
    return (agent, status) => this.impl?.(session, agent, status) ?? describeAlert(agent, status);
  }
}

/**
 * What the coordinator did with an alert once it knew who it was about: sent it, had it held back
 * (`snoozed`, `open`), left it to a Settings switch that is off or a turn that never pushes (`rule`),
 * or skipped it because that kind already went out and nobody has looked since (`told`).
 */
export interface NoticeDecision {
  paneId: string;
  alert: Pick<AlertDetail, "status" | "startedBy" | "requested" | "launched">;
  outcome: NoticeOutcome | "rule" | "told";
}

const OUTCOME_WORDS: Record<NoticeDecision["outcome"], string> = {
  sent: "sent",
  snoozed: "not sent, snoozed",
  open: "not sent, Nenu is open on a screen",
  rule: "not sent, no switch on in Settings pushes this turn",
  told: "not sent, it already notified and nobody has opened it since",
};

/** One journal line per decision, naming no person's words: the pane, what the turn was and what happened. */
export function decisionLine(session: string, d: NoticeDecision): string {
  const a = d.alert;
  const turn = [`started by ${a.startedBy}`, a.requested && "asked from Nenu", a.launched && "launched by an agent"].filter(Boolean).join(", ");
  return `notify ${session}/${d.paneId} ${a.status} (${turn}): ${OUTCOME_WORDS[d.outcome]}`;
}

/** An alert still in its debounce window (`handle`), or past it and being described (`handle` null). */
interface Pending<H> {
  handle: H | null;
  status: NotifiableStatus;
}

export class NotificationCoordinator<H = unknown> {
  /** paneId → alert that hasn't entered the summary yet. */
  private readonly pending = new Map<string, Pending<H>>();
  /** paneId → alert that has fired and whose notification may still be showing. */
  private readonly outstanding = new Map<string, AlertDetail>();
  /** paneId → when it last notified, and for what; survives its resolution (once until seen). */
  private readonly notified = new Map<string, { at: number; status: NotifiableStatus }>();

  constructor(
    private readonly clock: NotifyClock<H>,
    private readonly sink: NotifySink,
    private readonly delayMs: number,
    // Read live from the prefs store so a runtime change is honoured. A status no kind would push
    // behaves exactly like a non-notifiable one (idle/working).
    private readonly policy: NotifyPolicy,
    private readonly describe: DescribeAlert = describeAlert,
    /** When Nenu last showed this pane to the operator (the activity ledger); undefined when unknown. */
    private readonly seenAt: (paneId: string) => number | undefined = () => undefined,
    private readonly now: () => number = Date.now,
    private readonly decided: (decision: NoticeDecision) => void = () => {},
  ) {}

  /** Wire to `StateEngine.onTransition`. */
  onTransition(agent: AgentView, _from: AgentStatus, to: AgentStatus): void {
    const id = agent.paneId;
    if (!this.policy.maybe(to)) {
      // Resolved to a non-notifiable (or preference-disabled) state: drop a still-pending alert,
      // retract a delivered one.
      this.resolve(id);
      return;
    }
    // (Re)arm the debounce. A blocked→done flip lands here too, so only the latest verb survives.
    this.cancelPending(id);
    const status = to as NotifiableStatus;
    const entry: Pending<H> = { handle: null, status };
    entry.handle = this.clock.schedule(() => {
      entry.handle = null;
      this.admitWhenDescribed(id, entry, this.describe(agent, status), agent);
    }, this.delayMs);
    this.pending.set(id, entry);
  }

  /** Enter the summary once the alert is described, unless it resolved or re-armed meanwhile. */
  private admitWhenDescribed(id: string, entry: Pending<H>, detail: AlertDetail | Promise<AlertDetail>, agent: AgentView): void {
    const admit = (alert: AlertDetail) => {
      if (this.pending.get(id) !== entry) return;
      this.pending.delete(id);
      const outcome = !this.policy.wants(alert) ? "rule" : this.alreadyTold(id, alert.status) ? "told" : this.sink.render(notice(id, alert));
      this.decided({ paneId: id, alert, outcome });
      // Only a notice that went out counts as told: one held back reached nobody.
      if (outcome !== "sent") return;
      this.outstanding.set(id, alert);
      this.notified.set(id, { at: this.now(), status: alert.status });
    };
    if (detail instanceof Promise) detail.then(admit, () => admit(describeAlert(agent, entry.status)));
    else admit(detail);
  }

  /** Wire to `StateEngine.onRemove` — a vanished pane is implicitly resolved. */
  onRemove(paneId: string): void {
    this.resolve(paneId);
    this.notified.delete(paneId);
  }

  /**
   * Re-evaluate every pending + outstanding alert against the current prefs after they change,
   * dropping any whose kind is now disabled: cancel a still-debouncing timer, close a delivered
   * alert's notification. Call after the prefs store is updated (see the /api/notifications/prefs route).
   */
  applyPrefs(): void {
    // Drop pending alerts no kind of their status would push — nothing was shown yet. One that may
    // still push is re-checked against `wants` when it is described.
    for (const [id, p] of [...this.pending]) {
      if (!this.policy.maybe(p.status)) this.cancelPending(id);
    }
    // Forget delivered alerts of a now-disabled kind; the app closes their notifications when it opens.
    for (const [id, a] of [...this.outstanding]) {
      if (!this.policy.wants(a)) this.outstanding.delete(id);
    }
  }

  /**
   * Tear down this session's alerts: cancel every pending timer and forget every outstanding one.
   * Called when a session is disposed (its socket vanished). Nothing is pushed; the app closes stale
   * notifications when it opens.
   */
  clearAll(): void {
    for (const id of [...this.pending.keys()]) this.cancelPending(id);
    this.outstanding.clear();
  }

  private resolve(id: string): void {
    this.cancelPending(id);
    this.outstanding.delete(id);
  }

  /** The same kind of alert for this pane already went out, and nobody has looked at it in Nenu since. */
  private alreadyTold(id: string, status: NotifiableStatus): boolean {
    const last = this.notified.get(id);
    if (!last || last.status !== status) return false;
    const seen = this.seenAt(id);
    return seen === undefined || seen < last.at;
  }

  private cancelPending(id: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    if (p.handle !== null) this.clock.cancel(p.handle);
    this.pending.delete(id);
  }
}

/** What an agent's notification says: who and what in the title, its answer and where below. */
function notice(paneId: string, a: AlertDetail): AgentNotice {
  const verb = a.status === "blocked" ? "needs you" : a.startedBy === "subagent" ? "got a subagent's result" : "finished";
  return { title: `${a.name} ${verb}`, body: a.summary ? `${a.summary}\n${a.where}` : a.where, paneId, renotify: true };
}
