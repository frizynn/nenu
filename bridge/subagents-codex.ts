import type { TranscriptSource } from "./journal/types.ts";
import { CodexRpc } from "./codex-rpc.ts";
import { codexEntries } from "./codex-history.ts";
import { object, shortText, isAgentId, SubagentFiles, jsonRows } from "./subagent-files.ts";
import type { SubagentStatus, SubagentView } from "./subagents-types.ts";

interface Rpc { request(method: string, params?: Record<string, unknown>): Promise<unknown> }
export function codexSubagent(row: Record<string, unknown>): SubagentView | null {
  const id = shortText(row.id);
  const parentId = shortText(row.parentThreadId);
  if (!isAgentId(id) || !isAgentId(parentId)) return null;
  const runtime = object(row.status);
  let status: SubagentStatus = "unknown";
  if (runtime.type === "active") status = Array.isArray(runtime.activeFlags) && runtime.activeFlags.some((flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput") ? "waiting" : "running";
  else if (runtime.type === "idle") status = "idle";
  else if (runtime.type === "systemError") status = "failed";
  return { id, parentId, name: shortText(row.agentNickname) || shortText(row.name) || shortText(row.agentRole) || "Subagent", task: shortText(row.preview), status, ...(shortText(row.model) ? { model: shortText(row.model) } : {}),
    ...(typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt) && Math.abs(row.updatedAt) < 8e12 ? { updatedAt: new Date(row.updatedAt * 1000).toISOString() } : {}) };
}

/** A persisted turn can confirm completion even when its native CLI owns another runtime. */
export function codexTurnStatus(turn: Record<string, unknown>, updatedAt: string | undefined, now = Date.now()): SubagentStatus {
  if (turn.status === "completed") return "completed";
  if (turn.status === "failed") return "failed";
  if (turn.status === "interrupted") return "idle";
  const recent = updatedAt ? now - Date.parse(updatedAt) : Infinity;
  return turn.status === "inProgress" && recent >= -5000 && recent < 120_000 ? "running" : "unknown";
}

export function codexJournalState(text: string, now = Date.now()): SubagentStatus | null {
  let state: SubagentStatus | null = null;
  let observed = 0;
  for (const row of jsonRows(text)) {
    if (typeof row.timestamp === "string") observed = Math.max(observed, Date.parse(row.timestamp) || 0);
    if (row.type !== "event_msg") continue;
    const event = object(row.payload);
    if (event.type === "task_started") state = "running";
    else if (event.type === "task_complete") state = "completed";
    else if (event.type === "turn_aborted") state = "idle";
  }
  return state === "running" && (now - observed > 120_000 || observed > now + 5000) ? "unknown" : state;
}

export class CodexSubagents {
  private files = new SubagentFiles();
  private turns = new Map<string, { stamp: string | undefined; status: unknown; expires: number }>();
  constructor(private rpc: Rpc = new CodexRpc(), private source?: TranscriptSource) {}
  async list(parentId: string): Promise<{ agents: SubagentView[]; truncated: boolean }> {
    const candidates: SubagentView[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const response = object(await this.rpc.request("thread/list", { ancestorThreadId: parentId, sourceKinds: ["subAgent", "subAgentThreadSpawn", "subAgentOther"], limit: 100, ...(cursor ? { cursor } : {}) }));
      if (!Array.isArray(response.data)) throw new Error("Invalid subagent list.");
      for (const raw of response.data) { const agent = codexSubagent(object(raw)); if (agent) candidates.push(agent); }
      cursor = typeof response.nextCursor === "string" && response.nextCursor ? response.nextCursor : undefined;
      if (!cursor) break;
    }
    // Check lineage ourselves as well: older servers may ignore an experimental filter.
    const allowed = new Set([parentId]);
    for (let i = 0; i < candidates.length; i++) {
      let changed = false;
      for (const agent of candidates) if (!allowed.has(agent.id) && allowed.has(agent.parentId)) { allowed.add(agent.id); changed = true; }
      if (!changed) break;
    }
    const unique = new Map(candidates.filter((a) => a.id !== parentId && allowed.has(a.id)).map((a) => [a.id, a]));
    const agents = [...unique.values()];
    // Cache terminal states until the thread changes. Bound metadata reads per refresh so a large
    // historical tree cannot start hundreds of RPCs or block the active conversation's reads.
    const refresh: SubagentView[] = [];
    for (const agent of agents) {
      if (agent.status !== "unknown" && agent.status !== "idle") continue;
      if (this.source) {
        try {
          const path = await this.source.resolve({ kind: "id", value: agent.id });
          if (path) {
            const tail = await this.files.tail(path, 64 * 1024);
            const native = codexJournalState(tail.text);
            if (native) { agent.status = native; continue; }
          }
        } catch { /* Fall back to the server's explicit turn metadata. */ }
      }
      const cached = this.turns.get(agent.id);
      if (cached && cached.stamp === agent.updatedAt && cached.expires > Date.now()) {
        agent.status = codexTurnStatus({ status: cached.status }, agent.updatedAt);
      } else if (refresh.length < 16) refresh.push(agent);
    }
    for (let offset = 0; offset < refresh.length; offset += 8) {
      await Promise.all(refresh.slice(offset, offset + 8).map(async (agent) => {
        let turn: Record<string, unknown> = {};
        try {
          const page = object(await this.rpc.request("thread/turns/list", { threadId: agent.id, limit: 1, itemsView: "summary", sortDirection: "desc" }));
          turn = Array.isArray(page.data) ? object(page.data[0]) : {};
          agent.status = codexTurnStatus(turn, agent.updatedAt);
        } catch { /* Older servers may not expose paginated turn metadata. */ }
        if (this.turns.size >= 512) this.turns.delete(this.turns.keys().next().value!);
        this.turns.set(agent.id, { stamp: agent.updatedAt, status: turn.status,
          expires: ["completed", "failed", "interrupted"].includes(String(turn.status)) ? Infinity : Date.now() + 12_000 });
      }));
    }
    return { agents, truncated: !!cursor };
  }
  async history(agent: SubagentView) {
    const thread = object(object(await this.rpc.request("thread/read", { threadId: agent.id, includeTurns: true })).thread);
    if (thread.id !== agent.id || thread.parentThreadId !== agent.parentId) throw new Error("Subagent no longer belongs to this session.");
    const entries = codexEntries(thread);
    const model = shortText(thread.model);
    return { agent: { ...agent, ...(model ? { model } : {}) }, entries: entries.slice(-120), truncated: entries.length > 120 };
  }
}
