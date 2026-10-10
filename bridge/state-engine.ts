import { meaningfulTabLabel, meaningfulTerminalTitle } from "./activity.ts";
import type { HerdrClient } from "./herdr-client.ts";
import {
  type AgentStatus,
  type AgentView,
  type BridgeStatus,
  STATUS_RANK,
  type TabView,
  type WorkspaceView,
} from "./types.ts";

// Polls Herdr on an interval, builds the snapshot (agents + shell panes + spaces/tabs), and emits
// transition events. Polling (vs the per-pane event subscription) keeps this resync-free: a failed
// poll just retries next tick, and reconnection needs no special handling. See HERDR_API.md.

// How many lines to read per claude pane when sniffing its `/rename` session name. Claude's input
// box (and the named rule above it) sits at the very tail, so a small window is plenty and keeps the
// extra per-poll reads cheap.
//
// The source MUST stay `visible`. A `recent` text read asking for more rows than the pane currently
// shows makes Herdr harvest the pages above the viewport, and on a full-screen agent (Claude runs on
// the alternate screen, which has no host scrollback) the only way to reach them is to drive the
// agent's own mouse-scroll interface: Herdr scrolls the pane up page by page, then restores it. The
// operator watches their terminal jump and snap back — once per poll, per idle claude pane.
// `visible` cannot do that whatever this count is: it is the rendered viewport, clamped to it. Which
// is also why this number is free to stay generous — the run below the ❯ prompt is a statusline of
// unknown height ([ADR 0004](../.adr/0004-the-statusline-run-is-bounded.md)), so headroom is worth
// more here than a smaller read. See HERDR_API.md → `pane.read`.
const SESSION_NAME_READ_LINES = 40;

// Consecutive failed polls before the herd is reported disconnected (see the poll's catch).
const DISCONNECT_AFTER_FAILURES = 2;

// How long a claude pane's session name may go unread while its identity and status hold still. A
// `/rename` typed in the desktop TUI changes neither, so this bounds how stale the name can get;
// everything else re-reads on the change itself. Without it every poll read every claude pane:
// 14 of the 15 socket calls per poll on a 14-claude herd (measured 2026-10-10).
const SESSION_NAME_REFRESH_MS = 60_000;

// Pane tokens copied into the view. Herdr Organizations writes these with a TTL and refreshes them
// (`project`, `thread`, … at 300 s; `org_project`/`org_workspace` sidebar identity at 60 s);
// `hp_group` is the sidebar's group order (live-observed). `org_heartbeat` stays out: it changes on
// every 10 s refresh and would turn each one into a snapshot change.
const ALLOWED_TOKENS = new Set([
  "project", "thread", "review", "role", "rank", "depth", "parent", "tree-order", "hp_group",
  "org_project", "org_workspace",
]);
const MAX_TOKEN_VALUE = 200;

/** The allowlisted subset of a pane's tokens, or undefined when none is set. */
export function allowedTokens(tokens: Record<string, unknown> | null | undefined): Record<string, string> | undefined {
  if (!tokens) return undefined;
  const out: Record<string, string> = {};
  let any = false;
  for (const [key, value] of Object.entries(tokens)) {
    if (typeof value !== "string" || value.length > MAX_TOKEN_VALUE) continue;
    if (!ALLOWED_TOKENS.has(key)) continue;
    out[key] = value;
    any = true;
  }
  return any ? out : undefined;
}

// Claude renders its input box as a horizontal rule, the ❯ prompt line, then a closing rule. After
// `/rename <name>` the TOP rule carries the session name inside it: "────────── my-name ──". This
// matches that named rule. `\S` also matches box-drawing chars, but a *plain* rule has no embedded
// space-delimited text, so it can't match — and the ❯-prompt anchor (below) rules out any decorative
// rule elsewhere in the output. Rule chars: ─ (U+2500, light) and ━ (U+2501, heavy).
const NAMED_RULE = /^[─━]{2,}[ \t]+(\S.*?\S|\S)[ \t]+[─━]+[ \t]*$/;
// Claude's input prompt marker, anchored at column 0. Its menu/selection cursors render as " ❯"
// (leading space), so the column-0 anchor discriminates the real input prompt from a selected row.
const PROMPT_LINE = /^❯/;

