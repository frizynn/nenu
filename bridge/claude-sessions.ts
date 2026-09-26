import { record } from "./codex-rpc.ts";

export interface ClaudeSession { id: string; sessionId: string; pid: number; cwd: string }

export function decodeClaudeSessions(value: unknown): ClaudeSession[] {
  if (!Array.isArray(value)) throw new Error("Invalid Claude session list.");
  return value.flatMap((raw) => {
    const row = record(raw);
    if (typeof row.id !== "string" || typeof row.sessionId !== "string" ||
        typeof row.pid !== "number" || typeof row.cwd !== "string") return [];
    return [{ id: row.id, sessionId: row.sessionId, pid: row.pid, cwd: row.cwd }];
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
      if (process.pid === session.pid || (typeof argv[0] === "string" && argv[0].split("/").at(-1) === "claude" && argv[1] === "attach" && argv[2] === session.id)) matches.add(session.sessionId);
    }
  }
  return matches.size === 1 ? [...matches][0]! : null;
}

export class ClaudeSessions {
  private cache: { expires: number; value: Promise<ClaudeSession[]> } | null = null;
  list(): Promise<ClaudeSession[]> {
    if (this.cache && this.cache.expires > Date.now()) return this.cache.value;
    const value = this.read();
    this.cache = { expires: Date.now() + 5_000, value };
    return value;
  }
  private async read(): Promise<ClaudeSession[]> {
    const child = Bun.spawn(["claude", "agents", "--json"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
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
