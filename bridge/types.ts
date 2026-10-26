// Domain model for the bridge. These are OUR types, decoupled from Herdr's wire shapes
// (which live only in herdr-client.ts). The rest of the app talks in these terms.

import type { AgentSessionRef, SessionTelemetry, TranscriptEntry } from "./journal/types.ts";

// Re-exported so the wire surface has ONE import site: a consumer of PaneHistoryResponse gets the
// entry shape from here too, without reaching into an adapter module.
export type { SessionTelemetry, TranscriptEntry, TranscriptPart } from "./journal/types.ts";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/**
 * A single pane the user might want to monitor or drive. Usually an agent-bearing pane (the
 * triage home), but also a bare **shell** pane (`kind:"shell"`, `agent:"shell"`) once we surface
 * those so a freshly-created tab/space is reachable and you can launch your own agent in it.
 */
export interface AgentView {
  paneId: string;
  workspaceId: string;
  workspaceLabel: string;
  workspaceNumber: number;
  tabId: string;
  agent: string;
  status: AgentStatus;
  cwd: string;
  /**
   * The project its folder works in: the name of the repo the folder sits in, so a repo's clones and
   * worktrees share it, else the folder's own name (`bridge/pane-project.ts`). The sidebar groups chats
   * by it. Absent when Herdr reports no folder.
   */
  project?: string;
  focused: boolean;
  /** "agent" for an agent-bearing pane, "shell" for a bare shell. Defaults to "agent" when absent. */
  kind?: "agent" | "shell";
  /** User-set pane label (herdr `pane.rename`), when one is set; absent when the pane is unlabelled. */
  paneLabel?: string;
  /** The agent's Herdr name, which `herdr agent start <name>` sets; another agent started it, as far
   *  as Herdr can tell today (it records no launcher). Absent for an unnamed agent. */
  agentName?: string;
  /**
   * Claude's OWN session name, set in-agent via `/rename` and read out of the pane's rendered text
   * (see `extractClaudeSessionName` in state-engine.ts). Claude-only and derived, not a wire field —
   * absent for unnamed sessions and every non-claude pane. Display priority is `paneLabel` first.
   */
  sessionName?: string;
  /**
   * How the agent named its session (Herdr `agent_session`), when it named one at all.
   *
   * SERVER-SIDE ONLY — stripped before this pane goes on the wire (see {@link PaneWire}), because
   * pi reports a kind-`path` ref whose value is an absolute filesystem path, and the client has no
   * use for it: the history endpoint re-derives the ref from the pane id and never trusts a
   * client-supplied one. What the client gets is the presence flag `hasSession`.
   */
  agentSession?: AgentSessionRef;
  /**
   * Upper bound on the lines a `recent` read of this pane can return — Herdr's scrollback depth plus
   * the viewport. This is the ONLY reliable "is there more scrollback" signal: `PaneRead.truncated`
   * is always false even when a read cut history off, which is why the mirror's "Load older" button
   * never used to appear. A pane on the alternate screen (any Claude agent) reports just its viewport
   * here, because the alt screen keeps no scrollback ring at all. Absent on older Herdr servers.
   */
  readableLines?: number;
  /**
   * The pane's tab label, denormalised from `tab.list` exactly as `workspaceLabel` already is — so
   * every client surface (card, sidebar, palette, space view) gets it without joining `tabs[]`.
   * Absent when the label carries no information: an unlabelled tab in a single-tab space is named
   * positionally by Herdr ("1"), which would render as `project · 1`. See `meaningfulTabLabel`.
   */
  tabLabel?: string;
  /**
   * What the pane's own process says it is doing — its OSC title, glyph-stripped and dropped when
   * uninformative (see `meaningfulTerminalTitle`). Claude rewrites this per turn, so unlike
   * `paneLabel` and `sessionName` — both set once, by hand — it tracks the work as it moves, which
   * is what tells several agents in ONE project apart in the herd list.
   *
   * Absent when the title says nothing, and on Herdr servers too old to report it.
   */
  terminalTitle?: string;
  /**
   * Epoch ms of this agent's last observed status transition (bridge/activity.ts). The only thing
   * that can make a pane read as unseen. Absent until the ledger has an entry, and on the very
   * first poll after a fresh install.
   */
  lastActiveAt?: number;
  /**
   * Epoch ms you last opened or drove this pane through Nenu. `lastActiveAt > lastSeenAt` on a
   * `done` agent IS the "finished while you weren't looking" state — there is no stored seen flag.
   */
  lastSeenAt?: number;
  /**
   * Herdr's `agent.list` `state_change_seq`: bumps on every status transition, so two equal values
   * mean no transition happened between two reads — even one that started and finished between
   * polls. Absent on servers that don't report it.
   */
  stateChangeSeq?: number;
  /** Herdr's `agent.list` `completion_seq`: bumps when an idle transition completed work. */
  completionSeq?: number;
  /**
   * The agent's turn as the CLI itself records it (ADR 0067): Claude's session file, Codex's rollout.
   * Attached at read time by bridge/agent-state.ts; absent when no structured source is known for the
   * pane, and then the screen and Herdr's status stay the fallback.
   */
  turn?: TurnState;
}

