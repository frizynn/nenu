import type { ActivityLedger } from "../activity.ts";
import type { AuditLog } from "../audit.ts";
import type { ClaudeHooks } from "../claude-hooks.ts";
import type { ClaudeTelemetry } from "../claude-telemetry.ts";
import type { CodexLive } from "../codex-live.ts";
import type { Config } from "../config.ts";
import type { ConversationService } from "../conversation-service.ts";
import type { Interactions } from "../interactions.ts";
import type { JournalWatch } from "../journal-watch.ts";
import type { TranscriptStore } from "../journal/store.ts";
import type { JournalAdapter } from "../journal/types.ts";
import type { LiveEvents } from "../live-events.ts";
import type { NotifyPrefsStore } from "../notify-prefs.ts";
import type { createOperatorCommands } from "../operator-commands.ts";
import type { createOperatorKeys } from "../operator-keys.ts";
import type { createOperatorQuickReplies } from "../operator-quick-replies.ts";
import type { OrgRun } from "../org-cli.ts";
import type { PaneWatcher } from "../pane-watcher.ts";
import type { PaneWrites } from "../pane-writes.ts";
import type { ProjectRegistry } from "../projects.ts";
import type { Push } from "../push.ts";
import type { QueueService } from "../queue-service.ts";
import type { SessionRegistry, SessionRuntime } from "../sessions.ts";
import type { Snooze } from "../snooze.ts";
import type { Subagents } from "../subagents.ts";
import type { UpdateMonitor } from "../update.ts";
import type { WebAssetArchive } from "../web-assets.ts";

/** What startServer's caller hands in: the process-wide pieces index.ts owns. */
export interface ServerDeps {
  cfg: Config;
  registry: SessionRegistry;
  push: Push;
  snooze: Snooze;
  notifyPrefs: NotifyPrefsStore;
  updateMonitor: UpdateMonitor;
  audit: AuditLog;
  activity: ActivityLedger;
  live: LiveEvents;
}

/** Everything a route handler may use, built once per server by startServer. */
export interface Services extends ServerDeps {
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
  projects: ProjectRegistry;
  orgRun: OrgRun;
  /** Does this agent have a journal at all — the snapshot's History-affordance gate. */
  hasJournal: (agent: string) => boolean;
  interactions: Interactions;
  paneWatcher: PaneWatcher;
  journalWatch: JournalWatch;
  codexLive: CodexLive;
  claudeHooks: ClaudeHooks;
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
