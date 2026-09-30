import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type StyledLine } from "../../blocks";
import { claudeAdapter, claudeBuildBlocks } from "./index";
import { withoutDialogClosingRule } from "./markers";

// Claude Code 2.1.285 paints one more row under every AskUserQuestion dialog: the input box's own top
// border, two blank rows under the key-hint footer and with nothing of the box below it (measured
// 2026-09-30 on a single question, a two-question wizard and a multiSelect; 2.1.283 ended the screen
// on the footer). It is a bare rule on an untitled session and carries the session label afterwards
// (the three captures read `── … ── Sleep 14 ─`). Every dialog grammar anchors on the footer being
// the LAST non-blank row, so that one extra row turned all three into a raw mirror: no buttons on
// the phone, and a composer that could only say a dialog was probably up.

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const load = (name: string): StyledLine[] => splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
const fromTexts = (rows: string[]): StyledLine[] => splitLines(parseAnsi(rows.join("\n")));
const kinds = (lines: StyledLine[]) => claudeBuildBlocks(lines).map((b) => b.kind);

const RULE = "─".repeat(60);
const FOOTER = "Enter to select · ↑/↓ to navigate · Esc to cancel";

describe("Claude Code 2.1.285: a question dialog ends on a closing rule", () => {
  it("lifts the single question, and the answer keys are the ones pressed live", () => {
    const lines = load("claude--v2285-ask-question.txt");
    const blocks = claudeBuildBlocks(lines);
    expect(blocks.map((b) => b.kind)).toEqual(["raw", "prompt-select"]);
    const block = blocks[1]!;
    if (block.kind !== "prompt-select") throw new Error("unreachable");
    expect(block.prompt.question).toBe("Which fruit?");
    // Digit 2 was pressed on this very dialog in the sandbox pane: it answered "Banana" and
    // submitted. "Type something." is a text field and gets no button.
    expect(block.prompt.options.map((o) => [o.label, o.keys[0]])).toEqual([
      ["Apple", "1"],
      ["Banana", "2"],
      ["Chat about this", "4"],
    ]);
    expect(claudeAdapter.composerReady?.(lines)).toBe(false);
    expect(claudeAdapter.extractInputDraft(lines)).toBeNull();
  });

  it("lifts the two-question wizard", () => {
    const lines = load("claude--v2285-ask-wizard.txt");
    const blocks = claudeBuildBlocks(lines);
    expect(blocks.map((b) => b.kind)).toEqual(["raw", "wizard"]);
    const block = blocks[1]!;
    if (block.kind !== "wizard") throw new Error("unreachable");
    if (block.wizard.phase !== "question") throw new Error("unreachable");
    expect(block.wizard.steps.map((s) => s.label)).toEqual(["Fruit", "Color"]);
    expect(block.wizard.options.map((o) => o.label)).toEqual(["Apple", "Banana", "Chat about this"]);
    expect(claudeAdapter.composerReady?.(lines)).toBe(false);
  });

  it("lifts the multiSelect question", () => {
    const lines = load("claude--v2285-ask-multi.txt");
    const blocks = claudeBuildBlocks(lines);
    expect(blocks.map((b) => b.kind)).toEqual(["raw", "multi-select"]);
    const block = blocks[1]!;
    if (block.kind !== "multi-select") throw new Error("unreachable");
    if (block.multi.phase !== "checkbox") throw new Error("unreachable");
    expect(block.multi.options.map((o) => o.label)).toEqual(["Apple", "Banana", "Cherry"]);
    expect(claudeAdapter.composerReady?.(lines)).toBe(false);
  });

  it("the lifted block never carries the closing rule", () => {
    for (const name of ["claude--v2285-ask-question.txt", "claude--v2285-ask-wizard.txt", "claude--v2285-ask-multi.txt"]) {
      const last = claudeBuildBlocks(load(name)).at(-1)!;
      const rows = last.lines.map(lineText).filter((t) => t.trim() !== "");
      expect(rows.at(-1), name).toMatch(/Esc to cancel$/);
    }
  });
});

describe("withoutDialogClosingRule fails closed", () => {
  const DIALOG = ["Which fruit?", "", "❯ 1. Apple", "  2. Banana", "", FOOTER];

  it.each([
    ["a bare rule (an untitled session)", RULE],
    ["a rule carrying the session label", `${"─".repeat(50)} Sleep 14 ─`],
  ])("drops %s under a select footer at the tail", (_label, rule) => {
    const lines = fromTexts([...DIALOG, "", "", rule]);
    const cut = withoutDialogClosingRule(lines);
    expect(cut.map(lineText).filter((t) => t.trim() !== "").at(-1)).toBe(FOOTER);
    expect(kinds(lines)).toContain("prompt-select");
  });

  it("returns the SAME reference when there is nothing to drop", () => {
    const noRule = fromTexts(DIALOG);
    expect(withoutDialogClosingRule(noRule)).toBe(noRule);
    // An ordinary idle screen: the last row is the statusline, the rules are the input box's.
    const idle = fromTexts(["● done", RULE, "❯ ", RULE, "  [Opus 5] ~/src"]);
    expect(withoutDialogClosingRule(idle)).toBe(idle);
    // An input box that happens to be the tail: its bottom border sits under the prompt row.
    const box = fromTexts(["● done", RULE, "❯ a draft", RULE]);
    expect(withoutDialogClosingRule(box)).toBe(box);
    expect(claudeAdapter.composerReady?.(box)).toBe(true);
  });

  it("leaves a rule that is too far under the footer, or under prose", () => {
    const far = fromTexts([...DIALOG, "", "", "", "", RULE]);
    expect(withoutDialogClosingRule(far)).toBe(far);
    const prose = fromTexts(["some output", "", RULE]);
    expect(withoutDialogClosingRule(prose)).toBe(prose);
    // An indented rule, or a second row under the footer, is not the closing rule.
    const indented = fromTexts([...DIALOG, "", `  ${RULE}`]);
    expect(withoutDialogClosingRule(indented)).toBe(indented);
    const extra = fromTexts([...DIALOG, "more output", RULE]);
    expect(withoutDialogClosingRule(extra)).toBe(extra);
    expect(kinds(extra)).toEqual(["raw"]);
  });

  it("a dialog that has scrolled up stays raw", () => {
    const scrolled = fromTexts([...DIALOG, "", "", RULE, "● the answer was Apple"]);
    expect(kinds(scrolled)).toEqual(["raw"]);
  });
});
