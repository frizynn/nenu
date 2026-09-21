// The browser and bridge must agree on which cells belong to Codex's ambient animation.
// These are pure SGR/grammar modules; sharing them avoids weaker server-side text heuristics.
import { parseAnsi } from "../web/src/lib/ansi.ts";
import { lineText, splitLines } from "../web/src/lib/blocks.ts";
import { animatedComposerRegion } from "../web/src/lib/harness/codex/chrome.ts";

/**
 * Normalize a rendered prompt region for comparison across terminal redraws.
 *
 * A terminal redraw can append trailing padding or change blank-line layout without changing the
 * question, so trailing whitespace and blank lines are ignored. Leading indentation and internal
 * alignment must survive because they can be semantic content in a displayed diff or command.
 */
const SGR_SEQUENCE = /(?:\x1b\[|\x9b)[0-?]*[ -/]*m/g;

export function normalizePromptRegion(text: string): string[] {
  return text
    .replace(SGR_SEQUENCE, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.length > 0);
}

// Across all 20 committed fixture regions, at most one normalized line follows a match. Six lines
// leave generous headroom for a status or spinner update while ensuring a replacement prompt, whose
// regions span 20 to 32 normalized lines, pushes a stale match outside the accepted tail.
export const DEFAULT_PROMPT_TAIL_LINES = 6;

export type PromptBindingResult =
  | { ok: true }
  | { ok: false; reason: "empty" | "not_found" | "not_in_tail" };

export function verifyExpectedPrompt(
  freshText: string,
  expected: string,
  tailLines = DEFAULT_PROMPT_TAIL_LINES,
): PromptBindingResult {
  const freshLines = normalizePromptRegion(freshText);
  const expectedLines = normalizePromptRegion(expected);
  if (expectedLines.length === 0) return { ok: false, reason: "empty" };

  let lastMatch = -1;
  candidate: for (let start = 0; start <= freshLines.length - expectedLines.length; start++) {
    for (let offset = 0; offset < expectedLines.length; offset++) {
      if (freshLines[start + offset] !== expectedLines[offset]) continue candidate;
    }
    lastMatch = start;
  }
  const boundedTailLines = Math.max(0, Math.floor(tailLines));
  const tailStart = Math.max(0, freshLines.length - boundedTailLines);
  const matchEnd = lastMatch + expectedLines.length - 1;
  if (lastMatch !== -1 && matchEnd >= tailStart) return { ok: true };

  // A particle may move between the phone's read and this local read. Only the recognized live
  // Codex composer may shed that decoration; user text, dialogs and transcript rows stay exact.
  const styled = expectedLines[0]?.startsWith("› ") ? splitLines(parseAnsi(freshText)) : null;
  const canonical = styled === null ? null : animatedComposerRegion(styled);
  if (canonical !== null && styled !== null) {
    const canonicalLines = normalizePromptRegion(canonical.prompt);
    if (
      canonicalLines.length === expectedLines.length &&
      canonicalLines.every((line, index) => line === expectedLines[index])
    ) {
      const after = normalizePromptRegion(styled.slice(canonical.endRow + 1).map(lineText).join("\n")).length;
      return after < boundedTailLines
        ? { ok: true }
        : { ok: false, reason: "not_in_tail" };
    }
  }
  return { ok: false, reason: lastMatch === -1 ? "not_found" : "not_in_tail" };
}
