import type { SessionTelemetry } from "./types.ts";

type Usage = Omit<SessionTelemetry, "fileTruncated">;
export type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue : {};
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const label = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= 200 ? value : undefined;

function* rows(text: string): Generator<RecordValue> {
  for (const line of text.split("\n")) {
    try { yield record(JSON.parse(line)); } catch { /* A live write or a tail cap may split a row. */ }
  }
}

function timestamp(value: unknown): string | undefined {
  return typeof value === "string" && value.length < 100 && Number.isFinite(Date.parse(value))
    ? value : undefined;
}

function limits(value: unknown): Usage["rateLimits"] {
  const source = record(value);
  const result: NonNullable<Usage["rateLimits"]> = [];
  for (const name of ["primary", "secondary"] as const) {
    const window = record(source[name]);
    const usedPercent = window.used_percent;
    if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) continue;
    result.push({ name, usedPercent, windowMinutes: count(window.window_minutes), resetsAt: count(window.resets_at) });
  }
  return result.length ? result : undefined;
}

/**
 * Codex's counters are provider-reported cumulative totals, not a sum of repeated events. Folded one
 * row at a time so a resumable parser can carry the result across appends; `undefined` until a row
 * reported something.
 */
export function codexUsageRow(row: RecordValue, prev: Usage | undefined): Usage | undefined {
  const p = record(row.payload);
  const result: Usage = prev ?? { source: "journal" };
  let changed = false;
  if (row.type === "turn_context") {
    const model = label(p.model);
    const effort = label(p.effort) ?? label(p.reasoning_effort);
    if (model) {
      // A changed model's old context window is not evidence of the new model's capacity.
      if (result.model && result.model !== model) delete result.context;
      result.model = model;
      result.effort = effort;
      changed = true;
    } else if (effort) {
      result.effort = effort;
      changed = true;
    }
  } else if (row.type === "event_msg" && p.type === "token_count") {
    const info = record(p.info);
    const total = record(info.total_token_usage);
    const tokens: NonNullable<Usage["tokens"]> = {
      scope: "session", input: count(total.input_tokens), output: count(total.output_tokens),
      cachedInput: count(total.cached_input_tokens), total: count(total.total_tokens),
    };
    if ([tokens.input, tokens.output, tokens.cachedInput, tokens.total].some((v) => v !== undefined)) {
      result.tokens = tokens;
      changed = true;
    }
    const last = record(info.last_token_usage);
    const usedTokens = count(last.total_tokens);
    const windowTokens = count(info.model_context_window);
    if (usedTokens !== undefined || (windowTokens !== undefined && windowTokens > 0)) {
      result.context = { usedTokens, windowTokens: windowTokens && windowTokens > 0 ? windowTokens : undefined };
      changed = true;
    }
    if (Object.hasOwn(p, "rate_limits")) {
      result.rateLimits = limits(p.rate_limits);
      if (result.rateLimits) changed = true;
    }
  }
  if (!changed) return prev;
  result.observedAt = timestamp(row.timestamp) ?? result.observedAt;
  return result;
}

export function parseCodexUsage(text: string): Usage | undefined {
  let result: Usage | undefined;
  for (const row of rows(text)) result = codexUsageRow(row, result);
  return result;
}

/** Claude rows can repeat an API message across blocks. Report its latest usage without summing. */
export function claudeUsageRow(row: RecordValue, prev: Usage | undefined): Usage | undefined {
  if (row.type !== "assistant" || row.isSidechain === true) return prev;
  const m = record(row.message);
  const model = label(m.model);
  if (model === "<synthetic>") return prev;
  const usage = record(m.usage);
  const uncached = count(usage.input_tokens);
  const read = count(usage.cache_read_input_tokens);
  const write = count(usage.cache_creation_input_tokens);
  const output = count(usage.output_tokens);
  // Claude input_tokens excludes both cache categories. Missing categories are unknown, not zero.
  const input = uncached !== undefined && read !== undefined && write !== undefined
    ? count(uncached + read + write) : undefined;
  if (!model && input === undefined && output === undefined && read === undefined) return prev;
  const result: Usage = { source: "journal", model, observedAt: timestamp(row.timestamp) };
  if (input !== undefined || output !== undefined || read !== undefined) {
    result.tokens = {
      scope: "last-message", input, output, cachedInput: read,
      total: input !== undefined && output !== undefined ? count(input + output) : undefined,
    };
  }
  if (input !== undefined) result.context = { usedTokens: input };
  return result;
}

export function parseClaudeUsage(text: string): Usage | undefined {
  let result: Usage | undefined;
  for (const row of rows(text)) result = claudeUsageRow(row, result);
  return result;
}
