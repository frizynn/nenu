import { queueReadiness } from "./queue-readiness.ts";
import { PaneWrites } from "./pane-writes.ts";
import { join } from "node:path";
import { MessageQueue, type Exclusive, type QueuedMessage, type Verdict } from "./message-queue.ts";
import { deliverQueuedMessage, sendQueuedNow, type QueueWrite } from "./queue-delivery.ts";
import { DELIVERY_MODES, effectiveMode, nativeSettled, nativeState, normalizeMode, sendNowKeys, submitKind } from "./queue-native.ts";
import { computeEtag } from "./http-cache.ts";
import { object } from "./subagent-files.ts";
import type { ActionResponse, AgentView, DeliveryMode } from "./types.ts";
import type { HerdrClient } from "./herdr-client.ts";
import type { JournalFacts } from "./journal/types.ts";
import type { AuditLog } from "./audit.ts";
import type { SendHerdr } from "./guarded-send.ts";

type Context = { pane: AgentView; herdr: HerdrClient; connected: boolean };
/** A row ready to go: how to submit it, and whether the agent was mid-turn when it was assessed. */
type Ready = { context: Context; submit: "enter" | "tab"; busy: boolean };
/** The journal facts of a pane's conversation (journal/store.ts), when the bridge reads journals. */
export type FactsReader = (pane: AgentView) => Promise<JournalFacts | null>;

/**
 * What the bridge lends the queue beyond typing through the reply route. Each is optional and its
 * feature stays off without it: no `facts`, no journal state and no "Read it now"; no `audit`, no key
 * the reply route cannot press for it (Codex's Tab, Claude's send-now chord), so nothing reaches a
 * terminal unaudited.
 */
export type QueueExtras = { facts?: FactsReader | null; audit?: Pick<AuditLog, "record"> | null };

const identity = (pane: AgentView) =>
  pane.agentSession?.kind === "id"
    ? `${pane.agent}:${pane.agentSession.value}`
    : null;
const scopeFor = (session: string, pane: AgentView) =>
  computeEtag(JSON.stringify([session, pane.paneId, identity(pane)]));
// The fallback tick. Deliveries normally start from kick(): an enqueue, or a herd change that can
// make a waiting pane ready. The interval only covers a change nothing announced.
const TICK_FALLBACK_MS = 2000;
/** How long an add waits for its row's first move before answering, so an idle send answers sent. */
const ADD_SETTLE_MS = 1500;
// After a delivery, an `afterTurn` row waits until Herdr has seen the turn start. A turn that never
// visibly starts must not hold the scope for good.
const TURN_START_CAP_MS = 20_000;
const BUSY_RETRY_MS = 300;

/** A delivery's mark on its scope: the herd's state counter, or the status when Herdr has none. */
type TurnMark = { seq?: number; status: string; at: number };

