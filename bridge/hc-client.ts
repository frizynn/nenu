import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type { GuardedSendResult, SendTrace } from "./guarded-send.ts";
import type { CreatedShell, HerdrApi, PaneRead, ReadSource, ServerInfo, WireSnapshot } from "./herdr-client.ts";
import type { SendRequest } from "./types.ts";
import {
  hcAddress, hcAtShell, hcClaudeSession, hcKey, hcNewId, hcPaneId, hcPlacement, hcShellLine, hcSpace, hcMachine, hcProcessInfo, hcSnapshot, isSubmitKey, unbracket, type HcAppDoc, type HcTerminal, type SessionFileReader,
} from "./hc-core.ts";

// herdr-core behind COLLIE_HC_CORE (off by default). It implements HerdrApi, so the session runtime,
// the state engine and the routes take it unchanged. Reads, keys, a chat's send (hcSend below), new
// spaces, tabs and agents map; closing, renaming and moving refuse.
//
// hc has no "type without Enter": `terminal.send` pastes and submits in one call. So text typed
// through sendPaneText waits here, per pane, and goes with the submit key that follows it. A path that
// reads the screen to see its text in the box before Enter never sees it and stops before Enter.
//
// Each call is one `hc connect`: hello, the request, its reply, exit, the same one-shot shape as
// Herdr's socket. Only events.subscribe keeps its connection.

const READ_ONLY = "Nenu cannot do this on herdr-core yet: it closes, renames and moves only Herdr panes and tabs";
/** Typed text not followed by its Enter within this long is dropped, never sent later. */
const PENDING_MS = 20_000;
/** How long a read with history may take before the screen alone answers instead. */
const HISTORY_READ_MS = 2500;
/** `terminal.send` waits for ~3 s of quiet, then for the program to start working. */
const SEND_TIMEOUT_MS = 20_000;

export type HcRpc = <T>(method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<T>;

/** `hc`: COLLIE_HC_BIN, else on PATH, else where hc installs itself. */
export function hcBinary(env: Record<string, string | undefined> = process.env, home = homedir()): string | null {
  if (env.COLLIE_HC_BIN) return env.COLLIE_HC_BIN;
  const onPath = Bun.which("hc", { PATH: env.PATH ?? "" });
  if (onPath) return onPath;
  const installed = join(home, ".local", "bin", "hc");
  return existsSync(installed) ? installed : null;
}

let rpcId = 0;
const line = (method: string, params: Record<string, unknown>) =>
  JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) + "\n";
const HELLO = () => line("hello", { generation: 1 });

/** Read newline-delimited JSON from a stream, one parsed object per call to `next`. */
function lines(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  return {
    async next(): Promise<Record<string, unknown> | null> {
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl >= 0) {
          const text = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (text.trim()) return JSON.parse(text) as Record<string, unknown>;
          continue;
        }
        const { value, done } = await reader.read();
        if (done) return null;
        buf += decoder.decode(value, { stream: true });
      }
    },
  };
}

export class HcClient implements HerdrApi {
  constructor(
    private readonly binary: string,
    private readonly hcTimeoutMs = 5000,
    rpc?: HcRpc,
    private readonly now: () => number = Date.now,
    private readonly group: (pgid: number) => Promise<number[]> = localGroup,
    private readonly claudeSessionDir = join(homedir(), ".claude", "sessions"),
  ) {
    if (rpc) this.call = rpc;
  }

  private readonly pending = new Map<string, { text: string; at: number }>();
  /** The panes the last snapshot named as agents: their screen is read without history. */
  private agentPanes = new Set<string>();

