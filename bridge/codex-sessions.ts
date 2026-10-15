import { basename } from "node:path";
import { realpath } from "node:fs/promises";
import { record, type CodexRpc } from "./codex-rpc.ts";
import { isCodexSessionId } from "./journal/codex.ts";
import { meaningfulTerminalTitle } from "./activity.ts";
import type { AgentView } from "./types.ts";

interface LoadedThread { id: string; cwd: string; name: string; started: boolean }
interface CodexProcess { pid: number; argv: string[] }

/** The pane's Codex conversation, that it has provably not started one, or null when Nenu cannot tell. */
export type CodexIdentity = { id: string } | { notStarted: true } | null;

const ROLLOUT = /^rollout-.+-(.{36})\.jsonl$/;

/**
 * Read-only identity for Codex terminals whose SessionStart hook names no session: it fires only at
 * the first turn, and a client of the shared daemon runs it with the daemon's pane environment.
 * A process running without the daemon holds its own rollout open from its first turn (exact); a
 * daemon client is matched by its live title (ADR 0028). Neither ever chooses by directory or recency.
 */
export class CodexSessions {
  private inventory: Promise<LoadedThread[] | null> | null = null;
  constructor(private readonly rpc: Pick<CodexRpc, "request">, private readonly openFiles: (pids: number[]) => Promise<string[]>) {}

  async identify(pane: AgentView, info: unknown): Promise<CodexIdentity> {
    const codex = codexProcesses(info);
    if (!codex.length || codex.some(({ argv }) => argv.some(arg => arg === "--remote" || arg.startsWith("--remote=")))) return null;
    const title = pane.terminalTitle?.replace(/^[\u2800-\u28ff]\s+/u, "").trim();
    // Codex titles a conversation with the folder alone until it names it, after the first turn.
    const unnamed = title === basename(pane.cwd);
    if (codex.some(({ argv }) => argv.includes("--no-daemon"))) {
      const held = await this.held(codex);
      return held?.length === 1 ? { id: held[0]! } : held?.length === 0 && unnamed ? { notStarted: true } : null;
    }
    const cwd = await realpath(pane.cwd);
    const threads = await this.read();
    const shown = meaningfulTerminalTitle(title, undefined, "codex", "");
    const matches = threads?.filter(thread => thread.cwd === cwd && thread.name && shown === `${thread.name} | ${basename(pane.cwd)}`) ?? [];
    if (matches.length === 1) return { id: matches[0]!.id };
    if (!unnamed) return null;
    // Started while no daemon was running, it holds its rollout like a native one.
    const held = await this.held(codex);
    if (held?.length === 1) return { id: held[0]! };
    // Its conversation is one of the unnamed ones loaded here; none has a turn, so neither has it.
    return held?.length === 0 && threads && !threads.some(thread => thread.cwd === cwd && !thread.name && thread.started) ? { notStarted: true } : null;
  }

  /** Session ids of the rollouts the processes hold open, or null when their files are unreadable. */
  private async held(codex: CodexProcess[]): Promise<string[] | null> {
    const files = await this.openFiles(codex.map(({ pid }) => pid)).catch(() => null);
    return files && [...new Set(files.flatMap(path => {
      const id = ROLLOUT.exec(basename(path))?.[1];
      return id && isCodexSessionId(id) ? [id] : [];
    }))];
  }

  private read(): Promise<LoadedThread[] | null> {
    if (!this.inventory) this.inventory = this.load().catch(() => null).finally(() => { this.inventory = null; });
    return this.inventory;
  }

  private async load(): Promise<LoadedThread[] | null> {
    const result = record(await this.rpc.request("thread/loaded/list", { limit: 100 }));
    // A partial list cannot rule out another loaded conversation with the same name, or a started one.
    if (!Array.isArray(result.data) || result.data.length > 100 || result.nextCursor !== null) return null;
    if (!result.data.every(id => typeof id === "string" && isCodexSessionId(id))) return null;
    const threads: LoadedThread[] = [];
    for (let offset = 0; offset < result.data.length; offset += 8) {
      const batch = await Promise.all(result.data.slice(offset, offset + 8).map(async id => {
        const thread = record(record(await this.rpc.request("thread/read", { threadId: id, includeTurns: false })).thread);
        if (thread.id !== id || typeof thread.cwd !== "string" || thread.parentThreadId) return null;
        const cwd = await realpath(thread.cwd).catch(() => null);
        const name = typeof thread.name === "string" && thread.name.trim() ? thread.name : "";
        // No first message and no turn running. An older protocol without these fields counts as started.
        const idle = typeof thread.status === "object" && thread.status !== null && "type" in thread.status && thread.status.type === "idle";
        return cwd ? { id, cwd, name, started: !(thread.preview === "" && idle) } : null;
      }));
      threads.push(...batch.filter((thread): thread is LoadedThread => thread !== null));
    }
    return threads;
  }
}

/** Foreground processes whose executable is Codex itself, not a wrapper that mentions it. */
function codexProcesses(info: unknown): CodexProcess[] {
  const processes = record(info).foreground_processes;
  if (!Array.isArray(processes)) return [];
  return processes.flatMap(value => {
    const { pid, argv } = record(value);
    return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 && Array.isArray(argv) &&
      argv.every(arg => typeof arg === "string") && basename(String(argv[0])) === "codex" ? [{ pid, argv: argv as string[] }] : [];
  });
}
