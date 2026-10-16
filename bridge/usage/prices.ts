/**
 * What tokens would cost on the API at list price, in USD per million tokens. Nenu shows this as an
 * API-equivalent figure, not a bill: Claude and ChatGPT plans are flat-rate. The scan stores tokens
 * only, so a price change here needs no rescan.
 *
 * Anthropic: https://platform.claude.com/docs/en/about-claude/pricing, read 2026-10-16.
 *   Fast mode (Opus 5.5, Opus 5, Opus 4.8) doubles input and output, and the cache multipliers apply
 *   on top. Haiku 5.5 prices a request whose prompt (input + cache reads + writes) is over 100,000
 *   tokens at the higher tier; the scan marks those requests `+long`.
 * OpenAI: https://developers.openai.com/api/docs/pricing, read 2026-10-16. Codex reports cached input
 *   (priced as the cache read) and no cache-write split. `codex-auto-review` is not on the page: priced
 *   as gpt-5.6-luna, as ccusage does.
 */
export const PRICES_CHECKED = "2026-10-16";

/** [input, cache write 5 min, cache write 1 h, cache read, output] */
type Rates = readonly [number, number, number, number, number];

const PRICES: Readonly<Record<string, Rates>> = {
  "claude-fable-5-1": [10, 12.5, 20, 0.25, 50],
  "claude-mythos-5-1": [10, 12.5, 20, 0.25, 50],
  "claude-fable-5": [10, 12.5, 20, 1, 50],
  "claude-mythos-5": [10, 12.5, 20, 1, 50],
  "claude-opus-5-5": [4, 5, 8, 0.2, 20],
  "claude-opus-5": [5, 6.25, 10, 0.5, 25],
  "claude-opus-4-8": [5, 6.25, 10, 0.5, 25],
  "claude-opus-4-7": [5, 6.25, 10, 0.5, 25],
  "claude-opus-4-6": [5, 6.25, 10, 0.5, 25],
  "claude-opus-4-5": [5, 6.25, 10, 0.5, 25],
  "claude-opus-4-1": [15, 18.75, 30, 1.5, 75],
  "claude-opus-4": [15, 18.75, 30, 1.5, 75],
  "claude-sonnet-5-5": [2, 2.5, 4, 0.1, 10],
  "claude-sonnet-5": [2, 2.5, 4, 0.2, 10],
  "claude-sonnet-4-6": [3, 3.75, 6, 0.3, 15],
  "claude-sonnet-4-5": [3, 3.75, 6, 0.3, 15],
  "claude-sonnet-4": [3, 3.75, 6, 0.3, 15],
  "claude-haiku-5-5": [0.1, 0.125, 0.2, 0.01, 0.5],
  "claude-haiku-5-5+long": [0.5, 0.625, 1, 0.05, 2.5],
  "claude-haiku-4-5": [1, 1.25, 2, 0.1, 5],
  "claude-haiku-3-5": [0.8, 1, 1.6, 0.08, 4],
  "gpt-6.1-sol": [2, 2.5, 2.5, 0.1, 10],
  "gpt-6-luna": [0.1, 0.125, 0.125, 0.01, 0.5],
  "gpt-5.6-luna": [0.2, 0.25, 0.25, 0.02, 1.2],
  "gpt-5.6-sol": [4, 5, 5, 0.4, 20],
  "codex-auto-review": [0.2, 0.25, 0.25, 0.02, 1.2],
};

const FAST = new Set(["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]);

/** A dated id (`claude-haiku-4-5-20251001`, also `…+long`) prices as its family. */
function rates(model: string): { rates: Rates; factor: number } | undefined {
  const [, family, tier] = /^(.+?)(?:-\d{8})?(\+fast|\+long)?$/.exec(model)!;
  const found = PRICES[tier === "+long" ? `${family}+long` : family!];
  if (!found) return undefined;
  return { rates: found, factor: tier === "+fast" && FAST.has(family!) ? 2 : 1 };
}

/** The token columns a day's total keeps, in the order the scan writes them. */
export const COLUMNS = ["rows", "input", "output", "cacheWrite5m", "cacheWrite1h", "cacheRead", "reasoning"] as const;
export type Columns = number[];

/** USD for one total; `undefined` when the model has no price, so the caller can say so. */
export function costOf(model: string, v: Columns): number | undefined {
  const r = rates(model);
  if (!r) return undefined;
  const [input, write5m, write1h, read, output] = r.rates;
  return r.factor * (v[1]! * input + v[3]! * write5m + v[4]! * write1h + v[5]! * read + v[2]! * output) / 1e6;
}

/** "claude-opus-5-5+fast" → "Opus 5.5 · fast"; unknown ids pass through. */
export function modelLabel(model: string): string {
  const fast = model.endsWith("+fast");
  const long = model.endsWith("+long");
  const base = fast || long ? model.slice(0, -5) : model;
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d))?(?:-\d{8})?$/.exec(base);
  const gpt = /^gpt-([\d.]+)(?:-([a-z]+))?$/.exec(base);
  let label = base;
  if (claude) label = `${claude[1]![0]!.toUpperCase()}${claude[1]!.slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  else if (gpt) label = `GPT-${gpt[1]}${gpt[2] ? ` ${gpt[2][0]!.toUpperCase()}${gpt[2].slice(1)}` : ""}`;
  else if (base === "codex-auto-review") label = "Auto review";
  return fast ? `${label} · fast` : long ? `${label} · long prompt` : label;
}
