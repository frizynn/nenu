import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { record } from "./codex-rpc.ts";
import { sameProcStart } from "./agent-state-sources.ts";
import { processStart, readSmall } from "./agent-state.ts";

/** launchd does not inherit the user's interactive shell PATH, so add the usual user tool folders. */
export function servicePath(path = process.env.PATH, home = homedir()): string {
  return [path, join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(delimiter);
}

export function findClaudeExecutable(path = process.env.PATH, home = homedir()): string | null {
  return Bun.which("claude", { PATH: servicePath(path, home) });
}

/**
 * One row of `claude agents --json`. Interactive sessions carry a `pid` and no `id`; background ones
 * carry the `claude attach` `id` and no `pid`. A row needs one of the two to be matchable.
 */
export interface ClaudeSession { id?: string; sessionId: string; pid?: number; cwd: string; startedAt?: number }

export function decodeClaudeSessions(value: unknown): ClaudeSession[] {
  if (!Array.isArray(value)) throw new Error("Invalid Claude session list.");
  return value.flatMap((raw) => {
    const row = record(raw);
    const id = typeof row.id === "string" ? row.id : undefined;
    const pid = typeof row.pid === "number" ? row.pid : undefined;
    if (typeof row.sessionId !== "string" || typeof row.cwd !== "string" || (id === undefined && pid === undefined)) return [];
    return [{ ...(id !== undefined ? { id } : {}), ...(pid !== undefined ? { pid } : {}), sessionId: row.sessionId, cwd: row.cwd, ...(typeof row.startedAt === "number" && Number.isFinite(row.startedAt) && row.startedAt > 0 ? { startedAt: row.startedAt } : {}) }];
  });
}

/** Match a process or an explicit `claude attach` target. Never guess by cwd or recency. */
export function matchClaudeSession(info: unknown, sessions: ClaudeSession[]): string | null {
  const processes = record(info).foreground_processes;
  if (!Array.isArray(processes)) return null;
  const matches = new Set<string>();
  for (const value of processes) {
    const process = record(value);
    const argv = Array.isArray(process.argv) ? process.argv : [];
    for (const session of sessions) {
      if ((session.pid !== undefined && process.pid === session.pid) || (typeof argv[0] === "string" && argv[0].split("/").at(-1) === "claude" && argv[1] === "attach" && session.id !== undefined && argv[2] === session.id)) matches.add(session.sessionId);
    }
  }
  return matches.size === 1 ? [...matches][0]! : null;
}

/**
 * `claude agents --json` costs ~136 ms of CPU and a 168 MB process (measured). Since nothing but
 * `claude attach` needs it, the bridge asks it only when the session files below found no match.
 */
export class ClaudeSessions {
  private cache: { expires: number; value: Promise<ClaudeSession[]> } | null = null;
  constructor(private readonly ttl = 30_000) {}
  list(): Promise<ClaudeSession[]> {
    if (this.cache && this.cache.expires > Date.now()) return this.cache.value;
    const value = this.read();
    this.cache = { expires: Date.now() + this.ttl, value };
    return value;
  }
  private async read(): Promise<ClaudeSession[]> {
    const executable = findClaudeExecutable();
    if (!executable) throw new Error("Claude executable is unavailable.");
    const child = Bun.spawn([executable, "agents", "--json"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => child.kill(), 4_000);
    try {
      const reader = child.stdout.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > 1024 * 1024) throw new Error("Claude session list is too large.");
        chunks.push(item.value);
      }
      if (await child.exited !== 0) throw new Error("Claude session discovery failed.");
      return decodeClaudeSessions(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }
}

/** `procStart` of a live process: `/proc/<pid>/stat` start ticks on Linux, `ps -o lstart` text elsewhere. */
async function startMatches(pid: number, procStart: string): Promise<boolean> {
  if (/^\d+$/.test(procStart) && process.platform === "linux") {
    // /proc files report size 0, so they are read whole; field 22 follows the parenthesised command.
    const stat = await Bun.file(`/proc/${pid}/stat`).text().catch(() => null);
    return stat === null || stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] === procStart;
  }
  const started = await processStart(pid).catch(() => null);
  return started === null || sameProcStart(procStart, started);
}

/**
 * The interactive sessions Claude itself records in each profile's `sessions/<pid>.json`, kept as
 * `claude agents` keeps them: the pid is alive and, when the file names it, started when the file says.
 */
export class ClaudeSessionFiles {
  private cache: { expires: number; value: Promise<ClaudeSession[]> } | null = null;
  /** A process's start never changes, so each pid's verdict is reused while its file stays. */
  private verified = new Map<string, Promise<boolean>>();
  constructor(private readonly dirs: readonly string[], private readonly matches = startMatches) {}

  list(): Promise<ClaudeSession[]> {
    if (this.cache && this.cache.expires > Date.now()) return this.cache.value;
    const value = this.read();
    this.cache = { expires: Date.now() + 5_000, value };
    return value;
  }

  private async read(): Promise<ClaudeSession[]> {
    const seen = new Set<string>();
    const sessions: ClaudeSession[] = [];
    for (const dir of this.dirs) {
      for (const name of await readdir(dir).catch(() => [])) {
        const match = /^(\d+)\.json$/.exec(name);
        const text = match ? await readSmall(join(dir, name)) : null;
        if (!text) continue;
        let raw: unknown;
        try { raw = JSON.parse(text); } catch { continue; }
        const row = record(raw);
        const [session] = decodeClaudeSessions([row]);
        if (!session || session.pid !== Number(match![1])) continue;
        try { process.kill(session.pid, 0); } catch { continue; }
        const key = `${session.pid}:${typeof row.procStart === "string" ? row.procStart : ""}`;
        seen.add(key);
        if (typeof row.procStart === "string") {
          let verdict = this.verified.get(key);
          if (!verdict) this.verified.set(key, verdict = this.matches(session.pid, row.procStart).catch(() => true));
          if (!(await verdict)) continue;
        }
        sessions.push(session);
      }
    }
    for (const key of this.verified.keys()) if (!seen.has(key)) this.verified.delete(key);
    return sessions;
  }
}
