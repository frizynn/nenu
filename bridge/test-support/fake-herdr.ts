import type { Socket, UnixSocketListener } from "bun";
import { rmSync } from "node:fs";

import type { AgentStatus } from "../types.ts";

// A Herdr server double on a real Unix socket, speaking the same newline-delimited JSON as
// HERDR_API.md: one request per connection, except `events.subscribe`, which stays open. The real
// bridge (bridge/index.ts) runs against it unchanged through HERDR_SOCKET_PATH, so e2e runs and
// baselines exercise the production socket client, poll loop and write paths.
//
// It counts every call by method and logs each write, which is how a test proves "no unexpected
// writes" and how baselines count socket calls per poll. Panes render a Claude-shaped screen (the
// rule / `❯ draft` / rule composer the guarded reply verifies) that ticks while `working`, echoes
// typed text after `echoMs`, and can show a dialog that swallows text and is answered by keys. A pane
// with no agent is a shell instead: its prompt, or nothing while a command holds the terminal.

export type FakeAgent = "claude" | "codex" | "pi" | null;

export interface FakePaneInit {
  paneId: string;
  workspaceId: string;
  tabId: string;
  agent: FakeAgent;
  status?: AgentStatus;
  cwd?: string;
  label?: string;
  /** Claude-style session id, surfaced as `agent_session` so the bridge can find a journal. */
  sessionId?: string;
  /** Transcript lines above the composer. */
  lines?: string[];
}

interface FakePane extends Required<Omit<FakePaneInit, "label" | "sessionId">> {
  label?: string;
  sessionId?: string;
  draft: string;
  /** Dialog text shown instead of the composer; keys answer it, text is swallowed. */
  dialog: string | null;
  /** `[Image #N]` tokens drawn so far, numbered per session as Claude does. */
  images: number;
  /** A shell's foreground command; null while the shell sits at its prompt. */
  foreground: string | null;
  revision: number;
  workingSince: number;
}

export interface FakeCall {
  method: string;
  params: Record<string, unknown>;
  at: number;
}

export interface FakeHerdrOptions {
  socketPath: string;
  version?: string;
  protocol?: number;
  /** Delay before typed text appears in the composer, like a TUI repaint. */
  echoMs?: number;
  /** How often a working pane repaints its spinner line. */
  tickMs?: number;
  /** Rows returned by a `visible` read. */
  viewportRows?: number;
}

const READ_METHODS = new Set(["session.snapshot", "workspace.list", "tab.list", "pane.list", "pane.read", "pane.get", "pane.process_info", "pane.wait_for_output", "events.subscribe", "ping"]);
const RULE = "─".repeat(72);
const SHELL_PROMPT = "user@host:~/demo$ ";
const SPINNER = ["✻", "✶", "✳", "✢", "·"];

