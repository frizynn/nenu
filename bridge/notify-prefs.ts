import { join } from "node:path";
import type { Config } from "./config.ts";
import type { AlertDetail } from "./alert-detail.ts";
import { PrefsFile } from "./prefs-file.ts";
import type { AgentStatus } from "./types.ts";

// Which agent lifecycle events are worth a push. A companion to Snooze (the do-not-disturb deadline):
// where Snooze mutes everything for a while, this decides which *kinds* of alert ever fire: an agent
// waiting on you, and a finish that answers a person. Turns the organization runs by itself and
// subagent results stay quiet (ADR 0072). Bridge-wide (not per-device), like Snooze, because a push fans out to
// every subscribed device. Persisted to the state dir so a preference survives the `systemctl restart`
// that backend changes require. Missing file / missing keys fall back to defaults.

/** Notification type preferences: which kinds of alert actually push. */
export interface NotifyPrefs {
  /** Push when any agent becomes blocked (waiting on your input). Default on. */
  blocked: boolean;
  /** Push when an agent finishes a turn a person started: a message you sent from Nenu, or one typed
   *  into a loose agent or a coordinator. Never a turn Herdr Organizations' own nudge started, nor a
   *  thread's turn its coordinator started. Default on. */
  replies: boolean;
  /** Push when an agent another agent started (`herdr agent start <name>`) finishes a turn that agent
   *  typed. Default off: the agent that launched it is the one waiting. A message you sent it from
   *  Nenu still counts as Replies to you. */
  launched: boolean;
  /** Push when a turn a subagent's or background task's result started finishes. Default off: one
   *  delegation wakes its parent once per result. */
  subagents: boolean;
  /** Push when a newer Nenu release is available. Default on — the off-switch for update alerts,
   *  which otherwise bypass snooze (an update isn't quiet-hours material). Not an agent alert, so it
   *  never flows through {@link NotifyPrefsStore.wants}; the update monitor reads it directly. */
  updates: boolean;
}

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = { blocked: true, replies: true, launched: false, subagents: false, updates: true };

export const NOTIFY_PREF_KEYS = ["blocked", "replies", "launched", "subagents", "updates"] as const;

/**
 * Coerce an untrusted parsed value into a {@link NotifyPrefs}, filling any missing or non-boolean key
 * from the defaults. Before 1.1 a finished turn had three switches (`done`, `threads`,
 * `coordinators`); a file that set any of them and predates `replies` keeps that choice as `replies`.
 * Pure + exported so the file-shape handling is unit-testable.
 */
export function coerceNotifyPrefs(raw: unknown): NotifyPrefs {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const flag = (key: string) => (typeof o[key] === "boolean" ? (o[key] as boolean) : undefined);
  const before = ["done", "threads", "coordinators"].map(flag).filter((v): v is boolean => v !== undefined);
  return {
    blocked: flag("blocked") ?? DEFAULT_NOTIFY_PREFS.blocked,
    replies: flag("replies") ?? (before.length > 0 ? before.some(Boolean) : DEFAULT_NOTIFY_PREFS.replies),
    launched: flag("launched") ?? DEFAULT_NOTIFY_PREFS.launched,
    subagents: flag("subagents") ?? DEFAULT_NOTIFY_PREFS.subagents,
    updates: flag("updates") ?? DEFAULT_NOTIFY_PREFS.updates,
  };
}

export class NotifyPrefsStore {
  private readonly file: PrefsFile<NotifyPrefs>;

  constructor(cfg: Config) {
    this.file = new PrefsFile(join(cfg.stateDir, "notify-prefs.json"), coerceNotifyPrefs);
  }

  private get prefs(): NotifyPrefs {
    return this.file.current();
  }

  load(): Promise<void> {
    return this.file.load();
  }

  /** A copy of the current prefs (never the internal object, so callers can't mutate our state). */
  current(): NotifyPrefs {
    return this.file.current();
  }

  /** Whether a transition into `status` could notify at all: the coordinator debounces only these. */
  maybe(status: AgentStatus): boolean {
    if (status === "blocked") return this.prefs.blocked;
    if (status === "done") return this.prefs.replies || this.prefs.launched || this.prefs.subagents;
    return false;
  }

  /** Whether this alert, once the bridge knows who it is and what started its turn, should push. */
  wants(alert: Pick<AlertDetail, "status" | "kind" | "startedBy" | "requested" | "launched">): boolean {
    if (alert.status === "blocked") return this.prefs.blocked;
    if (alert.startedBy === "subagent") return this.prefs.subagents;
    if (alert.requested) return this.prefs.replies;
    // Organizations' nudges are its own traffic, and a thread's typed turns come from its coordinator.
    if (alert.startedBy === "organizations" || alert.kind === "thread") return false;
    // An agent another agent started: that agent typed this turn, and it is the one waiting.
    if (alert.launched) return this.prefs.launched;
    return this.prefs.replies;
  }

  /** Merge a partial patch (only booleans are applied), persist, and return the updated prefs. */
  set(patch: Partial<NotifyPrefs>): Promise<NotifyPrefs> {
    const next = this.file.current();
    for (const key of NOTIFY_PREF_KEYS) if (typeof patch[key] === "boolean") next[key] = patch[key];
    return this.file.set(next);
  }
}
