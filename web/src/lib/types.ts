// Frontend mirror of the bridge's domain model (bridge/types.ts). Kept as a small, deliberate
// duplicate so the web app builds independently of the Bun server's source tree.

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface AgentView {
  paneId: string;
  workspaceId: string;
  workspaceLabel: string;
  workspaceNumber: number;
  tabId: string;
  agent: string;
  status: AgentStatus;
  cwd: string;
  focused: boolean;
  /** "agent" for an agent-bearing pane, "shell" for a bare shell. Absent = "agent". */
  kind?: "agent" | "shell";
  /** User-set pane label (herdr `pane.rename`), when one is set; absent when the pane is unlabelled. */
  paneLabel?: string;
  /**
   * Claude's OWN session name (set in-agent via `/rename`), derived bridge-side from the pane text.
   * Claude-only; absent for unnamed sessions and non-claude panes. Shown below an explicit `paneLabel`
   * — see {@link paneDisplayName}. Render as text only (never markup) — same XSS boundary as paneLabel.
   */
  sessionName?: string;
  /**
   * True when the agent named a session, so a journal may exist for this pane — what the History
   * affordance keys off, without a speculative fetch.
   *
   * A FLAG, not the session itself: the bridge keeps the reference server-side and re-derives it from
   * the pane id on every history request, because for some harnesses (pi) that reference is an
   * absolute filesystem path. It never accepts one from the client. "May exist" is the honest
   * reading — an agent can name a session whose log isn't readable, which the history endpoint
   * answers with `available:false, reason:"no-log"`.
   */
  hasSession?: boolean;
  /**
   * Upper bound on the lines a pane read can return (Herdr's scrollback depth + viewport). The only
   * reliable "is there more scrollback" signal — `PaneReadResponse.truncated` is always false even
   * when history was cut off, which is why "Load older" never used to render. A Claude pane reports
   * just its viewport, because the alternate screen it runs on keeps no scrollback. Absent on older
   * bridges/Herdr, which reads as "unknown" (the button then falls back to hidden).
   */
  readableLines?: number;
  /**
   * The pane's tab label, denormalised bridge-side alongside `workspaceLabel`. Absent when it says
   * nothing: Herdr names an unlabelled tab positionally ("1"), which in a single-tab space would
   * render as `project · 1` (see `meaningfulTabLabel` in bridge/activity.ts). Render as text only,
   * never markup — same XSS boundary as `paneLabel`.
   */
  tabLabel?: string;
  /**
   * What the pane's process says it is doing — its OSC title, glyph-stripped and dropped when
   * uninformative bridge-side (see `meaningfulTerminalTitle` in bridge/activity.ts). Unlike
   * `paneLabel` and `sessionName`, which are set once by hand, this follows the work as it moves.
   * Render as text only, never markup — same XSS boundary as `paneLabel`.
   */
  terminalTitle?: string;
  /**
   * Epoch ms of this agent's last status transition, as the bridge observed it. Absent on an older
   * bridge — which is exactly why triage degrades cleanly; see `triage()`.
   */
  lastActiveAt?: number;
  /**
   * Epoch ms you last opened or drove this pane through Nenu. Absent as above.
   *
   * There is no "seen" flag anywhere: a `done` agent is unseen precisely when
   * `lastActiveAt > lastSeenAt`, so opening the pane clears it by construction.
   */
  lastSeenAt?: number;
  /** Herdr pane tokens the bridge allows through (short key/value tags). Absent on older Herdr. */
  tokens?: Record<string, string>;
  /** Bumps on every status transition; equal values mean nothing changed between two reads. */
  stateChangeSeq?: number;
  /** Bumps when an idle transition completed work. Absent when Herdr doesn't report it. */
  completionSeq?: number;
  /** The turn as the CLI's own files record it (bridge/agent-state.ts, ADR 0067); absent when unknown. */
  turn?: TurnState;
}

/** Mirror of the bridge's TurnState: Claude's session file or Codex's rollout. */
export interface TurnState {
  /** A turn the CLI's interrupt key reaches; Stop's button and Stop's press both read it. */
  running: boolean;
  /** Claude: a dialog owns the keyboard ("permission prompt", "input needed", …). */
  waiting?: string;
  /** Work goes on with no turn to interrupt: background agents, a workflow or a shell. */
  background?: boolean;
  queued?: "sends" | null;
  source: "claude-session" | "codex-rollout";
}

/**
 * The name to show for a pane, in priority order: an explicit user label (herdr `pane.rename`) wins,
 * then Claude's own `/rename` session name, then the pane's terminal title, then the agent name (or
 * "shell"). The two hand-set names outrank the title because a name you chose should not be
 * overwritten by one the process is rewriting every turn; the title outranks the agent name because
 * "claude" tells you nothing when four rows say it. All three are rendered only as React text nodes
 * by callers — never markup — so they stay within the pane-output XSS boundary.
 */
export function paneDisplayName(pane: AgentView): string {
  if (pane.paneLabel) return pane.paneLabel;
  if (pane.sessionName) return pane.sessionName;
  if (pane.terminalTitle) return pane.terminalTitle;
  return pane.kind === "shell" ? "shell" : pane.agent;
}

/** A Herdr workspace ("space") — a project-scoped container of tabs. */
export interface WorkspaceView {
  workspaceId: string;
  number: number;
  label: string;
  focused: boolean;
  activeTabId: string;
  tabCount: number;
  paneCount: number;
}