export class FakeHerdr {
  readonly socketPath: string;
  readonly version: string;
  readonly protocol: number;
  private readonly echoMs: number;
  private readonly tickMs: number;
  private readonly viewportRows: number;
  private readonly panes = new Map<string, FakePane>();
  private readonly workspaceLabels = new Map<string, string>();
  private readonly tabLabels = new Map<string, string>();
  /** Tabs in Herdr's array order, which `tab.move` changes, and in the order they were made, which
   *  numbers them: Herdr keeps a tab's `number` through a move (HERDR_API.md "Move methods"). */
  private readonly tabOrder: string[] = [];
  private readonly tabsMade: string[] = [];
  private readonly subscribers = new Set<{ socket: Socket<unknown>; types: Set<string>; panes: Set<string> }>();
  private readonly counters = new Map<string, number>();
  private readonly pending = new Map<Socket<unknown>, string>();
  /** A reply's bytes the socket has not taken yet; a Unix socket takes about 8 KiB per write on macOS. */
  private readonly outbox = new Map<Socket<unknown>, Buffer>();
  private listener: UnixSocketListener<unknown> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  /** Every call, in order. Reads included, so a window can be sliced by time. */
  readonly calls: FakeCall[] = [];
  /** Messages submitted with Enter on a composer, and dialog answers. */
  readonly submitted: Array<{ paneId: string; text: string; at: number }> = [];
  readonly answered: Array<{ paneId: string; key: string; at: number }> = [];
  /** Escape presses that reached a working composer. */
  readonly interrupted: Array<{ paneId: string; at: number }> = [];
  /** How long a working pane takes to go idle after Escape (measured on Claude 2.1.296: ~300 ms). */
  interruptMs = 0;
  /** Panes whose statusline is the operator's own: Claude then never prints "esc to interrupt". */
  readonly customStatusline = new Set<string>();
  /** `pane.process_info` foreground processes per pane; none by default. */
  readonly processes = new Map<string, Array<{ pid: number; argv: string[] }>>();
  /** `agent.start` calls Herdr accepted, with the argv the agent got. */
  readonly started: Array<{ paneId: string; kind: string; args: string[]; at: number }> = [];
  /** Fails the next `agent.start` and leaves the shell at its prompt, as an agent that never comes up
   *  does (Herdr 0.9.3: `timeout`, "timed out waiting for agent startup"). */
  failNextStart: { code: string; message: string } | null = null;
  /** How long every one-shot reply waits, like a Herdr on a loaded host. The subscribe ack does not. */
  replyDelayMs = 0;
  /** Subscriptions dropped because their socket would not take a whole event. */
  droppedStreams = 0;

  constructor(opts: FakeHerdrOptions) {
    this.socketPath = opts.socketPath;
    this.version = opts.version ?? "0.9.1-fake";
    this.protocol = opts.protocol ?? 22;
    this.echoMs = opts.echoMs ?? 30;
    this.tickMs = opts.tickMs ?? 250;
    this.viewportRows = opts.viewportRows ?? 40;
  }

  addWorkspace(workspaceId: string, label: string): this {
    this.workspaceLabels.set(workspaceId, label);
    return this;
  }

  addTab(tabId: string, label: string): this {
    this.tabLabels.set(tabId, label);
    this.noteTab(tabId);
    return this;
  }

  addPane(init: FakePaneInit): this {
    this.noteTab(init.tabId);
    this.panes.set(init.paneId, {
      status: "idle", cwd: "/tmp", lines: [], ...init,
      draft: "", dialog: null, images: 0, foreground: null, revision: 1, workingSince: Date.now(),
    });
    return this;
  }

  async start(): Promise<void> {
    rmSync(this.socketPath, { force: true });
    this.listener = Bun.listen<unknown>({
      unix: this.socketPath,
      socket: {
        data: (socket, chunk) => {
          // One request per connection, so a connection's first complete line is all there is. A
          // large send_text can arrive in several chunks.
          const buf = (this.pending.get(socket) ?? "") + chunk.toString("utf8");
          const nl = buf.indexOf("\n");
          if (nl < 0) return void this.pending.set(socket, buf);
          this.pending.delete(socket);
          this.handle(socket, buf.slice(0, nl));
        },
        drain: (socket) => this.flush(socket),
        close: (socket) => {
          this.pending.delete(socket);
          this.outbox.delete(socket);
          for (const sub of this.subscribers) if (sub.socket === socket) this.subscribers.delete(sub);
        },
      },
    });
    this.ticker = setInterval(() => {
      for (const pane of this.panes.values()) if (pane.status === "working" && !pane.dialog) pane.revision++;
    }, this.tickMs);
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    for (const sub of this.subscribers) sub.socket.end();
    this.subscribers.clear();
    this.listener?.stop(true);
    this.listener = null;
    rmSync(this.socketPath, { force: true });
  }

  /** Calls per method since the last reset. */
  counts(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }

  /** Clears the counters only: `calls` stays the whole run's log, so `writes()` misses nothing. */
  resetCounts(): void {
    this.counters.clear();
  }