/** What the CLI's own files say about its turn (ADR 0067). */
export interface TurnState {
  /** A turn the CLI's interrupt key reaches. Stop's button and Stop's press both read this. */
  running: boolean;
  /** Claude: a dialog owns the keyboard (its `waitingFor`, e.g. "permission prompt"). */
  waiting?: string;
  /** Work goes on with no turn to interrupt: background agents, a workflow or a shell. */
  background?: boolean;
  /** What Escape does to the CLI's own queue, when its files say (Claude): `sends` or nothing. */
  queued?: "sends" | null;
  /**
   * Claude, at rest: the account's usage limit refused its last request (its own `usage_limit_reached`
   * row), with the epoch ms the limit resets. Gone once the reset passed or a reply came through.
   */
  limit?: { resetsAt: number };
  source: "claude-session" | "codex-rollout";
}

/**
 * A pane as the BROWSER sees it: every {@link AgentView} field except the session ref, which is
 * replaced by a presence flag.
 *
 * The two shapes differ on purpose. `agentSession.value` is either an opaque id (Claude, Codex) or an
 * absolute path (pi) — the client needs neither, and shipping the path would hand out filesystem
 * layout for nothing. All the UI ever asked of that field was "may this pane have history?", which is
 * what `hasSession` answers, so the History affordance still shows without a speculative fetch.
 *
 * NOTE the `Omit` is opt-OUT: a future server-only field on AgentView goes on the wire unless it is
 * added to the omit list here. If you add one, strip it here in the same change.
 */
export type PaneWire = Omit<AgentView, "agentSession"> & {
  /** True when this pane's history is actually offerable: the agent named a session AND its harness
   *  has a journal adapter. Says nothing about whether the log is readable — a named session whose
   *  file is missing still answers `available:false` with reason `no-log`. */
  hasSession?: boolean;
};

/**
 * Strip a pane down to its wire shape. The one place the session ref leaves the bridge's hands.
 *
 * `hasJournal` is asked rather than assumed: a harness can name a session while having no adapter to
 * read it (Herdr detects more agents than Nenu has journals for). Keying the flag on the ref alone
 * would advertise a History affordance that always comes back empty, so the registry gets a vote.
 */
export function toPaneWire(pane: AgentView, hasJournal: (agent: string) => boolean): PaneWire {
  const { agentSession, ...rest } = pane;
  return agentSession && hasJournal(pane.agent) ? { ...rest, hasSession: true } : rest;
}

/** A Herdr workspace ("space") — a project-scoped container of tabs. From `workspace.list`. */
export interface WorkspaceView {
  workspaceId: string;
  number: number;
  label: string;
  /** Whether this is the focused workspace in the desktop TUI (read-only; we never set focus). */
  focused: boolean;
  activeTabId: string;
  tabCount: number;
  paneCount: number;
}

/** A tab within a workspace (a layout/view holding one or more panes). From `tab.list`. */
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
 * One entry in the snapshot's `sessions` list — a herdr session this bridge fronts. Additive: a
 * single-session deployment reports exactly one (the primary), so nothing about the UI changes.
 */
export interface SessionSummary {
  /** Registry name, e.g. "default" or "collie-demo". Client passes this back as `?session=`. */
  name: string;
  /** The session cfg.socketPath points at — all pre-multi-session behaviour maps to it. */
  isPrimary: boolean;
  /** Whether this session's last poll succeeded (a stale/unreachable socket reads false). */
  reachable: boolean;
  /** Agent-pane count (0 when unreachable). */
  agents: number;
  /** Agent panes currently working / blocked (0 when unreachable). */
  working: number;
  blocked: number;
}

