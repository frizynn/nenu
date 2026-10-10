import { ConversationBindings } from "./conversation-bindings.ts";
import { computeEtag } from "./http-cache.ts";
import { realpath } from "node:fs/promises";
import { codexRpc, record, type CodexRpc } from "./codex-rpc.ts";
import { CodexHistory } from "./codex-history.ts";
import { ClaudeSessions, matchClaudeSession } from "./claude-sessions.ts";
import { CodexSessions } from "./codex-sessions.ts";
import { isCodexSessionId } from "./journal/codex.ts";
import type { AgentView } from "./types.ts";
import type { HerdrClient } from "./herdr-client.ts";
import type { TranscriptPage } from "./journal/types.ts";

export interface ConversationChoice { id: string; title: string }
type Rpc = Pick<CodexRpc, "request">;
type SessionClient = Pick<HerdrClient, "processInfo">;

type Cached<T> = Map<string, { expires: number; value: Promise<T> }>;

/** Share one read per key for `ttl` ms; a failed read is forgotten at once. At most 16 keys. */
function cached<T>(cache: Cached<T>, key: string, ttl: number, read: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  if (cache.size >= 16) cache.delete(cache.keys().next().value!);
  const value = read();
  cache.set(key, { expires: Date.now() + ttl, value });
  value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key); });
  return value;
}

/** Owns session identity; the existing terminal remains the only input/approval owner. */
export class ConversationService {
  private readonly pages: Cached<Omit<TranscriptPage, "paneId">> = new Map();
  private readonly threads: Cached<Record<string, unknown>> = new Map();
  private readonly lists: Cached<ConversationChoice[]> = new Map();
  private readonly bindings: ConversationBindings;
  private readonly codexSessions: CodexSessions;
  private readonly history: CodexHistory;
  constructor(private readonly codex: Rpc = codexRpc(), private readonly claude = new ClaudeSessions(), stateFile?: string) {
    this.bindings = new ConversationBindings(stateFile);
    this.codexSessions = new CodexSessions(codex);
    this.history = new CodexHistory(codex);
  }

  async resolve(pane: AgentView, herdr: SessionClient, session = "default"): Promise<AgentView> {
    if (pane.agent !== "claude" && pane.agent !== "codex") return pane;
    const key = JSON.stringify([session, pane.paneId]);
    if (pane.agentSession && !this.bindings.has(key)) return pane;
    try {
      const info = await herdr.processInfo(pane.paneId);
      if (!pane.agentSession && pane.agent === "codex") {
        const id = await this.codexSessions.match(pane, info).catch(() => null) ?? explicitSession(info, "codex");
        if (id) {
          if (JSON.stringify(info) !== JSON.stringify(await herdr.processInfo(pane.paneId))) return pane;
          return { ...pane, agentSession: { kind: "id", value: id } };
        }
      }
      const connected = this.bindings.get(key, computeEtag(JSON.stringify(info)), JSON.stringify(pane.agentSession ?? null));
      if (connected) return { ...pane, agentSession: { kind: "id", value: connected } };
      if (pane.agentSession) return pane;
      const explicit = explicitSession(info, pane.agent);
      const id = explicit ?? (pane.agent === "claude" ? matchClaudeSession(info, await this.claude.list()) : null);
      if (id) return { ...pane, agentSession: { kind: "id", value: id } };
    } catch { /* Older installations still work through their SessionStart hook. */ }
    return pane;
  }

  /** thread/list scans the rollout folder (about 0.2 to 3 s measured), so the picker reuses it briefly. */
  async choices(pane: AgentView): Promise<ConversationChoice[]> {
    if (pane.agent !== "codex") return [];
    return cached(this.lists, pane.cwd, 15_000, () => this.list(pane));
  }

  private async list(pane: AgentView): Promise<ConversationChoice[]> {
    const result = record(await this.codex.request("thread/list", { cwd: pane.cwd, limit: 100, sourceKinds: [], sortKey: "updated_at" }));
    if (!Array.isArray(result.data)) throw new Error("Invalid Codex conversation list.");
    return result.data.flatMap((value): ConversationChoice[] => {
      const row = record(value);
      if (typeof row.id !== "string" || !isCodexSessionId(row.id)) return [];
      const title = typeof row.name === "string" && row.name ? row.name : typeof row.preview === "string" && row.preview ? row.preview : "Untitled conversation";
      return [{ id: row.id, title: title.slice(0, 180) }];
    });
  }

  private async thread(pane: AgentView, id: string): Promise<Record<string, unknown>> {
    if (!isCodexSessionId(id)) throw new Error("Invalid conversation id.");
    const thread = record(record(await this.codex.request("thread/read", { threadId: id, includeTurns: false })).thread);
    if (thread.id !== id || typeof thread.cwd !== "string" ||
        await realpath(thread.cwd) !== await realpath(pane.cwd)) throw new Error("This conversation belongs to another directory.");
    return thread;
  }

  async attach(pane: AgentView, id: string, herdr: SessionClient, session = "default"): Promise<void> {
    if (pane.agent !== "codex") throw new Error("Only Codex supports this conversation picker.");
    const before = await herdr.processInfo(pane.paneId);
    await this.thread(pane, id);
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
    return cached(this.pages, JSON.stringify([id, pane.cwd, opts.limit, opts.before ?? null]), 3_000, async () => {
      // Metadata only: the directory check. History comes in pages instead of every turn at once.
      await cached(this.threads, key, 30_000, () => this.thread(pane, id));
      const { entries, hasMore } = await this.history.page(id, opts);
      // The app-server has no cheap count; this is what is known so far.
      return { entries, total: entries.length, hasMore, fileTruncated: false };
    });
  }

  /** The thread changed (a live event): the next read must not be a page cached before it. */
  forget(threadId: string): void {
    const prefix = `${JSON.stringify([threadId]).slice(0, -1)},`;
    for (const key of this.pages.keys()) if (key.startsWith(prefix)) this.pages.delete(key);
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