/** A tab within a workspace (holds one or more panes). */
export interface TabView {
  tabId: string;
  workspaceId: string;
  number: number;
  label: string;
  focused: boolean;
  paneCount: number;
}

export type BridgeStatus = "connected" | "disconnected";

/**
 * Per-device authorisation for this client (mirrors DeviceAuth in bridge/types.ts). Present in the
 * snapshot only when the feature is enabled on the bridge; absent = not enforced.
 */
export interface DeviceAuth {
  /** Whether per-device authorisation is enforced at all. */
  enforced: boolean;
  /** The opaque device identifier from the trusted header, or null if absent / feature off. */
  device: string | null;
  /** Whether this device may perform sensitive (terminal-driving / structural) actions. */
  authorized: boolean;
}

/**
 * True when device auth is enforced and this device is NOT authorised — i.e. the UI should drop to
 * read-only. False when the feature is off, the device is allowlisted, or the state isn't known yet.
 */
export function isReadOnly(device: DeviceAuth | undefined): boolean {
  return !!device && device.enforced && !device.authorized;
}

/** Whether this device may start something now: allowed to write, on a live, connected snapshot. */
export function canCreate(snapshot: { device: DeviceAuth | undefined; error: boolean; bridge: BridgeStatus | undefined }): boolean {
  return !isReadOnly(snapshot.device) && !snapshot.error && snapshot.bridge === "connected";
}

/**
 * One entry in the snapshot's session registry — a named Herdr session the bridge is fanning out.
 * Order is primary-first, then alphabetical. An unreachable session (crashed / stale socket) reports
 * `reachable: false` with zeroed counts and renders greyed-out, non-clickable in the switcher.
 */
export interface SessionSummary {
  /** Registry name, e.g. "default", "collie-demo". */
  name: string;
  /** The `cfg.socketPath` session — all no-`?s=` requests map to it. */
  isPrimary: boolean;
  /** Whether the last poll of this session's socket succeeded. */
  reachable: boolean;
  /** Agent-pane count (0 when unreachable). */
  agents: number;
  working: number;
  blocked: number;
}

export interface ProjectThreadView {
  id: string;
  title: string;
  parentId: string;
  role: "worker" | "coordinator";
  status: "starting" | "open" | "failed" | "resolved";
  template?: string;
  updated?: string;
  paneId?: string;
  agent?: string;
  liveStatus?: AgentStatus;
  /** Organizations' `last_group` for the thread (e.g. "ready"); absent when unset. */
  group?: string;
  /** The agent itself reported it is waiting for you (its `Waiting for you` activity); absent otherwise. */
  selfWaiting?: true;
  branch?: string;
  /** The thread's pull request. Numbers appear only when Organizations reported them. */
  pr?: ThreadPullRequest;
  /** 1 for a direct child of the project, computed from `parentId`. */
  depth?: number;
  /** A report the person has not acknowledged yet. */
  reportUnacked?: boolean;
  groupLabel?: string;
  /** Organizations' bracketed note: live agent state, `pane closed`, `failed: …`. `--json` only. */
  note?: string;
  /** The PR automation flags. Present only when Organizations has PR actions. */
  autoFixCi?: boolean;
  autoMerge?: boolean;
  /** The first action Organizations names for its PR, or `create-pr` without one. Absent from an Organizations that names none. */
  prAction?: PrAction;
  /** Organizations has another parent for it (`node move`): its `actions` lists `move`. Absent otherwise. */
  movable?: true;
  /** The `Status:` line of the agent's last report; absent without one. */
  verdict?: ThreadVerdict;
  /** When a coordinator's STATUS.md last changed; its text comes with the summaries. */
  statusUpdated?: string;
  /** Changes when Organizations' reading of its tokens does; the numbers come with the summaries. */
  usageStamp?: string;
}

/** Mirror ThreadVerdict, ThreadCapture, ThreadDeliverable, PlainSummary, ThreadSummary and StatusFile in bridge/types.ts. */
export type ThreadVerdict = "done" | "needs-decision" | "blocked" | "failed";
export interface ThreadCapture { path: string; caption: string }
export interface ThreadDeliverable { path: string; kind: "html" | "pdf" }
/** What a thread's report says and shows (`/api/org/summary`). The summary is the agent's text: draw it as text. */
/** A summary agent's answer: its text, or why it failed; `current` is false once the report changed. */
export interface PlainSummary { text: string; current: boolean; error?: string }
export interface ThreadSummary {
  id: string;
  summary?: string;
  /** The report in plain words from Organizations' summary agent: model-written, drawn as text. */
  plain?: PlainSummary;
  /** Organizations would write one on request. */
  explainable?: true;
  captures: ThreadCapture[];
  deliverables: ThreadDeliverable[];
  status?: StatusFile;
  usage?: TokenUsage;
}
/** A thread's report (`/api/org/report`), mirroring bridge/org-library.ts: its Markdown as the agent wrote it, drawn as text. */
export interface ThreadReport {
  title: string;
  verdict?: ThreadVerdict;
  text: string;
  captures: ThreadCapture[];
  deliverables: ThreadDeliverable[];
}
/**
 * A coordinator's STATUS.md: the agent's Markdown, drawn as text. `updated` is RFC 3339 or empty.
 * The objective and decisions are what Organizations read out of it, absent from one that predates them.
 */
export interface StatusFile { text: string; updated: string; objective?: string; needsDecision?: string[] }