  /** Calls that would change Herdr or a terminal: anything that is not a read or a subscription. */
  writes(): FakeCall[] {
    return this.calls.filter((c) => !READ_METHODS.has(c.method));
  }

  setStatus(paneId: string, status: AgentStatus): void {
    const pane = this.pane(paneId);
    if (pane.status === status) return;
    pane.status = status;
    if (status === "working") pane.workingSince = Date.now();
    pane.revision++;
    this.emit("pane.agent_status_changed", "pane_agent_status_changed", pane, { agent_status: status });
  }

  /** Put a dialog on screen (the pane reads `blocked`) or clear it with null. */
  /** Moves a pane to another folder, as a `cd` in its shell would. */
  setCwd(paneId: string, cwd: string): void {
    const pane = this.panes.get(paneId);
    if (pane) pane.cwd = cwd;
  }

  setDialog(paneId: string, text: string | null): void {
    const pane = this.pane(paneId);
    pane.dialog = text;
    pane.revision++;
    this.setStatus(paneId, text ? "blocked" : "idle");
  }

  /** Close a tab and every pane in it, as `tab.close` does; also how a test closes one "in Herdr". */
  closeTab(tabId: string): void {
    const panes = [...this.panes.values()].filter((p) => p.tabId === tabId);
    if (panes.length === 0) throw new FakeError("tab_not_found", `tab ${tabId} not found`);
    for (const pane of panes) this.panes.delete(pane.paneId);
    this.broadcast("tab.closed", "tab_closed", { tab_id: tabId, workspace_id: panes[0]!.workspaceId });
  }

  /**
   * Reorder a tab within its workspace, as `tab.move` does: `insertIndex` counts the workspace's tabs
   * before this one is taken out, so its own index or the next is a no-op, and past the count is an
   * error (Herdr 0.9.3; HERDR_API.md "Move methods").
   */
  moveTab(tabId: string, insertIndex: number): void {
    const workspaceId = [...this.panes.values()].find((p) => p.tabId === tabId)?.workspaceId;
    if (!workspaceId) throw new FakeError("tab_not_found", `tab ${tabId} not found`);
    const inWorkspace = (id: string) => [...this.panes.values()].some((p) => p.tabId === id && p.workspaceId === workspaceId);
    const slots = this.tabOrder.flatMap((id, i) => (inWorkspace(id) ? [i] : []));
    const order = slots.map((i) => this.tabOrder[i]!);
    const from = order.indexOf(tabId);
    const gap = Math.trunc(insertIndex);
    if (!(gap >= 0 && gap <= order.length)) throw new FakeError("tab_move_failed", `insert_index ${insertIndex} is out of bounds`);
    order.splice(from, 1);
    order.splice(gap > from ? gap - 1 : gap, 0, tabId);
    slots.forEach((slot, i) => { this.tabOrder[slot] = order[i]!; });
    this.broadcast("tab.moved", "tab_moved", { tab_id: tabId, workspace_id: workspaceId, insert_index: insertIndex });
  }

  /** Close one pane, as `pane.close` does. Tabs are derived from panes, so an emptied tab goes too. */
  closePane(paneId: string): void {
    const pane = this.pane(paneId);
    this.panes.delete(paneId);
    this.broadcast("pane.closed", "pane_closed", { pane_id: paneId, workspace_id: pane.workspaceId });
  }

  /**
   * Put a command in a shell's foreground, or null to return it to its prompt. Only the process
   * changes: the screen moves with `appendLines`, as a command's own output would move it.
   */
  setForeground(paneId: string, command: string | null): void {
    this.pane(paneId).foreground = command;
  }

  appendLines(paneId: string, ...lines: string[]): void {
    const pane = this.pane(paneId);
    pane.lines.push(...lines);
    pane.revision++;
  }

