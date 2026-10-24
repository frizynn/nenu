import type { AgentStates } from "../agent-state.ts";
import type { ActivityLedger } from "../activity.ts";
import type { AuditLog } from "../audit.ts";
import type { ClaudeHooks } from "../claude-hooks.ts";
import type { ClaudeTelemetry } from "../claude-telemetry.ts";
import type { Config } from "../config.ts";
import type { FileGrants } from "../file-open.ts";
import type { ConversationService } from "../conversation-service.ts";
import type { Interactions } from "../interactions.ts";
import type { JournalWatch } from "../journal-watch.ts";
import type { TranscriptStore } from "../journal/store.ts";
import type { JournalAdapter } from "../journal/types.ts";
import type { LiveEvents } from "../live-events.ts";
import type { MachineDirectory } from "../machines.ts";
import type { NotifyPrefsStore } from "../notify-prefs.ts";
import type { AlertDescriber } from "../notifications.ts";
import type { AwaitingReplies } from "../awaiting-replies.ts";
import type { createOperatorCommands } from "../operator-commands.ts";
import type { createOperatorKeys } from "../operator-keys.ts";
import type { createOperatorQuickReplies } from "../operator-quick-replies.ts";
import type { PaneWatcher } from "../pane-watcher.ts";
import type { PaneWrites } from "../pane-writes.ts";
import type { PullRequestRegistry } from "../pull-requests.ts";
import type { Push } from "../push.ts";
import type { QueueService } from "../queue-service.ts";
import type { SessionRegistry, SessionRuntime } from "../sessions.ts";
import type { Snooze } from "../snooze.ts";
import type { Subagents } from "../subagents.ts";
import type { UpdateMonitor } from "../update.ts";
import type { UsageService } from "../usage/runtime.ts";
import type { WebAssetArchive } from "../web-assets.ts";

/** What startServer's caller hands in: the process-wide pieces index.ts owns. */
export interface ServerDeps {
  cfg: Config;
  registry: SessionRegistry;
  push: Push;
  snooze: Snooze;
  notifyPrefs: NotifyPrefsStore;
  /** Names each push alert from the pane and its journal (filled by startServer). */
  alerts: AlertDescriber;
  updateMonitor: UpdateMonitor;
  audit: AuditLog;
  activity: ActivityLedger;
  live: LiveEvents;
  /** Herdr's saved machines (machines.ts). Absent in-process: no machines. */
  machines?: MachineDirectory;
  /** Settings → Usage (usage/runtime.ts). Absent in-process: off. */
  usage?: UsageService;
}

/** Everything a route handler may use, built once per server by startServer. */
export interface Services extends ServerDeps {
  /** What Nenu sent an agent and has not heard back about (notifications). */
  awaiting: AwaitingReplies;
  assets: WebAssetArchive;
  operatorCommands: ReturnType<typeof createOperatorCommands>;
  operatorKeys: ReturnType<typeof createOperatorKeys>;
  operatorQuickReplies: ReturnType<typeof createOperatorQuickReplies>;
  journals: Record<string, JournalAdapter> | null;
  transcripts: TranscriptStore | null;
  claudeTelemetry: ClaudeTelemetry;
  subagents: Subagents;
  conversations: ConversationService;
  input: PaneWrites;
  queue: QueueService;
  /** The person's open PRs in the repos agents work in, read with `gh` in the background. */
  pullRequests: PullRequestRegistry;
  /** Does this agent have a journal at all — the snapshot's History-affordance gate. */
  hasJournal: (agent: string) => boolean;
  interactions: Interactions;
  paneWatcher: PaneWatcher;
  journalWatch: JournalWatch;
  claudeHooks: ClaudeHooks;
  /** Each Claude and Codex pane's turn from the CLI's own files (ADR 0067). */
  agentStates: AgentStates;
  /** Single-use links to files the operator confirmed opening outside the preview (ADR 0063). */
  fileGrants: FileGrants;
  machines: MachineDirectory;
  usage: UsageService;
}

export type AccessLevel = "read" | "write";

/** The one server control a handler uses: lifting the idle timeout for a long-lived stream. */
export interface RequestTimeouts {
  timeout(req: Request, seconds: number): void;
}

/** One request as a handler sees it. `match` is the path regex's match (null for a string path). */
export interface RouteRequest {
  req: Request;
  url: URL;
  match: RegExpMatchArray | null;
  server: RequestTimeouts;
  /** The TCP peer address Bun.serve reported; undefined when the transport has none (in-process tests). */
  peer?: string;
}

export interface SessionRouteRequest extends RouteRequest {
  rt: SessionRuntime;
}

interface RouteBase {
  /** `"*"` answers every method — kept where the original routes did not check one. */
  method: "GET" | "POST" | "*";
  path: string | RegExp;
  /**
   * The gate applied before anything else runs (routes/access.ts guard). `"none"` is for the few
   * answers that sit outside every gate on purpose (a 405, the /auth placeholder).
   */
  access: AccessLevel | "none" | ((req: Request, match: RegExpMatchArray | null) => AccessLevel);
  /**
   * Whether `?session=@<machine>` sends the request to that machine's Nenu (machines.ts). Defaults
   * to `session`: what a session answers, a machine answers.
   */
  machine?: boolean;
}

/**
 * One API route. Order in the table is significant: the first route whose method and path match
 * handles the request. A `session` route resolves `?session=` after the gate and 404s an unknown name.
 */
export type Route =
  | (RouteBase & { session: true; handle(ctx: Services, r: SessionRouteRequest): Promise<Response> | Response })
  | (RouteBase & { session: false; handle(ctx: Services, r: RouteRequest): Promise<Response> | Response });

/** A request to `/api/pane/:id/<action>`, after the pane dispatcher's gate and seen-marking. */
export interface PaneRouteRequest extends SessionRouteRequest {
  paneId: string;
  /** The authorised device for a write; null on reads (nothing is written to attribute). */
  device: string | null;
}

/**
 * One `/api/pane/:id/<action>`. `level` decides the gate AND the method that routes: a read answers
 * GET, a write answers POST, anything else is a 405 after the gate.
 */
export interface PaneAction {
  level: AccessLevel | ((method: string) => AccessLevel);
  /**
   * Whether a routed request marks the pane seen even without the seen header — see marksPaneSeen
   * in routes/pane.ts for why most reads must not.
   */
  marksSeen: boolean;
  handle(ctx: Services, r: PaneRouteRequest): Promise<Response> | Response;
}
