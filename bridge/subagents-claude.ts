import { readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { containedRealpath } from "./journal/files.ts";
import { parseClaudeTranscript, isSessionId } from "./journal/claude.ts";
import { SubagentFiles, jsonRows, object, shortText, isAgentId } from "./subagent-files.ts";
import type { SubagentView, SubagentStatus } from "./subagents-types.ts";

const FRESH_MS = 120_000;
interface Location { log: string; directory: string }

export class ClaudeSubagents {
  private files = new SubagentFiles();
  private locations = new Map<string, Location>();
  constructor(private roots: readonly string[], private eventsDir: string, private now = Date.now) {}

  private async locate(sessionId: string): Promise<Location | null> {
    if (!isSessionId(sessionId)) return null;
    const cached = this.locations.get(sessionId);
    if (cached && await containedRealpath(cached.log, cached.directory) === cached.log) return cached;
    for (const root of this.roots) {
      for (const dir of await readdir(root).catch(() => [])) {
        const log = await containedRealpath(join(root, dir, `${sessionId}.jsonl`), root);
        if (!log || !await stat(log).then((s) => s.isFile()).catch(() => false)) continue;
        const location = { log, directory: dirname(log) };
        if (this.locations.size >= 32) this.locations.delete(this.locations.keys().next().value!);
        this.locations.set(sessionId, location);
        return location;
      }
    }
    return null;
  }

  private async childPath(location: Location, sessionId: string, id: string): Promise<string | null> {
    if (!isAgentId(id)) return null;
    const folder = join(location.directory, sessionId, "subagents");
    // Both checks matter: a symlinked subagents directory must not point into another session.
    const directory = await containedRealpath(folder, join(location.directory, sessionId));
    if (!directory || directory !== folder) return null;
    const path = await containedRealpath(join(folder, `agent-${id}.jsonl`), folder);
    return path === join(folder, `agent-${id}.jsonl`) ? path : null;
  }

  async list(sessionId: string): Promise<{ agents: SubagentView[]; truncated: boolean }> {
    const location = await this.locate(sessionId);
    if (!location) return { agents: [], truncated: false };
    const folder = join(location.directory, sessionId, "subagents");
    const names = (await readdir(folder).catch(() => [])).filter((n) => /^agent-[a-zA-Z0-9_-]+\.jsonl$/.test(n));
    const valid = (await Promise.all(names.map(async (name) => {
      const id = name.slice(6, -6);
      const path = await this.childPath(location, sessionId, id);
      const st = path ? await stat(path).catch(() => null) : null;
      return path && st?.isFile() ? { id, path, modified: st.mtimeMs } : null;
    }))).filter((v) => v !== null).sort((a, b) => b.modified - a.modified);
    const parent = await this.files.tail(location.log, 512 * 1024);
    const relations = new Map<string, { parentId: string; task: string; model?: string; status?: SubagentStatus; observedAt?: number }>();
    const learn = (text: string, parentId: string) => {
      for (const row of jsonRows(text)) {
        const result = object(row.toolUseResult);
        const id = shortText(result.agentId);
        if (!isAgentId(id)) continue;
        const previous = relations.get(id);
        const model = shortText(result.resolvedModel);
        relations.set(id, { parentId, observedAt: typeof row.timestamp === "string" ? Date.parse(row.timestamp) : 0, task: shortText(result.description) || previous?.task || "", ...(model ? { model } : previous?.model ? { model: previous.model } : {}),
          ...(result.status === "completed" ? { status: "completed" } : result.status === "failed" ? { status: "failed" } : {}) });
      }
    };
    learn(parent.text, sessionId);
    const rows = await Promise.all(valid.slice(0, 100).map(async (entry) => {
      const tail = await this.files.tail(entry.path, 64 * 1024);
      learn(tail.text, entry.id);
      return { ...entry, tail };
    }));
    const agents: SubagentView[] = [];
    for (const entry of rows) {
      const records = jsonRows(entry.tail.text);
      // Child transcripts must identify themselves as belonging to this root conversation.
      if (!records.some((r) => r.sessionId === sessionId && r.agentId === entry.id)) continue;
      const eventPath = await containedRealpath(join(this.eventsDir, sessionId, `${entry.id}.json`), this.eventsDir);
      let event: Record<string, unknown> = {};
      if (eventPath) {
        try { event = object(JSON.parse((await this.files.tail(eventPath, 4096)).text)); } catch { /* No usable lifecycle signal. */ }
      }
      if (event.sessionId !== sessionId || event.agentId !== entry.id) event = {};
      const relation = relations.get(entry.id);
      const last = records.at(-1);
      const model = records.map((r) => shortText(object(r.message).model)).filter(Boolean).at(-1) || relation?.model;
      const updatedAt = typeof last?.timestamp === "string" && Number.isFinite(Date.parse(last.timestamp)) ? last.timestamp : entry.tail.updatedAt;
      const observed = typeof event.observedAt === "number" ? event.observedAt : 0;
      const age = this.now() - Math.max(observed, Date.parse(updatedAt));
      const fresh = age >= -5000 && age < FRESH_MS;
      const status: SubagentStatus = event.event === "SubagentStop" && observed >= Date.parse(updatedAt) ? "completed"
        : event.event === "SubagentStart" && fresh && observed >= (relation?.observedAt ?? 0) ? "running"
        : relation?.status ?? "unknown";
      agents.push({ id: entry.id, parentId: relation?.parentId ?? sessionId, name: shortText(event.agentType) || "Subagent", task: relation?.task || "", status, updatedAt, ...(model ? { model } : {}) });
    }
    return { agents, truncated: valid.length > rows.length || parent.truncated };
  }

  async history(sessionId: string, agent: SubagentView) {
    const location = await this.locate(sessionId);
    const path = location ? await this.childPath(location, sessionId, agent.id) : null;
    if (!path) throw new Error("Subagent history is unavailable.");
    const tail = await this.files.tail(path, 512 * 1024);
    const rows = jsonRows(tail.text).filter((r) => r.sessionId === sessionId && r.agentId === agent.id);
    const entries = parseClaudeTranscript(rows.map((r) => JSON.stringify(r)).join("\n"), { includeSidechains: true });
    return { agent, entries: entries.slice(-120), truncated: tail.truncated || entries.length > 120 };
  }
}
