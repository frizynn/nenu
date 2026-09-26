import { mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { computeEtag } from "./http-cache.ts";
import { isSessionId } from "./journal/claude.ts";
import { containedRealpath } from "./journal/files.ts";
import { object, shortText, SubagentFiles } from "./subagent-files.ts";
import type { SessionTelemetry } from "./journal/types.ts";
import type { AgentView } from "./types.ts";

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
const percent = (value: unknown) => {
  const n = count(value);
  return n !== undefined && n <= 100 ? n : undefined;
};

/** Only provider-reported values; quota and context capacity cannot be inferred from a model name. */
export function decodeClaudeStatusline(input: unknown, now = Date.now()) {
  const row = object(input);
  const sessionId = shortText(row.session_id);
  if (!isSessionId(sessionId)) return undefined;
  const window = object(row.context_window);
  const usage = object(window.current_usage);
  const usedPercent = percent(window.used_percentage);
  const windowTokens = count(window.context_window_size);
  const inputs = [
    usage.input_tokens,
    usage.cache_read_input_tokens,
    usage.cache_creation_input_tokens,
  ].map(count);
  const usedTokens = inputs.some((n) => n !== undefined)
    ? inputs.reduce<number>((sum, n) => sum + (n ?? 0), 0)
    : undefined;
  const inputTokens = count(window.total_input_tokens);
  const outputTokens = count(window.total_output_tokens);
  const limits = object(row.rate_limits);
  const rateLimits: NonNullable<SessionTelemetry["rateLimits"]> = [];
  for (const [field, name, windowMinutes] of [
    ["five_hour", "primary", 300],
    ["seven_day", "secondary", 10080],
  ] as const) {
    const limit = object(limits[field]);
    const usedPercent = percent(limit.used_percentage);
    if (usedPercent === undefined) continue;
    const resetsAt = count(limit.resets_at);
    rateLimits.push({
      name,
      usedPercent,
      windowMinutes,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    });
  }
  const model =
    shortText(object(row.model).id) ||
    shortText(object(row.model).display_name);
  const effort = shortText(object(row.effort).level);
  const telemetry: SessionTelemetry = {
    source: "statusline",
    observedAt: new Date(now).toISOString(),
    fileTruncated: false,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(usedTokens !== undefined ||
    windowTokens !== undefined ||
    usedPercent !== undefined
      ? {
          context: {
            usedTokens,
            windowTokens: windowTokens || undefined,
            usedPercent,
          },
        }
      : {}),
    ...(inputTokens !== undefined || outputTokens !== undefined
      ? {
          tokens: {
            input: inputTokens,
            output: outputTokens,
            ...(inputTokens !== undefined && outputTokens !== undefined
              ? { total: inputTokens + outputTokens }
              : {}),
            scope: "session",
          },
        }
      : {}),
    ...(rateLimits.length ? { rateLimits } : {}),
  };
  return { sessionId, telemetry };
}

/** Save a minimal native-shaped payload so reads use the same validation as stdin. */
export async function recordClaudeStatusline(input: unknown, stateDir: string) {
  const decoded = decodeClaudeStatusline(input);
  if (!decoded) return;
  const { sessionId, telemetry: t } = decoded;
  const payload = {
    session_id: sessionId,
    model: { id: t.model },
    effort: { level: t.effort },
    context_window: {
      used_percentage: t.context?.usedPercent,
      context_window_size: t.context?.windowTokens,
      current_usage: { input_tokens: t.context?.usedTokens },
      total_input_tokens: t.tokens?.input,
      total_output_tokens: t.tokens?.output,
    },
    rate_limits: Object.fromEntries(
      (t.rateLimits ?? []).map((limit) => [
        limit.name === "primary" ? "five_hour" : "seven_day",
        { used_percentage: limit.usedPercent, resets_at: limit.resetsAt },
      ]),
    ),
  };
  const root = join(stateDir, "claude-status");
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (
    (await realpath(root)) !== join(await realpath(stateDir), "claude-status")
  )
    throw new Error("Invalid status directory.");
  const path = join(root, `${sessionId}.json`);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const file = await open(
    temporary,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(JSON.stringify({ observedAt: Date.now(), payload }));
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export class ClaudeTelemetry {
  private files = new SubagentFiles();
  constructor(private stateDir: string) {}
  async read(pane: AgentView | undefined) {
    if (
      pane?.agent !== "claude" ||
      pane.agentSession?.kind !== "id" ||
      !isSessionId(pane.agentSession.value)
    )
      return undefined;
    const id = pane.agentSession.value;
    const stateRoot = await realpath(this.stateDir).catch(() => null);
    if (!stateRoot) return undefined;
    const root = join(stateRoot, "claude-status");
    const path = join(root, `${id}.json`);
    if ((await containedRealpath(path, stateRoot)) !== path) return undefined;
    try {
      const data = await this.files.tail(path, 8192);
      if (data.truncated) return undefined;
      const stored = object(JSON.parse(data.text));
      const observedAt = count(stored.observedAt);
      if (observedAt === undefined || observedAt > Date.now() + 5000)
        return undefined;
      const decoded = decodeClaudeStatusline(stored.payload, observedAt);
      if (decoded?.sessionId !== id) return undefined;
      return {
        sessionKey: computeEtag(JSON.stringify(["claude", id])),
        telemetry: decoded.telemetry,
      };
    } catch {
      return undefined;
    }
  }
}
