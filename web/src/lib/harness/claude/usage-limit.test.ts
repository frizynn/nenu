import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines } from "../../blocks";
import { extractInputDraft, hasInputBox } from "./chrome";
import { claudeAdapter } from "./index";

// Claude 2.1.306 at its usage limit, as the operator's phone send saw it on 2026-10-21 (the audit
// line's screen, ADR 0118). The pause prints "esc to cancel" under a live box: Escape cancels the
// automatic continue, the box still takes typing, and Enter submits (Claude logged the message 13 s
// after Nenu typed it). Reading that hint as a dialog refused the send, then hid the typed text.
const FIXTURES = join(import.meta.dirname, "fixtures");
const load = (name: string) => splitLines(parseAnsi(readFileSync(join(FIXTURES, name), "utf8")));

describe("Claude at its usage limit", () => {
  it("keeps its input box ready under the automatic-continue notice", () => {
    const lines = load("usage-limit-v2306.txt");
    expect(hasInputBox(lines)).toBe(true);
    expect(claudeAdapter.composerReady?.(lines)).toBe(true);
    expect(extractInputDraft(lines)).toBeNull();
  });

  it("reads back what was typed into that box, where it read nothing before", () => {
    const lines = load("usage-limit-typed-v2306.txt");
    expect(claudeAdapter.composerReady?.(lines)).toBe(true);
    expect(extractInputDraft(lines)).toMatch(/^Haceme una foto diagrama con el fondo/);
  });

  it("each of Claude's three wordings of the notice is its own, and only with its own words", () => {
    const box = (...tail: string[]) => splitLines(parseAnsi(["─".repeat(80), "❯ ", "─".repeat(80), ...tail].join("\n")));
    for (const row of [
      "    Continuing automatically at 3:20am · esc to cancel",
      "  Usage limit reached · continuing automatically at 3:20am · esc to cancel",
      "  Usage limit reached again · continuing automatically at 3:20am · esc to cancel",
    ]) expect(claudeAdapter.composerReady?.(box("  ⚠ Usage limit reached · limit resets 3:20am", row))).toBe(true);
    // A dialog's own footer under a stale box still refuses it.
    expect(claudeAdapter.composerReady?.(box("  Trust this folder?", "  Enter to confirm · Esc to cancel"))).toBe(false);
    expect(claudeAdapter.composerReady?.(box("  Something is running · esc to cancel"))).toBe(false);
  });
});