  screen(paneId: string): string {
    const pane = this.pane(paneId);
    if (pane.agent === null) return [...pane.lines, ...(pane.foreground ? [] : [`${SHELL_PROMPT}${pane.draft}`])].join("\n");
    const body = [...pane.lines, ""];
    if (pane.dialog) return [...body, RULE, pane.dialog].join("\n");
    const working = pane.status === "working";
    if (working) {
      const elapsed = Math.floor((Date.now() - pane.workingSince) / 1000);
      body.push(`${SPINNER[pane.revision % SPINNER.length]} Working… (${elapsed}s · ↓ 12 tokens)`, "");
    }
    // Claude 2.1.296 names the interrupt key in the statusline while a turn runs, and drops it while
    // the box holds a draft.
    if (this.customStatusline.has(paneId)) return [...body, RULE, `❯ ${pane.draft}`, RULE, "  [custom-sl] opus", "  ⏵⏵ auto mode on · ← for agents"].join("\n");
    const hint = working && !pane.draft ? " · esc to interrupt" : "";
    return [...body, RULE, `❯ ${pane.draft}`, RULE, "  Opus 5.5 | Context 13% used", `  ⏵⏵ auto mode on${hint} · ← for agents`].join("\n");
  }

  private pane(paneId: string): FakePane {
    const pane = this.panes.get(paneId);
    if (!pane) throw new FakeError("pane_not_found", `pane ${paneId} not found`);
    return pane;
  }

  private handle(socket: Socket<unknown>, line: string): void {
    let id = "";
    try {
      const req = JSON.parse(line) as { id?: unknown; method?: unknown; params?: Record<string, unknown> };
      if (typeof req.id !== "string" || typeof req.method !== "string") throw new FakeError("invalid_request", "invalid request");
      id = req.id;
      const params = req.params ?? {};
      this.counters.set(req.method, (this.counters.get(req.method) ?? 0) + 1);
      this.calls.push({ method: req.method, params, at: Date.now() });
      if (req.method === "events.subscribe") return this.subscribe(socket, id, params);
      if (req.method === "pane.wait_for_output") return this.waitForOutput(socket, id, params);
      this.later(socket, JSON.stringify({ id, result: this.dispatch(req.method, params) }) + "\n");
    } catch (err) {
      const e = err instanceof FakeError ? err : new FakeError("internal", (err as Error).message);
      this.later(socket, JSON.stringify({ id, error: { code: e.code, message: e.message } }) + "\n");
    }
  }

  private later(socket: Socket<unknown>, line: string): void {
    if (this.replyDelayMs <= 0) return this.reply(socket, line);
    setTimeout(() => this.reply(socket, line), this.replyDelayMs);
  }

  /** The one reply a connection gets, then the close; what the socket refuses now goes out on drain. */
  private reply(socket: Socket<unknown>, line: string): void {
    this.outbox.set(socket, Buffer.from(line));
    this.flush(socket);
  }

  private flush(socket: Socket<unknown>): void {
    const rest = this.outbox.get(socket);
    if (!rest) return;
    const written = Math.max(0, socket.write(rest));
    if (written < rest.length) return void this.outbox.set(socket, rest.subarray(written));
    this.outbox.delete(socket);
    socket.end();
  }

  private dispatch(method: string, params: Record<string, unknown>): Record<string, unknown> {
    const paneId = String(params.pane_id ?? "");
    switch (method) {
      case "ping":
        return { type: "pong", version: this.version, protocol: this.protocol };
      case "session.snapshot":
        return { type: "session_snapshot", snapshot: { version: this.version, protocol: this.protocol, ...this.lists() } };
      case "workspace.list":
        return { type: "workspace_list", workspaces: this.lists().workspaces };
      case "tab.list":
        return { type: "tab_list", tabs: this.lists().tabs };
      case "pane.list":
        return { type: "pane_list", panes: this.lists().panes };
      case "pane.get":
        return { type: "pane_info", pane: this.wirePane(this.pane(paneId)) };
      case "pane.read":
        return { type: "pane_read", read: this.read(paneId, String(params.source), Number(params.lines) || this.viewportRows) };
      case "pane.process_info":
        return { type: "process_info", process_info: this.processInfo(paneId) };
      case "agent.start":
        return this.startAgent(paneId, String(params.kind ?? ""), Array.isArray(params.args) ? params.args.map(String) : []);
      case "pane.send_text":
        this.typeText(paneId, String(params.text ?? ""));
        return { type: "ok" };
      case "pane.send_keys":
        for (const key of (params.keys as unknown[]) ?? []) this.pressKey(paneId, String(key));
        return { type: "ok" };
      case "pane.close":
        this.closePane(paneId);
        return { type: "ok" };
      case "tab.close":
        this.closeTab(String(params.tab_id ?? ""));
        return { type: "ok" };
      case "tab.move":
        this.moveTab(String(params.tab_id ?? ""), Number(params.insert_index));
        return { type: "tab_list", tabs: this.lists().tabs };
      default:
        throw new FakeError("invalid_request", `invalid request: unknown variant \`${method}\``);
    }
  }