/**
 * Pull Claude's own session name (set via `/rename`) out of a pane's visible text, or `undefined` when
 * the session is unnamed (a plain rule) or the pane isn't showing its input box (a dialog, a working
 * spinner). Claude draws the name INTO the horizontal rule directly above the ❯ prompt, e.g.
 * `────────── my-name ──`; we accept that rule ONLY when the very next line is the ❯ prompt, so a
 * decorative rule anywhere else in the output can never be mistaken for it (no false positives).
 * Derived from Claude's UI grammar — claude-only; other harnesses never call this. Pure + exported so
 * it's unit-tested against the pane fixtures without standing up the socket client.
 */
export function extractClaudeSessionName(text: string): string | undefined {
  if (!text) return undefined;
  const lines = text.split(/\r?\n/);
  // Only the BOTTOMMOST ❯ counts — that's the live input prompt; anything above it is scrollback.
  // The rule directly above it decides, and a plain rule means "unnamed", full stop. Scanning past it
  // for older named-rule-above-❯ pairs (as this once did) let a scrollback line that merely starts
  // with ❯ — an echoed shell prompt, pasted text — sit under a decorative rule and pin a bogus name
  // on an unnamed session (the caller's sticky cache only overwrites on truthy matches).
  for (let i = lines.length - 1; i >= 1; i--) {
    if (!PROMPT_LINE.test(lines[i]!)) continue;
    const m = NAMED_RULE.exec(lines[i - 1]!);
    return m ? m[1]!.trim() || undefined : undefined;
  }
  return undefined;
}

export interface EngineSnapshot {
  agents: AgentView[];
  shellPanes: AgentView[];
  workspaces: WorkspaceView[];
  tabs: TabView[];
  bridge: BridgeStatus;
}

type TransitionListener = (agent: AgentView, from: AgentStatus, to: AgentStatus) => void;
type RemoveListener = (paneId: string) => void;
type UpdateListener = (snap: EngineSnapshot) => void;
// `readFor` is the status the last successful read saw and `readAt` when; a status change or an
// expired `readAt` asks for a fresh read, a new identity starts a fresh entry.
type SessionName = { identity: string; name?: string; readFor?: string; readAt?: number };
type RefreshWaiter = {
  poll: number;
  resolve: (snapshot: EngineSnapshot) => void;
  reject: (error: unknown) => void;
};