  private call: HcRpc = async <T>(method: string, params: Record<string, unknown> = {}, timeoutMs = this.hcTimeoutMs): Promise<T> => {
    const child = Bun.spawn([this.binary, "connect"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    try {
      child.stdin.write(HELLO() + line(method, params));
      await child.stdin.flush();
      const replies = lines(child.stdout);
      const hello = await replies.next();
      if (!hello || hello.error) throw new Error(`hc hello: ${JSON.stringify(hello?.error ?? "no reply")}`);
      const reply = await replies.next();
      if (!reply) throw new Error(`hc ${method}: connection closed before reply`);
      if (reply.error) throw new Error(`hc ${method}: ${JSON.stringify(reply.error)}`);
      return reply.result as T;
    } finally {
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
    }
  };

  private async terminals(): Promise<{ terminals: HcTerminal[]; machines?: Array<{ name: string; state: string }> }> {
    return this.call<{ terminals: HcTerminal[]; machines?: Array<{ name: string; state: string }> }>("terminal.list", {});
  }

  async sessionSnapshot(): Promise<WireSnapshot> {
    const { terminals, machines } = await this.terminals();
    const docs = new Map<string, HcAppDoc | null>();
    const doc = (on?: string) =>
      this.call<{ value: HcAppDoc | null }>("doc.get", on ? { name: "herdr-app", on } : { name: "herdr-app" })
        .then((r) => r.value, () => null);
    docs.set("", await doc());
    for (const m of machines ?? []) if (m.state === "connected") docs.set(m.name, await doc(m.name));
    const snapshot = hcSnapshot(terminals, docs, await this.claudeSessions(terminals));
    this.agentPanes = new Set(snapshot.panes.filter((p) => p.agent).map((p) => p.pane_id));
    return snapshot;
  }

  /**
   * Each Claude terminal's conversation id. Here: its session file under ~/.claude/sessions for any
   * process of the foreground group. On another machine: the leader's file there, read through hc's
   * file.read (hc lists no process group remotely, so a wrapper hides the id there).
   */
  private async claudeSessions(terminals: HcTerminal[]): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    await Promise.all(terminals.map(async (t) => {
      const machine = hcMachine(t.address);
      const read: SessionFileReader = machine
        ? (pid) => this.call<{ text: string }>("file.read", { path: `.claude/sessions/${pid}.json`, on: machine }).then((r) => r.text)
        : async (pid) => readFileSync(join(this.claudeSessionDir, `${pid}.json`), "utf8");
      const id = await hcClaudeSession(t, read, machine || !t.foreground ? [] : await this.group(t.foreground.pid));
      if (id) ids.set(t.address, id);
    }));
    return ids;
  }

  async listWorkspaces() {
    return (await this.sessionSnapshot()).workspaces;
  }

  async listPanes() {
    return (await this.sessionSnapshot()).panes;
  }

  async listTabs() {
    return (await this.sessionSnapshot()).tabs;
  }

  async serverInfo(): Promise<ServerInfo> {
    const r = await this.call<{ version?: string }>("server.status", {});
    return { version: r.version ?? "", protocol: 0 };
  }

  async ping(): Promise<boolean> {
    return this.serverInfo().then(() => true, () => false);
  }

  async getPane(paneId: string) {
    const pane = (await this.sessionSnapshot()).panes.find((p) => p.pane_id === paneId);
    if (!pane) throw new Error(`herdr pane.get: pane_not_found: ${paneId}`);
    return pane;
  }

  /**
   * hc reads text only: `ansi` gets the same plain text, which the mirror renders uncoloured.
   *
   * An agent's screen is read without history. hc reads a full-screen program's history by scrolling
   * it ("stitched"), and on hc 0.1.13 that read never answers while Claude shows a permission dialog,
   * and leaves the terminal refusing keys after it (measured on an isolated core). An agent's history
   * is its journal anyway. A shell's history is read, with a short budget and the screen as fallback.
   */
  async readPane(paneId: string, source: ReadSource, lines: number): Promise<PaneRead> {
    const terminal = hcAddress(paneId);
    const read = (n: number, timeoutMs?: number) =>
      this.call<{ text: string; complete: boolean }>("terminal.read", { terminal, lines: n }, timeoutMs);
    const wantsHistory = source !== "visible" && lines > 0 && !this.agentPanes.has(paneId);
    const history = wantsHistory ? await read(lines, HISTORY_READ_MS).catch(() => null) : null;
    const r = history ?? (await read(0));
    return { pane_id: paneId, text: r.text, truncated: !r.complete || (wantsHistory && !history), revision: 0 };
  }

  async processInfo(paneId: string): Promise<unknown> {
    const t = await this.call<HcTerminal>("terminal.get", { terminal: hcAddress(paneId) });
    return hcProcessInfo(t, hcMachine(t.address) || !t.foreground ? [] : await this.group(t.foreground.pid));
  }

  /** Any hc event is a poke; Nenu re-reads the snapshot, as it does for Herdr's. */
  subscribeEvents(opts: Parameters<HerdrApi["subscribeEvents"]>[0]): { close(): void } {
    const child = Bun.spawn([this.binary, "connect"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    let down = false;
    const fireDown = (reason: string) => {
      if (down) return;
      down = true;
      try {
        child.kill();
      } catch {
        /* gone */
      }
      opts.onDown(reason);
    };
    child.stdin.write(HELLO() + line("events.subscribe", {}));
    void child.stdin.flush();
    void (async () => {
      const replies = lines(child.stdout);
      try {
        if (!(await replies.next())) return fireDown("hc closed");
        const ack = await replies.next();
        if (!ack || ack.error) return fireDown(`hc events.subscribe: ${JSON.stringify(ack?.error ?? "no reply")}`);
        opts.onUp();
        for (;;) {
          const msg = await replies.next();
          if (!msg) return fireDown("connection closed");
          if (msg.method === "event" || msg.method === "missed") opts.onEvent("hc_event", msg.params);
        }
      } catch (err) {
        fireDown((err as Error).message);
      }
    })();
    return { close: () => fireDown("closed") };
  }

  /** One message, pasted and submitted by hc itself: `terminal.send`. */
  async sendMessage(paneId: string, text: string): Promise<{ started?: boolean | null; status?: string | null; turn: number }> {
    return this.call("terminal.send", { terminal: hcAddress(paneId), text: unbracket(text) }, SEND_TIMEOUT_MS);
  }

  /** Held until its submit key: hc cannot type without submitting. */
  async sendPaneText(paneId: string, text: string): Promise<void> {
    const held = this.held(paneId);
    this.pending.set(paneId, { text: (held ?? "") + unbracket(text), at: this.now() });
  }

  /**
   * The submit key sends the held text as one `terminal.send` (paste + Enter); keys after it, or any
   * keys with nothing held, go as `terminal.keys`. Keys other than a submit drop held text: it was
   * never typed, so whatever they were meant to edit is not there.
   */
  async sendPaneKeys(paneId: string, keys: string[]): Promise<void> {
    const terminal = hcAddress(paneId);
    const held = this.held(paneId);
    this.pending.delete(paneId);
    let rest = keys;
    if (held !== null && keys.length > 0 && isSubmitKey(keys[0]!)) {
      await this.call("terminal.send", { terminal, text: held }, SEND_TIMEOUT_MS);
      rest = keys.slice(1);
    }
    if (rest.length) await this.call("terminal.keys", { terminal, keys: rest.map(hcKey) }, SEND_TIMEOUT_MS);
  }

  private held(paneId: string): string | null {
    const held = this.pending.get(paneId);
    if (!held || this.now() - held.at > PENDING_MS) return null;
    return held.text;
  }

  async waitForOutput(..._args: unknown[]): Promise<never> {
    throw new Error(READ_ONLY);
  }
  /** A new shell in its own new space, placed the way Herdr.app places one. */
  async createWorkspace(opts: { cwd: string; label?: string }): Promise<CreatedShell> {
    const space = hcNewId("sp");
    const tab = hcNewId("tb");
    const label = opts.label?.trim() || basename(opts.cwd) || opts.cwd;
    const shell = await this.run("", opts.cwd, hcPlacement(space, tab, `${label} / 1`));
    return { ...shell, workspaceLabel: label };
  }

  /** A new shell in a new tab of a space; with no folder asked, the space's first terminal's folder. */
  async createTab(workspaceId: string, opts: { label?: string; cwd?: string } = {}): Promise<CreatedShell> {
    const snapshot = await this.sessionSnapshot();
    const ws = snapshot.workspaces.find((w) => w.workspace_id === workspaceId);
    const first = snapshot.panes.find((p) => p.workspace_id === workspaceId);
    if (!ws || !first) throw new Error("That workspace is gone.");
    const { machine, space } = hcSpace(workspaceId);
    const where = `${ws.label} / ${opts.label?.trim() || ws.tab_count + 1}`;
    return this.run(machine, opts.cwd || first.cwd, hcPlacement(space, hcNewId("tb"), where));
  }

  /** A new shell in the tab `paneId` sits in, in its folder unless another is asked. */
  async splitTab(paneId: string, opts: { cwd?: string } = {}): Promise<CreatedShell> {
    const t = await this.call<HcTerminal>("terminal.get", { terminal: hcAddress(paneId) });
    const { "herdr.space": space, "herdr.tab": tab, where } = t.labels ?? {};
    const labels = space && tab ? hcPlacement(space, tab, where ?? "") : {};
    return this.run(hcMachine(t.address), opts.cwd || t.cwd, labels);
  }

  /**
   * Types the agent's command line into a shell at rest, as one terminal.send. Herdr refuses a busy
   * foreground atomically; hc has no such check, so the shell is looked at just before, and the
   * window between that look and the paste is hc's quiet rule (~3 s with nobody typing).
   */
  async startAgent(paneId: string, kind: "codex" | "claude", args: string[] = []): Promise<void> {
    const terminal = hcAddress(paneId);
    const t = await this.call<HcTerminal>("terminal.get", { terminal });
    if (!hcAtShell(t)) throw new Error("That terminal is not at a shell prompt.");
    await this.call("terminal.send", { terminal, text: hcShellLine([kind, ...args]) }, SEND_TIMEOUT_MS);
  }

  private async run(machine: string, cwd: string, labels: Record<string, string>): Promise<CreatedShell> {
    const r = await this.call<HcTerminal>("terminal.run", { cwd, labels, no_parent: true, ...(machine ? { on: machine } : {}) });
    const address = machine && !r.address.includes("/") ? `${machine}/${r.address}` : r.address;
    const pane = hcSnapshot([{ ...r, address, state: "live" }], new Map()).panes[0]!;
    return { paneId: hcPaneId(address), workspaceId: pane.workspace_id, tabId: pane.tab_id, cwd: r.cwd };
  }
  async closePane(..._args: unknown[]): Promise<never> {
    throw new Error(READ_ONLY);
  }
  async renamePane(..._args: unknown[]): Promise<never> {
    throw new Error(READ_ONLY);
  }
  async renameTab(..._args: unknown[]): Promise<never> {
    throw new Error(READ_ONLY);
  }
  async closeTab(..._args: unknown[]): Promise<never> {
    throw new Error(READ_ONLY);
  }
  async moveTab(..._args: unknown[]): Promise<never> {
    throw new Error(READ_ONLY);
  }
}

/** The pids of a local process group, from `pgrep -g` (none when it cannot tell). */
async function localGroup(pgid: number): Promise<number[]> {
  const child = Bun.spawn(["pgrep", "-g", String(pgid)], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return code === 0 ? out.split("\n").map(Number).filter((n) => Number.isSafeInteger(n) && n > 0) : [];
}

/**
 * Nenu's chat send on herdr-core. hc types nothing until Enter, so the screen can never show the text
 * in the box first (guarded-send.ts's witness): hc's own send is the whole step. It waits for the
 * terminal to be quiet, refuses a blocked program, pastes and presses Enter, and says whether the turn
 * started. A retry of a request id that already reached hc types nothing.
 */
export async function hcSend(hc: Pick<HcClient, "sendMessage">, paneId: string, request: SendRequest, prior?: Pick<SendTrace, "typeAttempted">, now = Date.now): Promise<GuardedSendResult> {
  const trace: SendTrace = { phase: "type", preflight: "skipped", attempts: [], typeAttempted: true, noEcho: false, draft: null, screen: null, unverified: true, typedAt: now() };
  const fail = (error: string, textDelivered: boolean, code?: "not_ready"): GuardedSendResult => ({
    outcome: { ok: false, requestId: request.requestId, stage: "type", error, textDelivered, ...(code ? { code } : {}) },
    trace,
  });
  if (prior?.typeAttempted) return fail("An earlier try of this message reached herdr-core and may have been sent. Nothing was typed; check Terminal.", true);
  try {
    await hc.sendMessage(paneId, request.text);
  } catch (err) {
    const blocked = /"kind":"blocked"/.test((err as Error).message);
    // Any other failure may have come after hc typed: say so rather than invite a duplicate.
    return blocked
      ? fail("The agent is waiting on a question or permission, so herdr-core typed nothing. Answer it first.", false, "not_ready")
      : fail(`herdr-core send failed: ${(err as Error).message}`, true);
  }
  trace.phase = "confirm";
  return { outcome: { ok: true, requestId: request.requestId, ack: "submitted" }, trace };
}