/**
 * An open pull request of the person's, read with `gh` in a repo an agent works in
 * (bridge/pull-requests.ts). `paneIds` are the panes whose folder is on its branch.
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
  /** Its repo is one a pane's folder names through its remotes: a repo the herd is using (ADR 0128). */
  inUse: boolean;
}

/**
 * Per-device authorisation state for the requesting client (see `deviceAuth()` in routes/access.ts).
 * Reported in the snapshot so the UI can show a read-only state. Optional on the wire so an older
 * bridge (or a response from before the feature existed) simply reads as "not enforced".
 */
export interface DeviceAuth {
  /** Whether per-device authorisation is enforced at all (COLLIE_DEVICE_HEADER is set). */
  enforced: boolean;
  /** The opaque device identifier from the trusted header, or null if absent / feature off. */
  device: string | null;
  /** Whether this device may perform sensitive (terminal-driving / structural) actions. */
  authorized: boolean;
}

// ── REST response shapes (the browser polls these; see routes/) ──────────────

/** GET /api/snapshot — the current herd view. */
export interface SnapshotResponse {
  bridge: BridgeStatus;
  /** Per-device authorisation for the requesting client; absent when the feature is off. */
  device?: DeviceAuth;
  /** Agent-bearing panes, triage-sorted (the home list). */
  agents: PaneWire[];
  /** Bare shell panes (no agent) — surfaced so freshly-created tabs/spaces are reachable. */
  shellPanes: PaneWire[];
  /** All spaces (workspaces) and their tabs, for the space/tab navigator. */
  workspaces: WorkspaceView[];
  tabs: TabView[];
  /**
   * The ETag `/api/pull-requests` answers for this session now: the page reads the list there only
   * when this changes. Absent for another machine, whose pull requests stay there.
   */
  pullRequestsEtag?: string;
  /**
   * Every herdr session this bridge fronts (primary first, then alphabetical). Always present; a
   * single-session deployment lists just the primary, so the switcher UI can stay hidden.
   */
  sessions: SessionSummary[];
  /** Notification quiet-hours: the active snooze deadline (epoch ms) or null. */
  notifications?: { snoozedUntil: number | null };
  /** Update-availability signal. Optional — a stale bridge that predates the field simply omits it,
   *  which the client reads as "no info" (see bridge/update.ts). */
  update?: UpdateStatus;
  /**
   * The machines Herdr has saved (`herdr machine list`), this one first. Absent while Herdr has none,
   * so a single machine's snapshot is what it always was. Each machine other than the one this
   * snapshot is about carries its herd, so every list can show them all.
   */
  machines?: MachineView[];
  ts: number;
}

/**
 * Why a saved machine is or is not usable from here. `old-nenu` and `no-nenu` mean SSH got there and
 * found Nenu too old to accept other machines, or not there at all; `offline` means SSH did not get there.
 * `off` is every machine while this Nenu's "Show other machines" is off: nothing was dialled.
 */
export type MachineState = "connected" | "connecting" | "offline" | "old-nenu" | "no-nenu" | "disabled" | "off";

/** What a machine's lists need: its panes and where they sit, as its own snapshot gives them. */
export interface MachineHerd {
  bridge: BridgeStatus;
  agents: PaneWire[];
  shellPanes: PaneWire[];
  workspaces: WorkspaceView[];
  tabs: TabView[];
}

export interface MachineView {
  /** What the browser passes as `?s=` to reach it (`@<label>`); absent for this bridge's own machine. */
  session?: string;
  label: string;
  state: MachineState;
  /** Why it is not connected, in words. */
  detail?: string;
  /** Present for every machine except the one the snapshot is about, once it was read. */
  herd?: MachineHerd;
}

/**
 * GET /api/snapshot `update` — whether the running plugin is behind (see bridge/update.ts). Both a
 * newer upstream RELEASE (`releaseAvailable` + `latest`) and a rebuilt-but-not-restarted bridge
 * PROCESS (`bridgeStale`) surface here; the client shows one banner, `bridgeStale` taking precedence.
 */