export class StateEngine {
  private agents: AgentView[] = [];
  private shellPanes: AgentView[] = [];
  private workspaces: WorkspaceView[] = [];
  private tabs: TabView[] = [];
  private bridge: BridgeStatus = "disconnected";
  private readonly prevStatus = new Map<string, AgentStatus>();
  // Last-known claude `/rename` session name per pane. Kept sticky so the name doesn't flicker away
  // when a pane momentarily hides its input box (a dialog / working spinner) — only cleared when the
  // pane or its session changes. Optional reads never delay metadata publication.
  private readonly sessionNames = new Map<string, SessionName>();
  private enrichingNames = false;
  private queuedNames = false;
  private nameEpoch = 0;
  private readonly transitionListeners = new Set<TransitionListener>();
  private readonly removeListeners = new Set<RemoveListener>();
  private readonly updateListeners = new Set<UpdateListener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private polling = false;
  private pollNumber = 0;
  private refreshWaiters: RefreshWaiter[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  // One follow-up poll queued when pokeNow lands mid-poll: an event may describe state the
  // in-flight poll already read past, so we must re-poll once it settles.
  private queuedPoll = false;
  // Current interval cadence; setCadence swaps it (relaxed while the event stream is healthy).
  private cadenceMs: number;
  // session.snapshot is the fast path; flipped off PERMANENTLY once a server proves it predates the
  // method (see poll()), after which every tick uses the legacy three-call path.
  private supportsSnapshot = true;

  constructor(
    private readonly herdr: HerdrClient,
    private readonly pollMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.cadenceMs = pollMs;
  }

  onTransition(fn: TransitionListener): () => void {
    this.transitionListeners.add(fn);
    return () => this.transitionListeners.delete(fn);
  }

  /** Fires when a previously-seen agent pane vanishes (closed/exited) — used to retract its push. */
  onRemove(fn: RemoveListener): () => void {
    this.removeListeners.add(fn);
    return () => this.removeListeners.delete(fn);
  }

  /** Fires after a successful metadata poll or a background session-name update. */
  onUpdate(fn: UpdateListener): () => void {
    this.updateListeners.add(fn);
    return () => this.updateListeners.delete(fn);
  }

  current(): EngineSnapshot {
    return {
      agents: this.agents,
      shellPanes: this.shellPanes,
      workspaces: this.workspaces,
      tabs: this.tabs,
      bridge: this.bridge,
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.cadenceMs = this.pollMs;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.cadenceMs);
  }

  stop(): void {
    this.started = false;
    this.nameEpoch++;
    this.queuedNames = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /**
   * Poll right now (event-poked). If a poll is already in flight, queue exactly one follow-up to run
   * when it finishes — the event that poked us may describe state that poll already read past.
   * No-op once stopped.
   */
  pokeNow(): void {
    if (!this.started) return;
    if (this.polling) {
      this.queuedPoll = true;
      return;
    }
    void this.poll();
  }

  /** Read metadata after this call, even when an older poll is already in flight. */
  refresh(): Promise<EngineSnapshot> {
    return new Promise((resolve, reject) => {
      this.refreshWaiters.push({ poll: this.pollNumber + 1, resolve, reject });
      if (this.polling) this.queuedPoll = true;
      else void this.poll();
    });
  }

  private settleRefresh(poll: number, result: { ok: true } | { ok: false; error: unknown }): void {
    const ready = this.refreshWaiters.filter((waiter) => waiter.poll <= poll);
    this.refreshWaiters = this.refreshWaiters.filter((waiter) => waiter.poll > poll);
    for (const waiter of ready) {
      if (!result.ok) waiter.reject(result.error);
      else waiter.resolve(this.current());
    }
  }

  /** Re-arm the interval at a new cadence (relaxed while events are healthy). No-op if unchanged or stopped. */
  setCadence(ms: number): void {
    if (!this.started || ms === this.cadenceMs) return;
    this.cadenceMs = ms;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.poll(), ms);
  }

  /**
   * Fetch the herd, preferring the single `session.snapshot` round-trip. Only an "unknown variant"
   * error (the server predates the method) trips a PERMANENT fallback — and we fall through to the
   * legacy three list calls in the SAME tick so there's no missed poll. Any other failure (timeout,
   * closed socket) is transient: it propagates so the tick fails as before, snapshot mode intact.
   */
  private async fetchWire() {
    if (this.supportsSnapshot) {
      try {
        const snap = await this.herdr.sessionSnapshot();
        return { workspaces: snap.workspaces, panes: snap.panes, tabs: snap.tabs, agents: snap.agents ?? [] };
      } catch (err) {
        if (!(err instanceof Error && err.message.includes("unknown variant"))) throw err;
        this.supportsSnapshot = false;
        console.log("[state] herdr predates session.snapshot — using list-call polling");
      }
    }
    const [workspaces, panes, tabs] = await Promise.all([
      this.herdr.listWorkspaces(),
      this.herdr.listPanes(),
      this.herdr.listTabs(),
    ]);
    // The list calls carry no agent counters; the views simply omit them.
    return { workspaces, panes, tabs, agents: [] };
  }

  private async poll(): Promise<void> {
    // Skip the tick if the previous poll is still running — against a slow Herdr, back-to-back
    // ticks would otherwise stack overlapping in-flight polls.
    if (this.polling) return;
    this.polling = true;
    const poll = ++this.pollNumber;
    const nameEpoch = this.nameEpoch;
    try {
      const { workspaces, panes, tabs, agents: wireAgents } = await this.fetchWire();
      const agentById = new Map(wireAgents.map((a) => [a.pane_id, a]));
      const wsById = new Map(workspaces.map((w) => [w.workspace_id, w]));
      const tabById = new Map(tabs.map((t) => [t.tab_id, t]));
      const terminalByPaneId = new Map(panes.map((p) => [p.pane_id, p.terminal_id]));

      const toView = (
        p: (typeof panes)[number],
        agent: string,
        kind: "agent" | "shell",
      ): AgentView => {
        const ws = wsById.get(p.workspace_id);
        // The tab's label, denormalised alongside workspaceLabel so no client has to join tabs[].
        // Dropped when it's Herdr's positional default in a single-tab space — see meaningfulTabLabel.
        const tabLabel = meaningfulTabLabel(tabById.get(p.tab_id)?.label, ws?.tab_count ?? 0);
        const workspaceLabel = ws?.label ?? p.workspace_id;
        // What the pane says it is doing. Dropped when it only repeats the agent name or the
        // project already on line one — see meaningfulTerminalTitle.
        const terminalTitle = meaningfulTerminalTitle(
          p.terminal_title,
          p.terminal_title_stripped,
          agent,
          workspaceLabel,
        );
        const tokens = allowedTokens(p.tokens);
        const counters = agentById.get(p.pane_id);
        return {
          paneId: p.pane_id,
          workspaceId: p.workspace_id,
          workspaceLabel,
          workspaceNumber: ws?.number ?? 0,
          tabId: p.tab_id,
          agent,
          status: p.agent_status,
          cwd: p.cwd,
          focused: p.focused,
          kind,
          // A user-set pane label (herdr pane.rename); omitted when unset so "absent stays absent".
          ...(typeof p.label === "string" && p.label.length > 0 ? { paneLabel: p.label } : {}),
          ...(tabLabel ? { tabLabel } : {}),
          ...(terminalTitle ? { terminalTitle } : {}),
          // How the agent named its session. BOTH kinds are kept: Claude and Codex report an `id`,
          // while pi reports a `path` (its herdr integration prefers `agent_session_path` whenever
          // the session manager has a file open). Keeping only `id` — as this did until journals
          // became per-agent — silently denied pi any history at all. Which kinds are meaningful is
          // now the adapter's call, not this function's; anything else is omitted, so "no history
          // for this pane" stays simply the field being absent.
          //
          // The ref must also BELONG to the agent currently in the pane. Herdr keeps reporting the
          // last session announced for a pane, so relaunching a pane's agent as a different harness
          // leaves the old one's ref behind — live-observed: a pane running `pi` still advertising
          // `{source:"herdr:claude", kind:"id"}` from the claude that had been there before. Serving
          // that would hand pi's adapter a Claude uuid; harmless today (it resolves to nothing) but
          // only by luck. `agent_session.agent` is compared when Herdr reports it, and absence stays
          // permissive so an older server that omits the field still works.
          ...((p.agent_session?.kind === "id" || p.agent_session?.kind === "path") &&
          typeof p.agent_session.value === "string" &&
          p.agent_session.value !== "" &&
          (typeof p.agent_session.agent !== "string" ||
            p.agent_session.agent === "" ||
            p.agent_session.agent === agent)
            ? { agentSession: { kind: p.agent_session.kind, value: p.agent_session.value } }
            : {}),
          // Scrollback depth + viewport = what a `recent` read can yield. Omitted when the server
          // predates `scroll`, so an older Herdr simply reads as "unknown" rather than "zero".
          ...(p.scroll
            ? { readableLines: p.scroll.max_offset_from_bottom + p.scroll.viewport_rows }
            : {}),
          // Tokens expire unless their plugin refreshes them: absent means unknown, not removed.
          ...(tokens ? { tokens } : {}),
          // Herdr's own transition counters, when the server reports them (0.9.1 has no
          // completion_seq; the list-call fallback has neither).
          ...(typeof counters?.state_change_seq === "number" ? { stateChangeSeq: counters.state_change_seq } : {}),
          ...(typeof counters?.completion_seq === "number" ? { completionSeq: counters.completion_seq } : {}),
        };
      };

      // Narrowing predicate so the agent name is `string` (not `string | null | undefined`) at the
      // map site below — no cast needed.
      const hasAgent = (p: (typeof panes)[number]): p is (typeof panes)[number] & { agent: string } =>
        typeof p.agent === "string" && p.agent.length > 0;

      const agents: AgentView[] = panes
        .filter(hasAgent)
        .map((p) => toView(p, p.agent, "agent"))
        .sort(
          (a, b) =>
            STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
            a.workspaceNumber - b.workspaceNumber ||
            a.paneId.localeCompare(b.paneId),
        );

      // Bare shell panes (no agent), ordered by space then pane so a space's panes read top-down.
      const shellPanes: AgentView[] = panes
        .filter((p) => !p.agent)
        .map((p) => toView(p, "shell", "shell"))
        .sort((a, b) => a.workspaceNumber - b.workspaceNumber || a.paneId.localeCompare(b.paneId));

      const workspaceViews: WorkspaceView[] = workspaces
        .map((w) => ({
          workspaceId: w.workspace_id,
          number: w.number,
          label: w.label,
          focused: w.focused,
          activeTabId: w.active_tab_id,
          tabCount: w.tab_count,
          paneCount: w.pane_count,
        }))
        .sort((a, b) => a.number - b.number);

      const tabViews: TabView[] = tabs.map((t) => ({
        tabId: t.tab_id,
        workspaceId: t.workspace_id,
        number: t.number,
        label: t.label,
        focused: t.focused,
        paneCount: t.pane_count,
      }));

      // Detect transitions against the previous poll. First sighting of a pane never fires a
      // transition (so we don't notify for agents already blocked when the bridge starts).
      for (const a of agents) {
        const prev = this.prevStatus.get(a.paneId);
        if (prev !== undefined && prev !== a.status) {
          for (const fn of this.transitionListeners) fn(a, prev, a.status);
        }
        this.prevStatus.set(a.paneId, a.status);
      }
      const live = new Set(agents.map((a) => a.paneId));
      for (const id of [...this.prevStatus.keys()]) {
        if (live.has(id)) continue;
        this.prevStatus.delete(id);
        this.sessionNames.delete(id); // drop the cached name so a reused pane id starts clean
        for (const fn of this.removeListeners) fn(id);
      }

      const claudeIds = new Set<string>();
      for (const agent of agents) {
        if (agent.agent !== "claude") continue;
        claudeIds.add(agent.paneId);
        const identity = JSON.stringify([
          terminalByPaneId.get(agent.paneId), agent.cwd, agent.agentSession ?? null,
        ]);
        let cached = this.sessionNames.get(agent.paneId);
        if (!cached || cached.identity !== identity) {
          cached = { identity };
          this.sessionNames.set(agent.paneId, cached);
        }
        if (cached.name) agent.sessionName = cached.name;
      }
      for (const id of this.sessionNames.keys()) {
        if (!claudeIds.has(id)) this.sessionNames.delete(id);
      }

      this.agents = agents;
      this.shellPanes = shellPanes;
      this.workspaces = workspaceViews;
      this.tabs = tabViews;
      this.bridge = "connected";
      this.failures = 0;
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;

      // After all transition/removal bookkeeping so listeners see a consistent, current snapshot.
      const snap = this.current();
      for (const fn of this.updateListeners) fn(snap);
      this.settleRefresh(poll, { ok: true });
      if (this.nameEpoch === nameEpoch) this.enrichSessionNames();
    } catch (err) {
      const failures = ++this.failures;
      // A loaded host misses one reply now and then; only a second failure in a row is an outage.
      // Until then the last herd stays connected, so phones don't block the composer on a blip.
      if (this.bridge === "connected") {
        const message = (err as Error).message;
        if (failures < DISCONNECT_AFTER_FAILURES) {
          console.warn(`[state] poll failed, retrying before marking disconnected: ${message}`);
        } else {
          console.warn(`[state] poll failed ${failures} times, marking disconnected: ${message}`);
          this.bridge = "disconnected";
        }
      }
      this.settleRefresh(poll, { ok: false, error: err });
      if (this.started && !this.retryTimer) {
        const delay = Math.min(1000 * 2 ** Math.min(failures - 1, 3), 5000);
        this.retryTimer = setTimeout(() => { this.retryTimer = null; if (this.started) void this.poll(); }, delay);
      }
    } finally {
      this.polling = false;
      // Run the single follow-up an event-poke asked for while this poll was in flight.
      if (this.queuedPoll) {
        this.queuedPoll = false;
        if (this.started || this.refreshWaiters.length > 0) void this.poll();
      }
    }
  }

  /**
   * Read claude panes' visible text and attach the `/rename` session name (see
   * {@link extractClaudeSessionName}) to the view, exactly parallel to `paneLabel`. The name lives
   * only in the pane's rendered text — Herdr's pane metadata doesn't carry it — so this is the one
   * place all panes can pick it up (the web app only holds text for the open pane). A pane is read
   * only when it is new to the cache (new identity), its status moved since the last read, or that
   * read is older than {@link SESSION_NAME_REFRESH_MS}; a quiet herd costs no reads at all. Reads
   * run in parallel within one coalesced batch. A read that fails or times out keeps the last-known name
   * (sticky cache) and never fails the poll. Claude-only; other harnesses never set it. A
   * herdr client without `readPane` (the unit-test fake) short-circuits, so it's a no-op there.
   */
  private enrichSessionNames(): void {
    if (typeof this.herdr.readPane !== "function") return;
    if (this.enrichingNames) {
      this.queuedNames = true;
      return;
    }
    const now = this.now();
    const claude = this.agents.filter((a) => {
      if (a.agent !== "claude") return false;
      const cached = this.sessionNames.get(a.paneId);
      return !cached || cached.readFor !== a.status || cached.readAt === undefined ||
        now - cached.readAt >= SESSION_NAME_REFRESH_MS;
    });
    if (claude.length === 0) return;
    this.enrichingNames = true;
    const epoch = this.nameEpoch;
    void Promise.all(
      claude.map(async (a) => {
        const cached = this.sessionNames.get(a.paneId);
        try {
          // `visible` — never `recent`; see SESSION_NAME_READ_LINES for what a `recent` read does
          // to the operator's screen. The visible grid is also strictly safer to parse: `recent`
          // hands back transcript scrollback, where Claude echoes past user messages as `❯ …` lines
          // that the prompt anchor below would have to discriminate against.
          const read = await this.herdr.readPane(a.paneId, "visible", SESSION_NAME_READ_LINES, "text");
          if (!cached || this.nameEpoch !== epoch || this.sessionNames.get(a.paneId) !== cached) return;
          cached.readFor = a.status;
          cached.readAt = now;
          const name = extractClaudeSessionName(read.text);
          if (name) cached.name = name;
        } catch {
          // Keep whatever's cached (if anything) — a transient read failure must not blank the name,
          // and leaves the pane due so the next poll retries it.
        }
      }),
    ).then(() => {
      if (this.nameEpoch !== epoch) return;
      let changed = false;
      const agents = this.agents.map((agent) => {
        const name = this.sessionNames.get(agent.paneId)?.name;
        if (!name || name === agent.sessionName) return agent;
        changed = true;
        return { ...agent, sessionName: name };
      });
      if (changed) {
        this.agents = agents;
        const snap = this.current();
        for (const fn of this.updateListeners) fn(snap);
      }
    }).catch(() => {
      console.warn("[state] session-name update listener failed");
    }).finally(() => {
      this.enrichingNames = false;
      if (this.queuedNames) {
        this.queuedNames = false;
        this.enrichSessionNames();
      }
    });
  }
}