/** Mirror AskState, AskConfirmed, AskLink, Ask, AskGroup, AskCoordinator, AskRow, AskDecision, AsksList and TokenUsage in bridge/org-types.ts. */
export type AskState = "open" | "working" | "needs-decision" | "answered" | "done" | "unknown";
export type AskConfirmed = "in-progress" | "stopped" | "failed" | "done" | "";
export interface AskLink { kind: "thread" | "pr" | "task" | "page"; text: string; target: string; thread: string; title: string; state: string; pr: string; prState: string }
/** One line under a coordinator's `## Asked`. Its text and answer are the operator's and the coordinator's words: draw them as text. */
export interface OrgAsk {
  line: number; state: AskState; text: string; answer: string; links: AskLink[]; confirmed: AskConfirmed; mismatch: string;
  /** RFC 3339, once the person answered this line, until the coordinator changes it. */
  answeredAt?: string;
  /** Organizations takes an answer on this row. */
  answerable?: true;
}
export type AskGroup = "waiting" | "unclosed" | "progress" | "done" | "other";
export interface AskCoordinator { id: string; title: string }
export interface AskRow extends OrgAsk { project: string; coordinator: AskCoordinator; group: AskGroup }
/**
 * A decision line: `line` 0 and no links when Organizations gave only its text; waiting until answered,
 * in progress after. `line`, `links` and `group` are absent from a bridge that predates decision rows,
 * which a rebuilt page can meet until the bridge restarts: it then reads as text that waits on you.
 */
export interface AskDecision {
  project: string; coordinator: AskCoordinator; text: string; line?: number; links?: AskLink[];
  group?: "waiting" | "progress"; answeredAt?: string; answerable?: true;
}
/** `asks` is null when this Organizations cannot list asks. */
/** `answers` is whether this Organizations can answer an ask (`asks answer`); absent from an older bridge. */
export interface AsksList { asks: AskRow[] | null; decisions: AskDecision[]; answers?: boolean }
export interface TokenUsage {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  context: number; peakContext: number; compactions: number; updated: string; overCap: string[];
}
/** The project coordinator as the ticker last saw it (`/api/org/summary`); `state` is empty before it looked. Mirrors OrgCoordinator in bridge/org-cli.ts. */
export interface CoordinatorAgent { agent: string; model: string; state: "working" | "blocked" | "idle" | "done" | "" }

/** Mirror PrAsk and PrAction in bridge/types.ts. */
export type PrAsk = "resolve-conflicts" | "fix-ci" | "address-comments";
export type PrAction = PrAsk | "merge" | "create-pr";

/** Mirrors ThreadPullRequest in bridge/types.ts. */
export interface ThreadPullRequest {
  url?: string;
  number?: number;
  state: "open" | "draft" | "merged" | "closed";
  review?: "approved" | "changes_requested" | "review_required" | "commented";
  checks?: { passed: number; failed: number; pending: number; failing?: string[] };
  diff?: { additions: number; deletions: number };
  /** Why `thread merge` would refuse, as of the ticker's last read; `null` when it would merge. `--json` only. */
  mergeBlocker?: string | null;
  commentCount?: number;
  mergeable?: string;
}

/** One hunk of a file's diff; each line keeps its marker (" ", "+", "-" or "\\"). Mirrors bridge/pane-diff.ts. */
export interface DiffHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: string[];
}

/** A changed file; without `hunks`, `omitted` says why its lines are not here. Mirrors bridge/pane-diff.ts. */
export interface DiffFile {
  path: string;
  from?: string;
  status: "added" | "deleted" | "renamed" | "modified";
  additions: number;
  deletions: number;
  binary?: true;
  hunks?: DiffHunk[];
  /** `untracked`: a new file git does not track yet, named without lines. `private`: a credential file, never shown. */
  omitted?: "binary" | "large" | "budget" | "untracked" | "private";
}

/** What a session's Changes compares: its branch against where it started, or what is not committed. */
export type DiffScope = "branch" | "uncommitted";

/** What a pull request or a session changes, read from a pane's folder (`/api/pane/:id/diff`). Mirrors bridge/pane-diff.ts. */
export type PaneDiff =
  | {
    ok: true;
    /** Absent for a session's scope. */
    pr?: number;
    base: string;
    head: string;
    source: "worktree" | "branch" | "uncommitted";
    files: DiffFile[];
    totals: { files: number; additions: number; deletions: number };
    truncated?: { files?: true; bytes?: true };
  }
  | { ok: false; reason: "no-folder" | "no-pr" | "no-base" | "head-missing" | "failed" | "no-repo" | "no-default"; message: string };

/**
 * An open pull request of the person's, read with `gh` in a repo an agent works in
 * (bridge/pull-requests.ts). `paneIds` are the panes whose folder is on its branch. Mirrors
 * PullRequestView in bridge/types.ts.
 */
export interface PullRequestView {
  /** `owner/name`, from the PR's own URL. */
  repo: string;
  number: number;
  title: string;
  url: string;
  /** The head branch. */
  branch: string;
  base?: string;
  draft: boolean;
  review?: "approved" | "changes_requested" | "review_required";
  checks?: { passed: number; failed: number; pending: number };
  diff?: { additions: number; deletions: number };
  /** Epoch ms. */
  updatedAt?: number;
  paneIds: string[];
}

