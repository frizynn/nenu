import { ClaudeSessions } from "./claude-sessions.ts";
import { CodexTranscriptSource } from "./journal/codex.ts";
import { join } from "node:path";
import { CodexSubagents } from "./subagents-codex.ts";
import { ClaudeSubagents } from "./subagents-claude.ts";
import { computeEtag } from "./http-cache.ts";
import type { AgentView } from "./types.ts";
import type { SubagentsResponse, SubagentHistoryResponse, SubagentView } from "./subagents-types.ts";

export class Subagents {
  private claude: ClaudeSubagents;
  private runtimes = new ClaudeSessions();
  private cache = new Map<string, { expires: number; value: Promise<{ agents: SubagentView[]; truncated: boolean }> }>();
  constructor(roots: { claude: readonly string[]; codex: readonly string[] }, stateDir: string, private codex = new CodexSubagents(undefined, new CodexTranscriptSource(roots.codex))) {
    this.claude = new ClaudeSubagents(roots.claude, join(stateDir, "subagents"));
  }
  async list(pane: AgentView): Promise<SubagentsResponse> {
    if (pane.agent !== "claude" && pane.agent !== "codex") return { available: false, reason: "unsupported" };
    if (pane.agentSession?.kind !== "id") return { available: false, reason: "no-session" };
    const id = pane.agentSession.value;
    const key = JSON.stringify([pane.agent, id]);
    let cache = this.cache.get(key);
    if (!cache || cache.expires <= Date.now()) {
      const value = pane.agent === "codex" ? this.codex.list(id) : this.claudeList(id);
      cache = { expires: Infinity, value };
      if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, cache);
      void value.then(() => {
        const current = this.cache.get(key);
        if (current?.value === value) current.expires = Date.now() + 3000;
      }, () => { if (this.cache.get(key)?.value === value) this.cache.delete(key); });
    }
    return { available: true, sessionKey: computeEtag(key), ...await cache.value };
  }
  private async claudeList(id: string) {
    const owner = (await this.runtimes.list().catch(() => [])).find((runtime) => runtime.sessionId === id);
    let startedAt: number | undefined;
    if (owner?.startedAt) {
      try { process.kill(owner.pid, 0); startedAt = owner.startedAt; } catch { /* The native owner has exited. */ }
    }
    return this.claude.list(id, startedAt);
  }
  async history(pane: AgentView, id: string): Promise<SubagentHistoryResponse> {
    const list = await this.list(pane);
    const agent = list.available ? list.agents.find((a) => a.id === id) : undefined;
    if (!list.available || !agent || pane.agentSession?.kind !== "id") throw new Error("Subagent does not belong to this session.");
    const page = pane.agent === "codex" ? await this.codex.history(agent) : await this.claude.history(pane.agentSession.value, agent);
    return { sessionKey: list.sessionKey, ...page };
  }
}