  /**
   * Herdr waits server-side until a read matches, line by line on the stripped text, and answers
   * with that read; a miss ends at `timeout_ms` with the code `timeout`. Rust's leading inline flags
   * (`(?m)`) become JavaScript flags, which is all the bridge's trigger pattern uses.
   */
  private waitForOutput(socket: Socket<unknown>, id: string, params: Record<string, unknown>): void {
    const reply = (body: Record<string, unknown>) => this.reply(socket, JSON.stringify({ id, ...body }) + "\n");
    const fail = (e: FakeError) => reply({ error: { code: e.code, message: e.message } });
    const paneId = String(params.pane_id ?? "");
    const match = (params.match ?? {}) as { type?: string; value?: string };
    const value = String(match.value ?? "");
    let test: (line: string) => boolean;
    if (match.type === "regex") {
      const [, flags = "", body] = /^(?:\(\?([a-z]+)\))?([\s\S]*)$/.exec(value)!;
      try {
        const re = new RegExp(body!, flags.replace(/[^imsu]/g, ""));
        test = (line) => re.test(line);
      } catch (err) {
        return fail(new FakeError("invalid_regex", (err as Error).message));
      }
    } else {
      test = (line) => line.includes(value);
    }
    const deadline = Date.now() + (Number(params.timeout_ms) || 0);
    const look = () => {
      try {
        const read = this.read(paneId, String(params.source), Number(params.lines) || this.viewportRows);
        const line = read.text.split("\n").find(test);
        if (line !== undefined) return reply({ result: { type: "output_matched", pane_id: paneId, matched_line: line, read, revision: 0 } });
        if (Date.now() >= deadline) return fail(new FakeError("timeout", "timed out waiting for output match"));
        setTimeout(look, 5);
      } catch (err) {
        fail(err instanceof FakeError ? err : new FakeError("internal", (err as Error).message));
      }
    };
    look();
  }

  private read(paneId: string, source: string, lines: number): { pane_id: string; text: string; truncated: boolean; revision: number } {
    const pane = this.pane(paneId);
    const rows = this.screen(paneId).split("\n");
    const take = source === "visible" ? this.viewportRows : lines;
    return { pane_id: paneId, text: rows.slice(-take).join("\n"), truncated: false, revision: pane.revision };
  }