export interface ProjectView {
  slug: string;
  name: string;
  goal?: string;
  status: "active" | "paused";
  /** The glyph and colour names the project picked in Organizations; absent when it picked none. */
  icon?: string;
  tone?: string;
  coordinator?: { paneId: string; agent: string; liveStatus: AgentStatus };
  threads: ProjectThreadView[];
  /** `json` when this came from `overview --json`; `files` is the fallback, which carries no numbers. */
  source?: "json" | "files";
  /** Organizations can merge and toggle auto-fix/auto-merge (its `thread merge`/`thread set`). */
  prActions?: boolean;
  /** Organizations can start coordinators and nest nodes; false when only upstream herdr-projects is installed. */
  nodeActions?: boolean;
  /** Organizations can hang a node under another parent (`node move`); absent or false hides Move. */
  nodeMoves?: boolean;
  /** Workspaces holding a live pane bound to this project, in this session. */
  workspaceIds?: string[];
  /** When the project coordinator's STATUS.md last changed; its text comes with the summaries. */
  statusUpdated?: string;
  /** How many of its coordinators' asks and decisions wait on you; absent when this Organizations cannot list asks. */
  waitingAsks?: number;
  /** The project coordinator's token reading stamp, as a thread's `usageStamp`. */
  usageStamp?: string;
}

export type NodeRole = "worker" | "coordinator";

/** A TASKS.md task from Organizations' `task list --json`. Mirrors OrgTask in bridge/org-cli.ts. */
export interface OrgTask {
  list: string;
  title: string;
  owner: { kind: "unassigned" | "me" | "agent" | "person"; profile: string; machine: string; name: string };
  thread: string;
  description: string;
}

/** What every thread of a project receives (`project show --json`). Mirrors bridge/org-cli.ts. */
export interface OrgProjectDetail {
  instructions: string;
  memory: string;
  memoryFiles: Array<{ name: string; text: string }>;
  repos: Array<{ path: string; machine: string }>;
  coordinatorProfile: string;
  threadProfile: string;
  maxParallelThreads: number;
}

/** A project routine (`routine list --json`). Mirrors bridge/org-cli.ts. */
export interface OrgRoutine {
  name: string;
  trigger: "schedule" | "pr";
  schedule: string;
  events: string[];
  enabled: boolean;
  nextRun: string;
}

export interface TemplateView {
  name: string;
  scope: "global" | "project";
  description: string;
  role: NodeRole;
  canSpawn: boolean;
  harness: string;
  model: string;
  reasoningEffort: string;
  rulesChars: number;
  memoryChars: number;
  updated: string;
}

/** A project's routine, as `/api/org/routines` reads it from `routine list --json` (mirrors bridge/types.ts). */
export interface RoutineView {
  name: string;
  trigger: "schedule" | "pr";
  /** As written, such as `daily 09:00`; empty for a `pr` routine. */
  schedule: string;
  /** The pull request events a `pr` routine fires on; empty for a scheduled one. */
  events: string[];
  enabled: boolean;
  /** RFC 3339, or empty: before the first run, and always for `pr`. */
  lastRun: string;
  /** RFC 3339, or empty for `pr` and for a disabled routine. */
  nextRun: string;
}

/** `available` is false when the host's Organizations has no `routine list --json`, so the list says nothing. */
export interface RoutineList {
  available: boolean;
  routines: RoutineView[];
  /** Routine files that do not parse. */
  broken: number;
}

/**
 * Version / upgrade status for the running Nenu (mirrors UpdateInfo in bridge/types.ts). Optional
 * on the snapshot — an older bridge omits it entirely, which the client treats as "no info" (the
 * update banner renders nothing). `latest` is null when the newest upstream release isn't known.
 */
export interface UpdateInfo {
  /** Local installations do not follow releases from the original project's repository. */
  releaseChannel?: "local" | "github";
  releaseRepo?: string;
  /** The version this bridge is running, e.g. "0.11.0". */
  current: string;
  /** Newest upstream release, e.g. "0.12.0", or null when unknown. */
  latest: string | null;
  /** GitHub release page for `latest` (the banner links to it), or null when `latest` is unknown. */
  latestUrl: string | null;
  /** A newer release than `current` exists upstream — the update action will fetch it. */
  releaseAvailable: boolean;
  /** Newest release of a HIGHER major than `current`, or null. A routine update never crosses it —
   *  `update --major` is the consent (ADR 0020), so the banner names that command. */
  majorAvailable: string | null;
  /** GitHub release page for `majorAvailable`, or null when there is none. */
  majorUrl: string | null;
  /** The running bridge PROCESS is behind the on-disk code — a `systemctl restart` picks it up. */
  bridgeStale: boolean;
  /** When the upstream check last ran (epoch ms), or null if it hasn't. */
  checkedAt: number | null;
}

export interface SnapshotResponse {
  bridge: BridgeStatus;
  /** Per-device authorisation for the requesting client; absent when the feature is off. */
  device?: DeviceAuth;
  agents: AgentView[];
  shellPanes: AgentView[];
  workspaces: WorkspaceView[];
  tabs: TabView[];
  projects?: ProjectView[];
  /** Open pull requests from GitHub in the repos agents work in. Absent on older bridges. */
  pullRequests?: PullRequestView[];
  /** Notification quiet-hours: the active snooze deadline (epoch ms) or null. Absent on older bridges. */
  notifications?: { snoozedUntil: number | null };
  /** The bridge's session registry (primary-first). Absent on a single-session / older bridge. */
  sessions?: SessionSummary[];
  /** Version / upgrade status. Absent on an older bridge that doesn't report it. */
  update?: UpdateInfo;
  /** Herdr's saved machines, this one first (bridge/types.ts MachineView); absent with only one. */
  machines?: MachineView[];
  ts: number;
}