export class QueueService {
  private queue: MessageQueue;
  private timer: ReturnType<typeof setInterval>;
  private turns = new Map<string, TurnMark>();
  constructor(
    stateDir: string,
    private resolve: (
      session: string,
      paneId: string,
      fresh?: boolean,
    ) => Promise<Context | null>,
    private write: (
      row: QueuedMessage,
      text: string,
      submit: boolean,
      id: string,
      paste: boolean,
    ) => Promise<ActionResponse>,
    private input = new PaneWrites(),
    changed: (row: Pick<QueuedMessage, "session" | "paneId" | "state">) => void = () => {},
    private extras: QueueExtras = {},
  ) {
    this.queue = new MessageQueue(join(stateDir, "message-queue.json"), changed);
    this.timer = setInterval(() => this.kick(false), TICK_FALLBACK_MS);
    this.timer.unref();
  }
  /**
   * Run a delivery pass now. Scopes deliver in parallel; a kick while a scope is delivering makes it
   * look once more afterwards, never twice at once. `force` (every kick but the fallback interval)
   * also looks at rows that are backing off.
   */
  kick(force = true): void {
    void this.tick(force).catch(() => {});
  }
  dispose(): void {
    clearInterval(this.timer);
  }
  private exclusive: Exclusive = async (row, operation) => {
    const result = await this.input.run(row.session, row.paneId, operation);
    // A direct reply or key owns the pane for a moment; look again shortly instead of on the interval.
    if (result.busy) setTimeout(() => this.kick(), BUSY_RETRY_MS).unref();
    return result;
  };
  private async tick(force: boolean) {
    await Promise.all([
      this.queue.tick(
        (row) => this.assess(row),
        (row, ready) => this.deliver(row, ready),
        { force, exclusive: this.exclusive },
      ),
      this.confirmFromJournal(),
    ]);
  }
  private async assess(row: QueuedMessage): Promise<Verdict<Ready>> {
    const current = await this.resolve(row.session, row.paneId, true);
    if (!current) return { stranded: "The agent's pane closed. This message will not be sent." };
    if (!current.connected) return { wait: "disconnected" };
    const live = identity(current.pane);
    if (!live) return { wait: "disconnected" };
    if (live !== row.conversation)
      return { stranded: "The conversation in this pane changed. Send it here or remove it." };
    const mode = effectiveMode(row);
    if (mode === "afterTurn" && !this.turnStarted(row.scope, current.pane)) return { wait: "turn-start" };
    const readiness = await queueReadiness(current.pane, current.herdr, mode);
    if (!readiness.ready) return { wait: readiness.reason };
    const submit = submitKind(row.agent, mode, readiness.busy);
    // Tab only goes out audited; without the trail the row waits for the turn and goes with Enter.
    if (submit === "tab" && !this.extras.audit) return { wait: "working" };
    return { ready: { context: current, submit, busy: readiness.busy } };
  }
  /** Whether the turn the scope's last delivery started has visibly begun (ADR 0056 rule 5). */
  private turnStarted(scope: string, pane: AgentView): boolean {
    const mark = this.turns.get(scope);
    if (!mark) return true;
    const moved =
      mark.seq !== undefined && pane.stateChangeSeq !== undefined
        ? pane.stateChangeSeq !== mark.seq
        : pane.status !== mark.status;
    if (moved || Date.now() - mark.at > TURN_START_CAP_MS) {
      this.turns.delete(scope);
      return true;
    }
    return false;
  }
  private async deliver(row: QueuedMessage, ready: Ready) {
    const { context } = ready;
    const write: QueueWrite = (text, submit, id, paste) => this.write(row, text, submit, id, paste);
    const outcome = await deliverQueuedMessage(row, this.audited(row, context.herdr, "queue.submit"), write, async () => {
      const next = await this.resolve(row.session, row.paneId, true);
      return !!next?.connected && identity(next.pane) === row.conversation;
    }, ready.submit);
    // Only a delivery to a free agent starts a turn. A steer or a native-queue Tab into a working one
    // does not, and marking it would hold the next row for the whole TURN_START_CAP_MS.
    if (outcome.status === "sent" && !ready.busy) {
      const { stateChangeSeq, status } = context.pane;
      this.turns.set(row.scope, { ...(stateChangeSeq !== undefined ? { seq: stateChangeSeq } : {}), status, at: Date.now() });
    }
    return outcome;
  }
  /**
   * The pane's client with every key the queue presses on its own (not through the reply route,
   * which audits itself) recorded in the audit trail, sent or not.
   */
  private audited(row: QueuedMessage, herdr: HerdrClient, action: string): SendHerdr {
    const audit = this.extras.audit;
    return {
      getPane: (id) => herdr.getPane(id),
      readPane: (...args) => herdr.readPane(...args),
      waitForOutput: (...args) => herdr.waitForOutput(...args),
      sendPaneText: (...args) => herdr.sendPaneText(...args),
      async sendPaneKeys(id, keys) {
        if (!audit) throw new Error("Keys need the audit trail.");
        let sent = false;
        try {
          await herdr.sendPaneKeys(id, keys);
          sent = true;
        } finally {
          audit.record({ action, paneId: id, session: row.session, device: row.device, detail: { keys, sent } });
        }
      },
    };
  }
  /**
   * Read what Claude's own queue did with recently delivered rows (queue-operation rows in its
   * journal): in its queue, read, or recalled into the input box. A paused row whose enqueue shows up
   * was delivered after all.
   */
  private async confirmFromJournal() {
    const read = this.extras.facts;
    if (!read) return;
    const rows = (await this.queue.unconfirmed()).filter((row) => row.agent === "claude");
    const byPane = new Map<string, QueuedMessage[]>();
    for (const row of rows) {
      const key = JSON.stringify([row.session, row.paneId, row.conversation]);
      byPane.set(key, [...(byPane.get(key) ?? []), row]);
    }
    await Promise.all(
      [...byPane.values()].map(async (group) => {
        const first = group[0]!;
        const current = await this.resolve(first.session, first.paneId).catch(() => null);
        if (!current || identity(current.pane) !== first.conversation) return;
        const facts = await read(current.pane).catch(() => null);
        if (!facts) return;
        for (const row of group) {
          const native = nativeState(facts.queue, row.text, row.claimedAt ?? row.sentAt ?? row.createdAt);
          if (native && native !== row.native && !nativeSettled(row.native)) await this.queue.confirm(row.id, native);
        }
      }),
    );
  }
  async handle(
    req: Request,
    session: string,
    paneId: string,
    device: string | null,
  ): Promise<Response> {
    const current = await this.resolve(session, paneId, true);
    const conversation = current ? identity(current.pane) : null;
    if (
      !current ||
      !conversation ||
      !["claude", "codex"].includes(current.pane.agent)
    )
      return req.method === "POST"
        ? Response.json(
            {
              error:
                "The connected conversation is unavailable. Your message was not queued.",
            },
            { status: 409 },
          )
        : Response.json({ available: false, messages: [] });
    const scope = scopeFor(session, current.pane);
    const agent = current.pane.agent;
    let added: string | null = null;
    try {
      if (req.method === "POST") {
        const body = object(await req.json());
        if (body.scope !== scope)
          return Response.json(
            { error: "The connected conversation changed. Refresh the queue." },
            { status: 409 },
          );
        const id =
          typeof body.id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(body.id)
            ? body.id
            : null;
        if (!id)
          return Response.json(
            { error: "Invalid message ID." },
            { status: 400 },
          );
        const text = typeof body.text === "string" ? body.text : "";
        if (
          ["add", "edit"].includes(String(body.action)) &&
          (!text.trim() ||
            text.length > 20_000 ||
            /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x9b]/.test(text))
        )
          return Response.json(
            {
              error:
                "Use a message between 1 and 20,000 characters without terminal controls.",
            },
            { status: 400 },
          );
        const mode = body.deliveryMode;
        if (mode !== undefined && !DELIVERY_MODES.has(mode as DeliveryMode))
          return Response.json({ error: "Invalid delivery mode." }, { status: 400 });
        if (body.action === "add") {
          await this.queue.add({
            id,
            scope,
            session,
            paneId,
            conversation,
            agent,
            text,
            device,
            deliveryMode: normalizeMode(agent, mode as DeliveryMode | undefined),
          });
          added = id;
        } else if (body.action === "now") {
          const refused = await this.sendNow(scope, id, body.confirm === true, current, device);
          if (refused) return Response.json(refused, { status: 409 });
        } else if (
          ["edit", "remove", "send"].includes(String(body.action)) &&
          typeof body.revision === "number"
        )
          await this.queue.change(
            scope,
            id,
            body.revision,
            body.action as "edit" | "remove" | "send",
            text,
            { session, paneId, conversation, agent },
          );
        else
          return Response.json(
            { error: "Invalid queue action." },
            { status: 400 },
          );
      }
      if (req.method === "POST") this.kick();
      // An add answers once its row came to rest (sent, paused, waiting with a reason) or after
      // ADD_SETTLE_MS, so a send to a free agent comes back delivered rather than queued.
      if (added)
        await this.queue.until(added, (row) => (row.state !== "queued" && row.state !== "sending") || !!row.waitingFor || !!row.stranded, ADD_SETTLE_MS);
      const rows = await this.queue.list(scope, { session, paneId });
      const delivered = await this.queue.recent(scope);
      return Response.json({
        available: true,
        scope,
        messages: rows.map(
          ({ id, text, state, createdAt, revision, error, deliveryMode, waitingFor, stranded, device }) => ({
            id,
            text,
            state,
            createdAt,
            revision,
            error: error ?? stranded?.reason,
            deliveryMode,
            waitingFor,
            stranded,
            device,
          }),
        ),
        // Delivered in the last minutes, with what the CLI's own queue did with each.
        delivered: delivered.map(({ id, text, sentAt, deliveryMode, native }) => ({ id, text, sentAt, deliveryMode, native })),
      });
    } catch {
      return Response.json(
        { error: "Queue could not be updated. Refresh before retrying." },
        { status: 409 },
      );
    }
  }
  /**
   * "Read it now": Claude's send-now chord for a row its native queue still holds. It can background
   * the running tool, so the operator confirms it first. Null when it went out, else the refusal.
   */
  private async sendNow(scope: string, id: string, confirmed: boolean, current: Context, device: string | null) {
    const keys = sendNowKeys(current.pane.agent);
    const row = (await this.queue.recent(scope)).find((item) => item.id === id);
    if (!keys || !row || row.native !== "enqueued" || !this.extras.audit)
      return { error: "Only a message waiting in Claude's own queue can be read now.", code: "unsupported" };
    if (!confirmed)
      return {
        error: "Claude reads it now and moves a running command to the background. Confirm to continue.",
        code: "confirm_required",
      };
    const result = await this.input.run(row.session, row.paneId, () => sendQueuedNow(row.paneId, row.agent, keys, this.audited({ ...row, device }, current.herdr, "queue.now")));
    if (result.busy) return { error: "Another terminal action is finishing. Try again.", code: "busy" };
    return result.value.ok ? null : { error: result.value.error, code: "not_ready" };
  }
}
