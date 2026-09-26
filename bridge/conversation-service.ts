import { ConversationBindings } from "./conversation-bindings.ts";
import { computeEtag } from "./http-cache.ts";
import { realpath } from "node:fs/promises";
import { CodexRpc, record } from "./codex-rpc.ts";
import { codexEntries } from "./codex-history.ts";
import { ClaudeSessions, matchClaudeSession } from "./claude-sessions.ts";
import { pageEntries } from "./journal/store.ts";
import { isCodexSessionId } from "./journal/codex.ts";
import type { AgentView } from "./types.ts";
import type { HerdrClient } from "./herdr-client.ts";
import type { TranscriptPage } from "./journal/types.ts";

export interface ConversationChoice { id: string; title: string }
type Rpc = Pick<CodexRpc, "request">;
type SessionClient = Pick<HerdrClient, "processInfo">;

/** Owns session identity; the existing terminal remains the only input/approval owner. */
export class ConversationService {
  private readonly pages = new Map<string, { expires: number; value: Promise<Record<string, unknown>> }>();
  private readonly bindings: ConversationBindings;
  constructor(private readonly codex: Rpc = new CodexRpc(), private readonly claude = new ClaudeSessions(), stateFile?: string) {
    this.bindings = new ConversationBindings(stateFile);
  }

  async resolve(pane: AgentView, herdr: SessionClient, session = "default"): Promise<AgentView> {
    if (pane.agent !== "claude" && pane.agent !== "codex") return pane;
    const key = JSON.stringify([session, pane.paneId]);
    if (pane.agentSession && !this.bindings.has(key)) return pane;
    try {
      const info = await herdr.processInfo(pane.paneId);
      const connected = this.bindings.get(key, computeEtag(JSON.stringify(info)), JSON.stringify(pane.agentSession ?? null));
      if (connected) return { ...pane, agentSession: { kind: "id", value: connected } };
      if (pane.agentSession) return pane;
      const explicit = explicitSession(info, pane.agent);
      const id = explicit ?? (pane.agent === "claude" ? matchClaudeSession(info, await this.claude.list()) : null);
      if (id) return { ...pane, agentSession: { kind: "id", value: id } };
    } catch { /* Older installations still work through their SessionStart hook. */ }
    return pane;
  }

  async choices(pane: AgentView): Promise<ConversationChoice[]> {
    if (pane.agent !== "codex") return [];
    const result = record(await this.codex.request("thread/list", { cwd: pane.cwd, limit: 100, sourceKinds: [], sortKey: "updated_at" }));
    if (!Array.isArray(result.data)) throw new Error("Invalid Codex conversation list.");
    return result.data.flatMap((value): ConversationChoice[] => {
      const row = record(value);
      if (typeof row.id !== "string" || !isCodexSessionId(row.id)) return [];
      const title = typeof row.name === "string" && row.name ? row.name : typeof row.preview === "string" && row.preview ? row.preview : "Untitled conversation";
      return [{ id: row.id, title: title.slice(0, 180) }];
    });
  }

  private async thread(pane: AgentView, id: string, includeTurns: boolean): Promise<Record<string, unknown>> {
    if (!isCodexSessionId(id)) throw new Error("Invalid conversation id.");
    const thread = record(record(await this.codex.request("thread/read", { threadId: id, includeTurns })).thread);
    if (thread.id !== id || typeof thread.cwd !== "string" ||
        await realpath(thread.cwd) !== await realpath(pane.cwd)) throw new Error("This conversation belongs to another directory.");
    return thread;
  }

  async attach(pane: AgentView, id: string, herdr: SessionClient, session = "default"): Promise<void> {
    if (pane.agent !== "codex") throw new Error("Only Codex supports this conversation picker.");
    const before = await herdr.processInfo(pane.paneId);
    await this.thread(pane, id, false);
    if (JSON.stringify(before) !== JSON.stringify(await herdr.processInfo(pane.paneId)))
      throw new Error("The terminal changed. Check it before connecting history.");
    await this.bindings.set(JSON.stringify([session, pane.paneId]), {
      id, process: computeEtag(JSON.stringify(before)), hook: JSON.stringify(pane.agentSession ?? null),
    });
  }

  async page(pane: AgentView, opts: { limit: number; before?: string }): Promise<Omit<TranscriptPage, "paneId"> | null> {
    if (pane.agent !== "codex" || pane.agentSession?.kind !== "id") return null;
    const id = pane.agentSession.value;
    const key = JSON.stringify([pane.cwd, id]);
    let cached = this.pages.get(key);
    if (!cached || cached.expires <= Date.now()) {
      if (this.pages.size >= 16) this.pages.delete(this.pages.keys().next().value!);
      cached = { expires: Date.now() + 3_000, value: this.thread(pane, id, true) };
      this.pages.set(key, cached);
    }
    const entries = codexEntries(await cached.value);
    const { window, hasMore } = pageEntries(entries, opts);
    return { entries: window, total: entries.length, hasMore, fileTruncated: false };
  }
}

/** Only explicit CLI ids are evidence. Directory and recency cannot identify a terminal. */
export function explicitSession(info: unknown, agent: string): string | null {
  const processes = record(info).foreground_processes;
  if (!Array.isArray(processes)) return null;
  const ids = new Set<string>();
  for (const value of processes) {
    const argv = record(value).argv;
    if (!Array.isArray(argv) || typeof argv[0] !== "string" || argv[0].split("/").at(-1) !== agent) continue;
    const marker = agent === "claude" ? "--session-id" : "resume";
    const index = argv.indexOf(marker);
    if (index < 0) continue;
    // Codex resume accepts flags between the subcommand and the positional id.
    const candidates = agent === "codex" ? argv.slice(index + 1) : [argv[index + 1]];
    for (const id of candidates) if (typeof id === "string" && isCodexSessionId(id)) ids.add(id);
  }
  return ids.size === 1 ? [...ids][0]! : null;
}