/** Mirrors MachineState in bridge/types.ts. */
export type MachineState = "connected" | "connecting" | "offline" | "old-nenu" | "no-nenu" | "disabled" | "off";

/** Mirrors MachineHerd in bridge/types.ts. */
export interface MachineHerd {
  bridge: BridgeStatus;
  agents: AgentView[];
  shellPanes: AgentView[];
  workspaces: WorkspaceView[];
  tabs: TabView[];
}

/** Mirrors MachineView in bridge/types.ts: `session` is absent for the bridge's own machine. */
export interface MachineView {
  session?: string;
  label: string;
  state: MachineState;
  detail?: string;
  herd?: MachineHerd;
}

export interface PaneReadResponse {
  nativeTelemetry?: { sessionKey: string; telemetry: SessionTelemetry };
  paneId: string;
  text: string;
  truncated: boolean;
  /** Herdr's monotonic pane revision — the prompt-select race guard checks a tapped menu against it. */
  revision: number;
  /** A shell pane only: true while the shell waits at its prompt, false while a command holds the
   *  terminal. Absent when unknown. */
  atPrompt?: boolean;
  /** Set to true by the client when the server returns 304 Not Modified. Never sent over the wire. */
  notModified?: boolean;
}

/**
 * One renderable piece of a transcript turn. Mirrors `bridge/transcript.ts` (wire types are
 * hand-mirrored across the two sides, as with every other response here).
 */
export type TranscriptPart =
  | { kind: "text"; text: string; truncated?: boolean }
  | { kind: "thinking"; text: string; truncated?: boolean }
  /** Injected text drawn as one quiet line; `text` shows only when expanded. Mirrors bridge/journal/types.ts. */
  | { kind: "context"; label: string; text: string; truncated?: boolean }
  | {
      kind: "tool";
      name: string;
      summary: string;
      /** What the call says it does, in the agent's words. Mirrors bridge/journal/types.ts. */
      description?: string;
      /** Lines an edit adds and removes, from its input. */
      diff?: { added: number; removed: number };
      /** `descriptions` runs beside `options` ("" for none), only when any option has one. */
      questions?: Array<{ title: string; options: string[]; descriptions?: string[] }>;
      result?: { text: string; truncated?: boolean; isError?: boolean; attachments?: ToolAttachment[] };
    }
  | TranscriptImagePart;

/** A file a tool call produced or showed, as a reference. Mirrors bridge/types.ts. */
export type ToolAttachment =
  | { kind: "image"; index: number; mediaType?: string }
  | { kind: "file"; path: string };

/**
 * An image the journal holds inline, as a marker only: the bytes come from the journal-image endpoint
 * by entry and index (`journalImageUrl`), never inlined into /history.
 */
export interface TranscriptImagePart {
  kind: "image";
  index: number;
  mediaType?: string;
}

/**
 * One turn. `user`/`assistant` are speech; the other two are not, and render set apart so they can't
 * be mistaken for it — `summary` is Claude's own compaction summary, `note` is machine-injected
 * content that still belongs on screen (a background task finishing, a local command's output).
 */
export interface TranscriptEntry {
  uuid: string;
  ts: string;
  role: "user" | "assistant" | "summary" | "note";
  parts: TranscriptPart[];
  turnId?: string;
  phase?: "commentary" | "final_answer";
  turn?: TranscriptTurn;
}

export interface TranscriptTurn {
  status: "running" | "completed" | "aborted";
  startedAt?: string;
  completedAt?: string;
  /** Native reported work duration, not a timestamp estimate. */
  durationMs?: number;
}

/**
 * GET /api/pane/:id/history — real conversation history, read from the agent's own session log.
 *
 * This is NOT terminal scrollback and can't be: a Claude pane runs on the terminal's alternate
 * screen, which keeps no scrollback ring, so Herdr only ever holds the visible viewport. `available:
 * false` is an ordinary answer (a shell pane, a harness with no session log, or the feature off) —
 * the UI hides the History affordance rather than showing an error.
 */
/** Last reported provider metrics. Missing values are unknown, never inferred model limits. */
export interface SessionTelemetry {
  source: "journal" | "statusline";
  observedAt?: string;
  model?: string;
  effort?: string;
  tokens?: {
    input?: number;
    output?: number;
    cachedInput?: number;
    total?: number;
    scope: "session" | "last-message";
  };
  context?: { usedTokens?: number; windowTokens?: number; usedPercent?: number };
  rateLimits?: Array<{
    name: "primary" | "secondary";
    usedPercent: number;
    windowMinutes?: number;
    /** Epoch seconds, as reported by the provider. */
    resetsAt?: number;
  }>;
  /** The parsed log was tail-capped; metadata from its missing head may be unavailable. */
  fileTruncated: boolean;
}

export type PaneHistoryResponse =
  | {
      paneId: string;
      available: false;
      reason: "disabled" | "no-session" | "no-log";
      /** A Codex that has had no turn yet: there is no conversation to link, only a first message to send. */
      notStarted?: true;
    }
  | {
      paneId: string;
      available: true;
      /** Oldest-first, ready to render top-down. */
      entries: TranscriptEntry[];
      /** Older turns exist before `entries[0]` — page with `?before=<its uuid>`. */
      hasMore: boolean;
      total: number;
      fileTruncated: boolean;
      telemetry?: SessionTelemetry;
      sessionKey?: string;
    };