export interface UpdateStatus {
  /** Locally managed builds never check or advertise an upstream release. */
  releaseChannel?: "local" | "github";
  /** Explicit GitHub owner/repository, present only for the GitHub release channel. */
  releaseRepo?: string;
  /** The running bridge/plugin version, captured at process start. */
  current: string;
  /** Newest upstream release (dotted `X.Y.Z`, no leading `v`), or null if unknown/none yet. */
  latest: string | null;
  /** GitHub release page for `latest` (the banner links to it), or null when `latest` is unknown. */
  latestUrl: string | null;
  /** `latest` is strictly newer than `current`. */
  releaseAvailable: boolean;
  /**
   * Newest release of a major ABOVE the running one (dotted `X.Y.Z`), or null. Reported apart from
   * `latest` because a routine `update` never crosses a major — the crossing is consented to by
   * `update --major` (ADR 0020), and the banner names that command instead.
   */
  majorAvailable: string | null;
  /** GitHub release page for `majorAvailable`, or null when there is none. */
  majorUrl: string | null;
  /** The running process is behind the on-disk bridge source — needs `systemctl --user restart nenu`. */
  bridgeStale: boolean;
  /** When the upstream check last completed (epoch ms), or null if it hasn't run yet. */
  checkedAt: number | null;
}

/** GET /api/pane/:id — recent terminal output for one agent (ANSI/SGR, rendered colored). */
export interface PaneReadResponse {
  nativeTelemetry?: { sessionKey: string; telemetry: SessionTelemetry };
  paneId: string;
  text: string;
  truncated: boolean;
  /** Herdr's monotonic pane revision — passed through for the client's prompt-select race guard. */
  revision: number;
  /** A shell pane only: true while the shell waits at its prompt, false while a command holds the
   *  terminal. Absent when unknown. */
  atPrompt?: boolean;
}

/**
 * GET /api/pane/:id/history — real conversation history for a pane, read from the agent's own
 * session log. This is NOT terminal scrollback: a Claude pane runs on the alternate screen, so no
 * scrollback exists to page (see transcript.ts). `available:false` is the normal answer for a pane
 * with no agent session, a non-Claude agent, or a bridge with the feature switched off.
 */
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
      /** Turns available in the parsed window. */
      total: number;
      /** The log exceeded the read cap, so only its tail was parsed. */
      fileTruncated: boolean;
      telemetry?: SessionTelemetry;
      sessionKey?: string;
    };

/**
 * POST /api/pane/:id/{reply,keys} — result of a send. Discriminated on `ok`: a failure always
 * carries the reason Herdr rejected it. `textDelivered` distinguishes the reply partial-failure case
 * (text was typed but the submit keypress failed) so the client knows NOT to resend — resending would
 * duplicate the already-typed text. Absent/false ⇒ nothing landed, so a resend is safe.
 */
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
  | {
    ok: true; pressed: boolean; queued: "sends" | "returns" | null; held: number;
    /** After a press: the CLI's own state showed the turn end (true), or still running (false).
     *  Absent when no structured source watches the pane. */
    confirmed?: boolean;
  }
  | { ok: false; error: string; code: "confirm_required" | "not_running" | "busy" | "unsupported" | "failed" };

/** POST /api/pane/:id/upload — image saved to a host file; `path` is the absolute path to ref. */
export type UploadResponse = { ok: true; path: string } | { ok: false; error: string };

/** A freshly-created shell pane — enough for the client to navigate into before the next poll. */
export interface CreatedPane {
  paneId: string;
  workspaceId: string;
  workspaceLabel: string;
  tabId: string;
  cwd: string;
}

/**
 * POST /api/tab | /api/workspace — created a new tab/space with a fresh shell. On success `pane`
 * is that shell, so the client can navigate straight into it before the next poll lands.
 */
export type CreateResponse = { ok: true; pane: CreatedPane } | { ok: false; error: string };

/**
 * One operator-declared slash command (a `[[commands]]` row in their `commands.toml`). A pane any of
 * these rows address shows them INSTEAD of the shipped Agent-commands catalog; a pane none of them
 * address keeps it (ADR 0018). This is the escape hatch for commands the shipped catalog cannot know
 * about — plugin- or user-registered ones like omp's `/fork-in-herdr` — which exist only on THIS
 * operator's machine and so must never be hard-coded into `web/src/lib/agent-commands.ts`.
 */
