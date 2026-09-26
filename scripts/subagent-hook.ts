import { mkdir, realpath, rename, open } from "node:fs/promises";
import { constants } from "node:fs";
import { join, sep } from "node:path";
import { isSessionId } from "../bridge/journal/claude.ts";
import { isAgentId, object, shortText } from "../bridge/subagent-files.ts";

/** Only lifecycle metadata is persisted. Prompts, messages and tool inputs never leave stdin. */
export async function recordSubagentEvent(input: unknown, stateDir: string): Promise<void> {
  const row = object(input);
  const sessionId = shortText(row.session_id);
  const agentId = shortText(row.agent_id);
  if (!isSessionId(sessionId) || !isAgentId(agentId) || !["SubagentStart", "SubagentStop"].includes(shortText(row.hook_event_name))) return;
  const root = join(stateDir, "subagents");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = join(root, sessionId);
  await mkdir(directory, { mode: 0o700 }).catch((e: unknown) => { if (object(e).code !== "EEXIST") throw e; });
  if (!(await realpath(directory)).startsWith(await realpath(root) + sep)) throw new Error("Invalid subagent state directory.");
  const path = join(directory, `${agentId}.json`);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify({ sessionId, agentId, agentType: shortText(row.agent_type), event: row.hook_event_name, observedAt: Date.now() })); }
  finally { await file.close(); }
  await rename(temporary, path);
}

if (import.meta.main) {
  try {
    const stateDir = process.argv[2];
    if (!stateDir) throw new Error("State directory is required.");
    const reader = Bun.stdin.stream().getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1024 * 1024) { await reader.cancel(); throw new Error("Hook payload exceeds limit."); }
      chunks.push(value);
    }
    await recordSubagentEvent(JSON.parse(Buffer.concat(chunks).toString("utf8")), stateDir);
  } catch { /* Observability must never block or fail an agent's tool execution. */ }
}