export type ActionResponse =
  | { ok: true; requestId?: string; ack?: "typed" | "submitted"; replayed?: boolean }
  | {
      ok: false;
      error: string;
      textDelivered?: boolean;
      code?: "prompt_changed";
      requestId?: string;
    };

/**
 * POST /api/pane/:id/interrupt — Stop (ADR 0066). `pressed: false` is a Stop inside another one's
 * cooldown: nothing was sent, the first Escape is doing the work. `queued` says what the key did to the
 * CLI's own queue; `held` counts the rows Nenu parked until the operator sends them.
 */
export type InterruptResponse =
  | { ok: true; pressed: boolean; queued: "sends" | "returns" | null; held: number; confirmed?: boolean }
  | { ok: false; error: string; code: "confirm_required" | "not_running" | "busy" | "unsupported" | "failed" };

export type UploadResponse = { ok: true; path: string } | { ok: false; error: string };

/** A freshly-created shell pane — enough to navigate into before the next poll lands. */
export interface CreatedPane {
  paneId: string;
  workspaceId: string;
  workspaceLabel: string;
  tabId: string;
  cwd: string;
}

/** Result of creating a new tab/space — on success `pane` is the fresh shell to navigate into. */
export type CreateResponse = { ok: true; pane: CreatedPane } | { ok: false; error: string };

/**
 * One operator-declared palette row (a `[[commands]]` table in their `commands.toml`). Mirrors
 * OperatorCommand in
 * bridge/types.ts. Resolved against the shipped catalog by `commandsFor()`, which hands a pane
 * these rows instead of the catalog when any of them address it — see agent-commands.ts for why a
 * plugin- or user-registered command can only arrive this way.
 */
export interface OperatorCommand {
  /** Herdr agent name this applies to, lowercased. Omitted = every agent. */
  agent?: string;
  command: string;
  description: string;
  takesArg: boolean;
  argHint: string;
  /** The operator marking their own row dangerous. Optional so an older bridge stays readable. */
  confirm?: boolean;
}

/**
 * One operator-declared Keys-tray preset (a `[[keys]]` table in their `keys.toml`). Mirrors
 * OperatorKeyRow in bridge/types.ts. Resolved against the shipped presets by `ctrlPresetsFor()`,
 * which hands a pane these rows instead of the shipped ones when any of them address it. Only the
 * tray's preset CATALOG is configurable — its keyboard is fixed.
 */
export interface OperatorKeyRow {
  /** Herdr agent name this applies to, lowercased. Omitted = every agent. */
  agent?: string;
  /** The button's text, and its identity within one scope. */
  label: string;
  /** Chords in Herdr's `pane.send_keys` spelling; more than one is sent as ONE ordered batch. */
  keys: string[];
  /** The operator putting their own row behind the tray's two-tap confirm. */
  danger?: boolean;
}

/**
 * One operator-declared Quick-dock group (a `[[replies]]` table in their `quick-replies.toml`).
 * Mirrors OperatorQuickReplyRow in bridge/types.ts. Resolved against the shipped groups by
 * `quickRepliesFor()`, which hands a pane these rows instead of the shipped ones when any of them
 * address it.
 */
export interface OperatorQuickReplyRow {
  /** Herdr agent name this applies to, lowercased. Omitted = every agent. */
  agent?: string;
  /** The group's heading, and its identity within one scope. */
  title: string;
  /** The literal strings sent — each is typed into the pane and submitted verbatim. */
  items: string[];
}

export interface BridgeConfig {
  push: boolean;
  vapidPublicKey: string;
  /** Build id of the bundle the bridge is currently serving (for stale-cache detection). */
  build?: string;
  /** The operator's own palette rows. Absent when there is no `commands.toml`. */
  operatorCommands?: OperatorCommand[];
  /** The operator's own Keys-tray presets. Absent when there is no `keys.toml`. */
  operatorKeys?: OperatorKeyRow[];
  /** The operator's own Quick-dock groups. Absent when there is no `quick-replies.toml`. */
  operatorQuickReplies?: OperatorQuickReplyRow[];
}

/**
 * Notification type preferences (GET/POST /api/notifications/prefs). Which agent statuses push, set
 * bridge-wide (fans out to every device, like the snooze). Mirrors NotifyPrefs in bridge/notify-prefs.ts.
 */
export interface NotifyPrefs {
  /** Push when any agent becomes blocked (waiting on your input). Default on. */
  blocked: boolean;
  /** Push when an agent finishes a turn a person started (from Nenu, or typed into a loose agent or a
   *  coordinator); never the organization's own traffic. Default on. */
  replies: boolean;
  /** Push when an agent another agent started finishes a turn that agent typed. Default off. */
  launched: boolean;
  /** Push when a turn a subagent's result started finishes. Default off. */
  subagents: boolean;
  /** Push when a new Nenu version is available (a restart or upgrade is waiting). Default on. */
  updates: boolean;
}

/** Lower sorts first — "needs you" at the top. Mirrors STATUS_RANK on the server. */
export const STATUS_RANK: Record<AgentStatus, number> = {
  blocked: 0,
  working: 1,
  unknown: 2,
  idle: 3,
  done: 4,
};