export interface OperatorCommand {
  /** Herdr agent name this applies to, lowercased. Omitted = every agent. */
  agent?: string;
  /** Includes the leading slash. */
  command: string;
  /** One-line description shown in the palette (also searched). */
  description: string;
  /** True when tapping should insert `/cmd ` into the composer instead of submitting it. */
  takesArg: boolean;
  /** Placeholder shown after insert, e.g. `<name>`. Empty when {@link takesArg} is false. */
  argHint: string;
  /**
   * The operator marking their own row dangerous — it then gets the same two-tap confirmation a
   * shipped dangerous command gets. Only ever ADDS: a row naming a shipped command inherits that
   * command's confirm regardless (rule 3 in agent-commands.ts), and `false` cannot lift it.
   */
  confirm: boolean;
}

/**
 * One operator-declared Keys-tray preset (a `[[keys]]` row in their `keys.toml`). A pane any of
 * these rows address shows them INSTEAD of the shipped Ctrl presets; a pane none of them address
 * keeps the shipped ones (ADR 0018, the same rule `commands.toml` follows). Only the PRESETS are
 * configurable — the tray's keyboard (Esc/arrows/Enter/Tab/Space, modifiers, digits, F1–F12) is
 * fixed.
 */
export interface OperatorKeyRow {
  /** Herdr agent name this applies to, lowercased. Omitted = every agent. */
  agent?: string;
  /** The button's text, and its identity within one scope. */
  label: string;
  /**
   * The chords to send, already normalised to Herdr's `pane.send_keys` spelling. More than one is
   * sent as ONE batch, in order — the same call a composed key queue makes.
   */
  keys: string[];
  /** The operator putting their own row behind the tray's existing two-tap confirm. */
  danger: boolean;
}

/**
 * One operator-declared Quick-dock group (a `[[replies]]` row in their `quick-replies.toml`). A
 * pane any of these rows address shows them INSTEAD of the shipped groups; a pane none of them
 * address keeps the shipped ones (ADR 0018, the same rule `commands.toml` and `keys.toml` follow).
 *
 * The shipped phrases are English, which is a content choice rather than a technical one — an
 * operator working in another language, or one whose harness wants "approve" over "yes", has no
 * route to that today.
 */
export interface OperatorQuickReplyRow {
  /** Herdr agent name this applies to, lowercased. Omitted = every agent. */
  agent?: string;
  /** The group's heading, and its identity within one scope. */
  title: string;
  /** The literal strings sent — each is typed into the pane and submitted verbatim. */
  items: string[];
}

/** GET /api/config — bridge capabilities and the build id (push setup + stale-cache detection). */
export interface BridgeConfig {
  push: boolean;
  vapidPublicKey: string;
  /** Build id of the bundle the bridge is currently serving (for stale-cache detection). */
  build?: string;
  /** The operator's own palette rows. Absent/empty when there is no `commands.toml`. */
  operatorCommands?: OperatorCommand[];
  /** The operator's own Keys-tray presets. Absent/empty when there is no `keys.toml`. */
  operatorKeys?: OperatorKeyRow[];
  /** The operator's own Quick-dock groups. Absent/empty when there is no `quick-replies.toml`. */
  operatorQuickReplies?: OperatorQuickReplyRow[];
}