  private typeText(paneId: string, raw: string): void {
    const pane = this.pane(paneId);
    if (pane.dialog) return; // a focused dialog swallows typed text, as Claude's does
    const text = raw.replace(/\x1b\[20[01]~/g, "");
    // An agent attaches a picture pasted alone and draws its token a beat later than typed text
    // shows, as Claude Code does (ADR 0104): text sent on its heels would land first.
    if (pane.agent !== null && /^\x1b\[200~\/\S+\.(?:png|jpe?g|gif|webp)\x1b\[201~$/i.test(raw)) {
      setTimeout(() => {
        pane.draft += `[Image #${++pane.images}]`;
        pane.revision++;
      }, this.echoMs * 4);
      return;
    }
    setTimeout(() => {
      pane.draft += text;
      pane.revision++;
    }, this.echoMs);
  }

  private pressKey(paneId: string, key: string): void {
    const pane = this.pane(paneId);
    const now = Date.now();
    if (pane.dialog) {
      if (key === "Enter" || /^[0-9]$/.test(key) || key === "Escape") {
        this.answered.push({ paneId, key, at: now });
        this.setDialog(paneId, null);
      }
      return;
    }
    if (key === "Enter") {
      if (!pane.draft) return;
      this.submitted.push({ paneId, text: pane.draft, at: now });
      pane.lines.push(pane.agent === null ? `${SHELL_PROMPT}${pane.draft}` : `❯ ${pane.draft}`);
      pane.draft = "";
      pane.revision++;
    } else if (key === "Backspace") {
      pane.draft = pane.draft.slice(0, -1);
      pane.revision++;
    } else if (key === "ctrl+u") {
      pane.draft = "";
      pane.revision++;
    } else if (key === "Escape" && pane.status === "working") {
      this.interrupted.push({ paneId, at: now });
      setTimeout(() => {
        if (this.panes.get(paneId) !== pane) return;
        pane.lines.push("  ⎿  Interrupted · What should Claude do instead?");
        this.setStatus(paneId, "idle");
      }, this.interruptMs);
    }
  }

  private subscribe(socket: Socket<unknown>, id: string, params: Record<string, unknown>): void {
    const subs = Array.isArray(params.subscriptions) ? (params.subscriptions as Array<{ type?: string; pane_id?: string }>) : [];
    const sub = { socket, types: new Set<string>(), panes: new Set<string>() };
    for (const s of subs) {
      if (s.type) sub.types.add(s.type);
      if (s.pane_id) sub.panes.add(`${s.type}@${s.pane_id}`);
    }
    this.subscribers.add(sub);
    socket.write(JSON.stringify({ id, result: { type: "subscription_started" } }) + "\n");
  }

  private emit(type: string, event: string, pane: FakePane, extra: Record<string, unknown>): void {
    const line = JSON.stringify({ event, data: { type: event, pane_id: pane.paneId, workspace_id: pane.workspaceId, ...extra } }) + "\n";
    for (const sub of this.subscribers) {
      if (sub.panes.has(`${type}@${pane.paneId}`) || (sub.types.has(type) && ![...sub.panes].some((p) => p.startsWith(`${type}@`)))) {
        this.send(sub, line);
      }
    }
  }

  /** A global event to everyone subscribed to its type, as `emit` does for pane-scoped ones. */
  private broadcast(type: string, event: string, data: Record<string, unknown>): void {
    const line = JSON.stringify({ event, data: { type: event, ...data } }) + "\n";
    for (const sub of this.subscribers) if (sub.types.has(type)) this.send(sub, line);
  }

  /** A global event that carries a whole pane record, as `pane.updated` does on protocol 22. */
  touchPane(paneId: string): void {
    this.broadcast("pane.updated", "pane_updated", { pane: this.wirePane(this.pane(paneId)) });
  }

  /**
   * Herdr 0.9.3 writes events without waiting for the socket: when the reader is behind and the
   * write would block, it logs `Resource temporarily unavailable (os error 35)` and closes the
   * stream (live-observed). A short write here does the same.
   */
  private send(sub: { socket: Socket<unknown> }, line: string): void {
    const bytes = Buffer.from(line);
    if (sub.socket.write(bytes) >= bytes.length) return;
    this.droppedStreams++;
    for (const s of this.subscribers) if (s.socket === sub.socket) this.subscribers.delete(s);
    sub.socket.end();
  }

  /**
   * A shell's process group holds the terminal at its prompt, and a command's group takes it while it
   * runs (measured on Herdr 0.9.3: `shell_pid` equals `foreground_process_group_id` only at the prompt).
   * An agent pane reports what `processes` lists for it.
   */
  private processInfo(paneId: string): Record<string, unknown> {
    const pane = this.pane(paneId);
    const listed = this.processes.get(paneId);
    if (pane.agent !== null || listed) return { pane_id: paneId, foreground_processes: listed ?? [] };
    const shellPid = 4000 + [...this.panes.keys()].indexOf(paneId) * 10;
    const group = pane.foreground ? shellPid + 1 : shellPid;
    return {
      pane_id: paneId, shell_pid: shellPid, foreground_process_group_id: group,
      foreground_processes: [{ pid: group, name: pane.foreground ?? "zsh" }],
    };
  }

  /** Herdr launches only into a shell at its prompt, and answers anything else with its own refusal. */
  private startAgent(paneId: string, kind: string, args: string[]): Record<string, unknown> {
    const pane = this.pane(paneId);
    if (pane.agent !== null || pane.foreground) throw new FakeError("agent_pane_busy", `agent target pane ${paneId} is not an available shell`);
    if (kind !== "claude" && kind !== "codex") throw new FakeError("invalid_request", `unsupported agent kind ${kind}`);
    const failure = this.failNextStart;
    this.failNextStart = null;
    if (failure) throw new FakeError(failure.code, failure.message);
    this.started.push({ paneId, kind, args, at: Date.now() });
    pane.agent = kind;
    pane.lines = [];
    pane.revision++;
    this.setStatus(paneId, "idle");
    return { type: "ok" };
  }

  private wirePane(pane: FakePane) {
    return {
      pane_id: pane.paneId,
      terminal_id: `t-${pane.paneId}`,
      workspace_id: pane.workspaceId,
      tab_id: pane.tabId,
      focused: false,
      cwd: pane.cwd,
      agent: pane.agent,
      agent_status: pane.status,
      revision: pane.revision,
      ...(pane.label ? { label: pane.label } : {}),
      ...(pane.sessionId ? { agent_session: { source: "herdr", agent: pane.agent ?? undefined, kind: "id", value: pane.sessionId } } : {}),
      scroll: { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: this.viewportRows },
    };
  }

  private noteTab(tabId: string): void {
    if (this.tabsMade.includes(tabId)) return;
    this.tabsMade.push(tabId);
    this.tabOrder.push(tabId);
  }

  private lists() {
    const panes = [...this.panes.values()];
    const rollup = (group: FakePane[]): AgentStatus =>
      (["blocked", "working", "done", "idle"] as const).find((s) => group.some((p) => p.status === s)) ?? "unknown";
    const workspaceOf = (tabId: string) => panes.find((p) => p.tabId === tabId)?.workspaceId;
    const open = this.tabOrder.filter((tabId) => workspaceOf(tabId) !== undefined);
    const tabs = open.map((tabId) => {
      const group = panes.filter((p) => p.tabId === tabId);
      const workspaceId = group[0]!.workspaceId;
      const number = this.tabsMade.filter((id) => workspaceOf(id) === workspaceId).indexOf(tabId) + 1;
      // An unlabelled tab reads as its position, as Herdr's does.
      const position = open.filter((id) => workspaceOf(id) === workspaceId).indexOf(tabId) + 1;
      return {
        tab_id: tabId, workspace_id: workspaceId, number, label: this.tabLabels.get(tabId) ?? String(position),
        focused: false, pane_count: group.length, agent_status: rollup(group),
      };
    });
    const workspaces = [...new Set(panes.map((p) => p.workspaceId))].map((workspaceId, i) => {
      const group = panes.filter((p) => p.workspaceId === workspaceId);
      return {
        workspace_id: workspaceId, number: i + 1, label: this.workspaceLabels.get(workspaceId) ?? workspaceId,
        focused: i === 0, pane_count: group.length, tab_count: new Set(group.map((p) => p.tabId)).size,
        active_tab_id: group[0]!.tabId, agent_status: rollup(group),
      };
    });
    return { workspaces, tabs, panes: panes.map((p) => this.wirePane(p)) };
  }
}

class FakeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