export const STATUS_LABEL: Record<AgentStatus, string> = {
  blocked: "needs you",
  working: "working",
  idle: "idle",
  done: "done",
  unknown: "unknown",
};

/** Metadata inventory of filesystem-installed skills; not a claim about an agent's loaded context. */
export interface PaneSkill {
  name: string;
  description: string;
  invocation: string;
  source: "project" | "user" | "plugin" | "system";
}
export interface PaneSkillsResponse {
  paneId: string;
  available: boolean;
  trigger: "$" | "/" | null;
  skills: PaneSkill[];
  total: number;
  truncated: boolean;
  reason?: "unsupported-agent" | "no-pane";
}


export type SubagentStatus = "running" | "waiting" | "idle" | "completed" | "failed" | "unknown";
export interface SubagentView {
  id: string;
  parentId: string;
  name: string;
  task: string;
  model?: string;
  status: SubagentStatus;
  updatedAt?: string;
}
export type SubagentsResponse =
  | { available: false; reason: "disabled" | "no-session" | "unsupported" }
  | { available: true; sessionKey: string; agents: SubagentView[]; truncated: boolean };
export interface SubagentHistoryResponse {
  sessionKey: string;
  agent: SubagentView;
  entries: TranscriptEntry[];
  truncated: boolean;
}

// ── Live invalidations ─────────────────────────────────────────────────────────

/** What an invalidation names (mirrors LiveTopic in bridge/types.ts). Never state (ADR 0054). */
export type LiveTopic = "snapshot" | "pane" | "queue" | "journal" | "interaction" | "org" | "activity" | "usage";

// ── Interactions: a pane's dialog, detected bridge-side (mirrors bridge/types.ts) ──────────────────

/** `persistent` changes a setting beyond this turn and always asks to confirm; `freeText` opens a reply; `nav` steps between a wizard's questions. */
export type InteractionOptionRole = "primary" | "neutral" | "persistent" | "deny" | "freeText" | "nav";

export interface InteractionOption {
  index: number;
  label: string;
  description?: string;
  role: InteractionOptionRole;
  /** A multi-select row's tick; absent on rows that are not checkboxes. */
  checked?: boolean;
  /**
   * The answer may carry `text` (a verified sequence types it). A `freeText` row without it has no
   * measured recipe and is answered in the terminal.
   */
  acceptsText?: true;
}

export type InteractionKind = "permission" | "question" | "plan" | "menu" | "wizard" | "multi-select" | "password";

/** Text that enriches a dialog; it never picks the key. When it disagrees with the screen, the screen wins. */
export interface InteractionHint {
  source: "claude-hook" | "claude-journal" | "codex-rpc";
  observedAt: number;
  question?: string;
  options?: string[];
  detail?: string;
}

export interface InteractionStep {
  label: string;
  answered: boolean;
  current: boolean;
}

export interface InteractionAnswer {
  question: string;
  answer: string;
}

/** What a permission asks to run or change, read from the dialog's own rows. Display only. */
export interface InteractionSubject {
  /** The tool the dialog names: "Bash", "Create file". */
  tool?: string;
  /** What the agent says the call is for (Claude's description row, Codex's Reason). */
  description?: string;
  /** The command, with the terminal's wrapping undone; exact when a hint agreed with the screen. */
  command?: string;
  /** The file the call creates or edits. */
  file?: string;
  /** The dialog's preview of the file's lines, its own line numbers kept. */
  preview?: string;
  /** Short facts about where it runs ("Environment: local"). */
  meta?: string[];
}

export interface Interaction {
  paneId: string;
  agent: string;
  kind: InteractionKind;
  family: string;
  question: string;
  context?: string;
  /** The question's header chips: one names a lone question, several are a wizard's steps. */
  steps?: InteractionStep[];
  /** A wizard's review: what Submit sends, one pair per question. */
  answers?: InteractionAnswer[];
  /** A permission's subject in parts; `context` keeps the same rows as plain text. */
  subject?: InteractionSubject;
  /** Options the screen shows that no answer here can press (Codex's and Grok's "don't ask again"). */
  terminalOnly?: string[];
  /** A review with a question left unanswered: Submit sends what `answers` holds and nothing more. */
  incomplete?: true;
  options: InteractionOption[];
  /** Identity of the dialog on screen; an answer with another signature comes back `interaction_changed`. */
  signature: string;
  revision: number;
  hints?: InteractionHint[];
  detectedAt: number;
  /** The full command, file or plan is on the card; only then may Home or a push approve it. */
  detailComplete?: boolean;
  /** The dialog's own input has focus in the terminal: any key sent now would be typed into it. */
  typing?: true;
  /** When Claude denies the request on its own (epoch ms), from its countdown row; absent without one. */
  autoDenyAt?: number;
}

export interface AnswerRequest {
  signature: string;
  optionIndex: number;
  /** Only for an option served with `acceptsText`. */
  text?: string;
  /** Acknowledges a `persistent` option; without it the bridge answers `confirm_required`. */
  confirm?: boolean;
}

export type AnswerOutcome =
  | { ok: true }
  | { ok: false; error: string; code?: "interaction_changed" | "confirm_required" | "unsupported" | "not_reached" };

// ── Guarded send (mirrors bridge/types.ts) ─────────────────────────────────────────────────────────

