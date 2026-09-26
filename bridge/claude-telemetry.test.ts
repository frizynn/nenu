import { expect, test } from "bun:test";
import { decodeClaudeStatusline } from "./claude-telemetry.ts";

test("native Claude reports exact context and both quota windows without inferred capacity", () => {
  const value = decodeClaudeStatusline({ session_id: "e6cb30b2-d716-43a3-96b7-0a475f28c9b6", model: { id: "claude-opus-5-5" }, context_window: { context_window_size: 1000000, used_percentage: 40, total_input_tokens: 123, total_output_tokens: 45, current_usage: { input_tokens: 1000, cache_read_input_tokens: 395000, cache_creation_input_tokens: 1000 } }, rate_limits: { five_hour: { used_percentage: 8, resets_at: 1790500000 }, seven_day: { used_percentage: 19, resets_at: 1790800000 } } }, 1790400000000);
  expect(value?.telemetry).toMatchObject({ source: "statusline", model: "claude-opus-5-5", context: { usedTokens: 397000, windowTokens: 1000000, usedPercent: 40 }, rateLimits: [{ name: "primary", usedPercent: 8, windowMinutes: 300, resetsAt: 1790500000 }, { name: "secondary", usedPercent: 19, windowMinutes: 10080 }] });
  expect(decodeClaudeStatusline({ session_id: "../../private" })).toBeUndefined();
});

test("missing, null and invalid native values stay unavailable", () => {
  const value = decodeClaudeStatusline({ session_id: "e6cb30b2-d716-43a3-96b7-0a475f28c9b6", context_window: { used_percentage: null, context_window_size: -1 }, rate_limits: { five_hour: { used_percentage: 101 }, seven_day: { used_percentage: null } } });
  expect(value?.telemetry.context).toBeUndefined();
  expect(value?.telemetry.rateLimits).toBeUndefined();
});
