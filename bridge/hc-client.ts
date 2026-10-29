import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { HerdrClient, type PaneRead, type ReadSource, type ServerInfo, type WireSnapshot } from "./herdr-client.ts";
import { hcAddress, hcMachine, hcProcessInfo, hcSnapshot, type HcAppDoc, type HcTerminal } from "./hc-core.ts";

// herdr-core read only, behind COLLIE_HC_CORE (off by default). A HerdrClient so the session
// runtime, the state engine and the routes take it unchanged; every write refuses.
//
// Each call is one `hc connect`: hello, the request, its reply, exit, the same one-shot shape as
// Herdr's socket. Only events.subscribe keeps its connection.

const READ_ONLY = "herdr-core is read only in Nenu";

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

export class HcClient extends HerdrClient {
  constructor(
    private readonly binary: string,
    private readonly hcTimeoutMs = 5000,
  ) {
    super("hc-core", hcTimeoutMs);
  }

  private async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const child = Bun.spawn([this.binary, "connect"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), this.hcTimeoutMs);
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
  }

  private async terminals(): Promise<{ terminals: HcTerminal[]; machines: Array<{ name: string; state: string }> }> {
    return this.call("terminal.list", {});
  }

  override async sessionSnapshot(): Promise<WireSnapshot> {
    const { terminals, machines } = await this.terminals();
    const docs = new Map<string, HcAppDoc | null>();
    const doc = (on?: string) =>
      this.call<{ value: HcAppDoc | null }>("doc.get", on ? { name: "herdr-app", on } : { name: "herdr-app" })
        .then((r) => r.value, () => null);
    docs.set("", await doc());
    for (const m of machines) if (m.state === "connected") docs.set(m.name, await doc(m.name));
    return hcSnapshot(terminals, docs, claudeSessions(terminals));
  }

  override async listWorkspaces() {
    return (await this.sessionSnapshot()).workspaces;
  }

  override async listPanes() {
    return (await this.sessionSnapshot()).panes;
  }

  override async listTabs() {
    return (await this.sessionSnapshot()).tabs;
  }

  override async serverInfo(): Promise<ServerInfo> {
    const r = await this.call<{ version?: string }>("server.status");
    return { version: r.version ?? "", protocol: 0 };
  }

  override async ping(): Promise<boolean> {
    return this.serverInfo().then(() => true, () => false);
  }

  override async getPane(paneId: string) {
    const pane = (await this.sessionSnapshot()).panes.find((p) => p.pane_id === paneId);
    if (!pane) throw new Error(`herdr pane.get: pane_not_found: ${paneId}`);
    return pane;
  }

  /** hc reads text only: `ansi` gets the same plain text, which the mirror renders uncoloured. */
  override async readPane(paneId: string, source: ReadSource, lines: number): Promise<PaneRead> {
    const r = await this.call<{ text: string; complete: boolean }>("terminal.read", {
      terminal: hcAddress(paneId),
      lines: source === "visible" ? 0 : lines,
    });
    return { pane_id: paneId, text: r.text, truncated: !r.complete, revision: 0 };
  }

  override async processInfo(paneId: string): Promise<unknown> {
    return hcProcessInfo(await this.call<HcTerminal>("terminal.get", { terminal: hcAddress(paneId) }));
  }

  /** Any hc event is a poke; Nenu re-reads the snapshot, as it does for Herdr's. */
  override subscribeEvents(opts: Parameters<HerdrClient["subscribeEvents"]>[0]): { close(): void } {
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

  override async waitForOutput(..._args: unknown[]): Promise<never> {
    throw new Error(READ_ONLY);
  }
  override async createTab(..._args: unknown[]): Promise<never> {
    throw new Error(READ_ONLY);
  }
  override async createWorkspace(..._args: unknown[]): Promise<never> {
    throw new Error(READ_ONLY);
  }
  override async splitTab(..._args: unknown[]): Promise<never> {
    throw new Error(READ_ONLY);
  }
  override async startAgent(..._args: unknown[]): Promise<never> {
    throw new Error(READ_ONLY);
  }
  override async sendPaneText(..._args: unknown[]): Promise<never> {
    throw new Error(READ_ONLY);
  }
  override async sendPaneKeys(..._args: unknown[]): Promise<never> {
    throw new Error(READ_ONLY);
  }
  override async closePane(..._args: unknown[]): Promise<never> {
    throw new Error(READ_ONLY);
  }
  override async renamePane(..._args: unknown[]): Promise<never> {
    throw new Error(READ_ONLY);
  }
  override async renameTab(..._args: unknown[]): Promise<never> {
    throw new Error(READ_ONLY);
  }
  override async closeTab(..._args: unknown[]): Promise<never> {
    throw new Error(READ_ONLY);
  }
  override async moveTab(..._args: unknown[]): Promise<never> {
    throw new Error(READ_ONLY);
  }
}

/**
 * hc reports no agent conversation id. On this machine, Claude Code names it in
 * `~/.claude/sessions/<pid>.json`, keyed by the foreground pid hc does report.
 */
function claudeSessions(terminals: HcTerminal[], dir = join(homedir(), ".claude", "sessions")): Map<string, string> {
  const ids = new Map<string, string>();
  for (const t of terminals) {
    if (hcMachine(t.address) || t.status?.app !== "claude-code" || !t.foreground) continue;
    try {
      const { sessionId } = JSON.parse(readFileSync(join(dir, `${t.foreground.pid}.json`), "utf8")) as { sessionId?: unknown };
      if (typeof sessionId === "string" && sessionId) ids.set(t.address, sessionId);
    } catch {
      /* no file for that pid */
    }
  }
  return ids;
}