/** `asap`: type as soon as the composer is free; `afterTurn`: wait for the turn to end; `steer`: join it. */
export type DeliveryMode = "asap" | "afterTurn" | "steer";

export interface SendRequest {
  text: string;
  /** Idempotency key; a retry with the same id never types twice. */
  requestId: string;
  paste?: boolean;
  expectedPrompt?: string;
  /**
   * The operator's "Type anyway" after a `not_ready` refusal: a screen the adapter misreads still
   * gets the text. It skips only that refusal. The text is still verified in the box before Enter.
   */
  force?: boolean;
}

export type SendStage = "preflight" | "type" | "verify" | "submit" | "confirm";

export type SendOutcome =
  | { ok: true; requestId: string; ack: "submitted"; replayed?: boolean }
  | {
      ok: false;
      requestId: string;
      stage: SendStage;
      error: string;
      /** True when text reached the input box: a resend would duplicate it. */
      textDelivered: boolean;
      /** `incomplete`: submitted, but the CLI logged less than was sent (ADR 0076). */
      code?: "prompt_changed" | "not_ready" | "busy" | "incomplete";
    };

/** Why a queued row is still waiting (mirrors bridge/types.ts). */
export type QueueWaitReason = "dialog" | "draft" | "working" | "turn-start" | "disconnected" | "stopped";

/** What the CLI's own queue did with a delivered row. */
export type NativeQueueState = "enqueued" | "absorbed" | "recalled";

// ── Usage (GET /api/usage): tokens and API-equivalent cost of Claude Code and Codex, from their logs ──

export type UsageAgent = "claude" | "codex";

/** Tokens and what they would cost on the API at list price (USD, two decimals); not a bill. */
export interface UsageAmount {
  cost: number;
  tokens: number;
}

export interface UsageTokenDetail {
  /** Uncached input. */
  input: number;
  /** Includes reasoning. */
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface UsageRow extends UsageAmount {
  id: string;
  label: string;
  agent: UsageAgent;
}

export type UsagePeriodKey = "today" | "week" | "month" | "all";

export interface UsagePeriod extends UsageAmount, UsageTokenDetail {
  key: UsagePeriodKey;
  /** First local day of the period, YYYY-MM-DD; weeks start on Monday. */
  from: string;
  agents: Partial<Record<UsageAgent, UsageAmount>>;
  /** By cost, highest first. */
  byModel: UsageRow[];
  /** Repos (a repo's worktrees count together): the top 8, then one row `id: "_rest"` for the others. */
  byProject: UsageRow[];
}

/** Only days with usage, within the last 371, oldest first. */
export interface UsageDay extends UsageAmount {
  date: string;
  agents: Partial<Record<UsageAgent, UsageAmount>>;
  /** With Split by account on and no account filter. */
  accounts?: Array<UsageAmount & { id: string }>;
}

/** The last 12 weeks, oldest first. */
export interface UsageWeek {
  /** Monday, YYYY-MM-DD. */
  start: string;
  agents: Partial<Record<UsageAgent, UsageAmount>>;
}

export interface UsageLimitWindow {
  name: "five_hour" | "seven_day" | "other";
  windowMinutes: number;
  usedPercent: number;
  /** Epoch seconds. */
  resetsAt?: number;
}

export interface UsageLimits {
  agent: UsageAgent;
  /** Absent with Split by account off: the agent's newest reading. */
  account?: string;
  /** Epoch ms of the reading. */
  observedAt: number;
  source: "statusline" | "codex" | "hats" | "claude-swap";
  plan?: string;
  windows: UsageLimitWindow[];
}

export interface UsageAccount {
  /** "claude:<16 hex>", "claude:swap-2", "codex:<16 hex>", "claude:unassigned". */
  id: string;
  agent: UsageAgent;
  /** The operator's alias, "Claude 2", "Account 2", "ChatGPT" or "Unassigned"; never an email. */
  label: string;
  source: "observed" | "hats" | "claude-swap" | "codex" | "none";
  /** The account the CLI uses now, as last seen. */
  active: boolean;
  /** Epoch ms of the switch that made it active, and of the one that ended its last turn as active. */
  activeSince?: number;
  activeUntil?: number;
  /** This month. */
  month: UsageAmount;
}

export interface UsageScan {
  state: "idle" | "scanning";
  /** No totals yet: the first pass is still reading. */
  firstPass: boolean;
  files?: number;
  totalFiles?: number;
  bytes?: number;
  totalBytes?: number;
  /** Epoch ms the last scan finished. */
  scannedAt?: number;
  error?: string;
}

export interface UsageOff {
  on: false;
  splitByAccount: boolean;
}

export interface UsageOn {
  on: true;
  splitByAccount: boolean;
  scan: UsageScan;
  /** IANA zone the days are cut in. */
  timeZone: string;
  today: string;
  /** Earliest day any log had; the day Nenu started keeping totals of its own. */
  coverage: { logsFrom?: string; trackedFrom: string };
  /** The account filter applied (only with Split by account on). */
  account?: string;
  /** today, week, month, all. */
  periods: UsagePeriod[];
  days: UsageDay[];
  weeks: UsageWeek[];
  /** Quartile cuts of the active days, for the map's four levels. */
  levels: { cost: [number, number, number]; tokens: [number, number, number] };
  /** Empty with Split by account off. */
  accounts: UsageAccount[];
  limits: UsageLimits[];
  prices: { checked: string; unpriced: string[] };
}

export type UsageResponse = UsageOff | UsageOn;