/** Rank for triage ordering — lower sorts first ("NEEDS YOU" at the top). */
export const STATUS_RANK: Record<AgentStatus, number> = {
  blocked: 0,
  working: 1,
  unknown: 2,
  idle: 3,
  done: 4,
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

// ── Live invalidations ─────────────────────────────────────────────────────────

/**
 * What an invalidation names. `interaction` is a pane's detected dialog. The stream carries only
 * these names, never state (ADR 0054).
 */
export type LiveTopic = "snapshot" | "pane" | "queue" | "journal" | "interaction" | "activity" | "usage";

export interface LiveEvent {
  session: string;
  topic: LiveTopic;
  paneId?: string;
}

/** The one capability a producer of invalidations needs; injected so tests can pass a recorder. */
export interface LivePublisher {
  publish(event: LiveEvent): void;
}

// ── Interactions: a pane's dialog, detected by the bridge from the screen ──────────────────────────

/**
 * What an option does, which decides how it is drawn and whether a one-tap answer is allowed:
 * `persistent` changes a setting beyond this turn ("don't ask again"), so it always asks to confirm;
 * `freeText` opens a text reply instead of pressing a key; `nav` moves between a wizard's questions
 * (the arrows its footer names) and answers nothing.
 */
export type InteractionOptionRole = "primary" | "neutral" | "persistent" | "deny" | "freeText" | "nav";

export interface InteractionOption {
  /** Position in the dialog's own order; what {@link AnswerRequest.optionIndex} names. */
  index: number;
  label: string;
  description?: string;
  role: InteractionOptionRole;
  /** A multi-select row's tick; absent on every other kind. */
  checked?: boolean;
  /** The answer may carry `text` (a verified sequence types it). A `freeText` option without it has
   *  no measured recipe and is answered in the terminal. */
  acceptsText?: true;
}

export type InteractionKind = "permission" | "question" | "plan" | "menu" | "wizard" | "multi-select" | "password";

/**
 * Text that enriches a screen-detected dialog (a hook payload, a journal row, a Codex RPC request).
 * Hints never choose the key that answers: when they disagree with the screen, the screen wins.
 */
export interface InteractionHint {
  source: "claude-hook" | "claude-journal" | "codex-rpc";
  observedAt: number;
  question?: string;
  options?: string[];
  /** The full command, file path or plan the dialog is about, when the source carries it. */
  detail?: string;
}

/** One header chip above a question, as the dialog draws it (`☒` answered, highlight current). */
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
  /** Which harness grammar recognised it ("claude", "codex", …). */
  family: string;
  question: string;
  /** The text around the question the operator needs to decide (the command, the diff path…). */
  context?: string;
  /** The question's header chips: one names a lone AskUserQuestion, several are a wizard's steps. */
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
  /** Identity of the exact dialog on screen; an answer carrying another signature is refused (409). */
  signature: string;
  /** Herdr pane revision the detection read. */
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

/** POST /api/interactions/:paneId/answer. `text` only for a `freeText` option. */
export interface AnswerRequest {
  signature: string;
  optionIndex: number;
  text?: string;
  /** Acknowledges a `persistent` option. */
  confirm?: boolean;
}

export type AnswerOutcome =
  | { ok: true }
  | { ok: false; error: string; code?: "interaction_changed" | "confirm_required" | "unsupported" | "not_reached" };

// ── Guarded send: one POST that types, verifies and submits ────────────────────────────────────────

/**
 * How a message meets a busy agent: `asap` types it as soon as the composer is free (the CLI's own
 * queue takes it mid-turn), `afterTurn` waits for the turn to end, `steer` joins the running turn
 * where the CLI supports it.
 */
export type DeliveryMode = "asap" | "afterTurn" | "steer";

export interface SendRequest {
  text: string;
  /** Idempotency key; a retry with the same id never types twice. */
  requestId: string;
  paste?: boolean;
  /** The dialog text the operator saw, when sending into one (the reply prompt binding). */
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
      /** Where it stopped; with `textDelivered` it tells the client whether a resend would duplicate. */
      stage: SendStage;
      error: string;
      textDelivered: boolean;
      /** `incomplete`: submitted, but the CLI logged less than was sent (ADR 0076). */
      code?: "prompt_changed" | "not_ready" | "busy" | "incomplete";
    };

// ── Queue rows: the fields the delivery rework adds ────────────────────────────────────────────────

/** Why a queued row is still waiting. `stopped` mirrors the row's stored `held`; the others live in
 *  memory and are never written as a revision bump. */
export type QueueWaitReason = "dialog" | "draft" | "working" | "turn-start" | "disconnected" | "stopped" | "limit";

/** What the CLI's own queue did with a delivered row, read from its journal. */
export type NativeQueueState = "enqueued" | "absorbed" | "recalled";

// ── Transcript media without bytes ─────────────────────────────────────────────────────────────────

/**
 * An image the journal holds inline (a pasted screenshot, a tool's image result), as a marker only.
 * The bytes are fetched on demand from the journal-image endpoint by entry and index — never by path,
 * and never inlined into /history. Joins TranscriptPart once the adapters emit it.
 */
export interface TranscriptImagePart {
  kind: "image";
  /** Zero-based image index within its entry; with the entry uuid it addresses journal-image. */
  index: number;
  mediaType?: string;
}

/** A file a tool call produced or showed, attached to the call's result as a reference. */
export type ToolAttachment =
  | { kind: "image"; index: number; mediaType?: string }
  | { kind: "file"; path: string };

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
