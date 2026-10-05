import { basename } from "node:path";
import { realpath } from "node:fs/promises";
import { record, type CodexRpc } from "./codex-rpc.ts";
import { isCodexSessionId } from "./journal/codex.ts";
import { meaningfulTerminalTitle } from "./activity.ts";
import type { AgentView } from "./types.ts";

interface LoadedThread { id: string; cwd: string; name: string }

/** Read-only recovery for daemon clients whose SessionStart hook lost the pane environment. */
export class CodexSessions {
  private inventory: Promise<LoadedThread[]> | null = null;
  constructor(private readonly rpc: Pick<CodexRpc, "request">) {}

  async match(pane: AgentView, info: unknown): Promise<string | null> {
    const processes = record(info).foreground_processes;
    if (!Array.isArray(processes) || !processes.some(value => {
      const process = record(value);
      return typeof process.pid === "number" && Number.isSafeInteger(process.pid) && process.pid > 0 &&
        Array.isArray(process.argv) && typeof process.argv[0] === "string" && basename(process.argv[0]) === "codex";
    })) return null;
    const title = meaningfulTerminalTitle(pane.terminalTitle?.replace(/^[\u2800-\u28ff]\s+/u, ""), undefined, "codex", "");
    if (!title) return null;
    const cwd = await realpath(pane.cwd);
    const threads = await this.read();
    const matches = threads.filter(thread => thread.cwd === cwd && title === `${thread.name} | ${basename(pane.cwd)}`);
    return matches.length === 1 ? matches[0]!.id : null;
  }

  private read(): Promise<LoadedThread[]> {
    if (!this.inventory) this.inventory = this.load().finally(() => { this.inventory = null; });
    return this.inventory;
  }

  private async load(): Promise<LoadedThread[]> {
    const result = record(await this.rpc.request("thread/loaded/list", { limit: 100 }));
    // A partial list cannot rule out another loaded conversation with the same name.
    if (!Array.isArray(result.data) || result.data.length > 100 || result.nextCursor !== null) return [];
    if (!result.data.every(id => typeof id === "string" && isCodexSessionId(id))) return [];
    const threads: LoadedThread[] = [];
    for (let offset = 0; offset < result.data.length; offset += 8) {
      const batch = await Promise.all(result.data.slice(offset, offset + 8).map(async id => {
        const thread = record(record(await this.rpc.request("thread/read", { threadId: id, includeTurns: false })).thread);
        if (thread.id !== id || typeof thread.cwd !== "string" || typeof thread.name !== "string" ||
            !thread.name.trim() || thread.parentThreadId) return null;
        const cwd = await realpath(thread.cwd).catch(() => null);
        return cwd ? { id, cwd, name: thread.name } : null;
      }));
      threads.push(...batch.filter((thread): thread is LoadedThread => thread !== null));
    }
    return threads;
  }
}
