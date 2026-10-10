import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAnsi } from "../../ansi";
import { splitLines } from "../../blocks";
import { codexAdapter } from "./index";
import { detectAskNotes, detectAskRegion } from "./ask";
import { lineText } from "./markers";

const fruit = readFileSync(join(import.meta.dirname, "../../../fixtures/panes/codex--ask-fruit.txt"), "utf8");
const linesOf = (text: string) => splitLines(parseAnsi(text));

// Layout-only variants of the public capture, not new live captures.
describe("wrapped Codex questions", () => {
  it.each(["question", "description", "footer", "all"])("lifts a wrapped %s", (part) => {
    let screen = fruit;
    if (part === "question" || part === "all") screen = screen.replaceAll("Pick a fruit?", "Pick a\n  fruit?");
    if (part === "description" || part === "all") {
      screen = screen.replace("Choose a soft, juicy pear.", "Choose a soft,\n                                              juicy pear.");
    }
    if (part === "footer" || part === "all") screen = screen.replace(" | esc to interrupt", "\n  esc to interrupt");
    const lines = linesOf(screen);
    const ask = detectAskRegion(lines);
    expect(ask?.model.question).toBe("Pick a fruit?");
    expect(ask?.model.options.map((o) => o.keys)).toEqual([["1"], ["2"], ["3"]]);
    expect(ask?.model.options[1]?.description).toBe("Choose a soft, juicy pear.");
    const prompt = codexAdapter.buildBlocks(lines).find((b) => b.kind === "prompt-select");
    expect(prompt?.lines.map(lineText).join("\n")).toContain("1. Apple");
    expect(codexAdapter.composerReady!(lines)).toBe(false);
    expect(detectAskRegion(linesOf(screen + "\nnew output"))).toBeNull();
    if (part === "all") {
      const changed = detectAskRegion(linesOf(screen.replace("juicy pear", "green pear")));
      expect(changed?.model.signature).not.toBe(ask?.model.signature);
    }
  });

  it.each(["        unexpected row", "                                              10. Another option", "  › Add notes", ""])(
    "refuses an invalid option continuation: %j", (row) => {
      const screen = [
        "  Question 1/1 (1 unanswered)", "  Pick?", "",
        "  › 1. A  First description", row, "    2. B  Second description", "",
        "  tab to add notes | enter to submit answer", "  esc to interrupt",
      ].join("\n");
      expect(detectAskRegion(linesOf(screen))).toBeNull();
    },
  );

  it("refuses continuations without a description", () => {
    const screen = [
      "  Question 1/1 (1 unanswered)", "  Pick?", "",
      "  › 1. A", "              continuation", "    2. B", "",
      "  tab to add notes | enter to submit answer", "  esc to interrupt",
    ].join("\n");
    expect(detectAskRegion(linesOf(screen))).toBeNull();
  });

  it("refuses notes mode with a wrapped footer", () => {
    const notes = readFileSync(join(import.meta.dirname, "../../../fixtures/panes/codex--ask-notes-focused.txt"), "utf8")
      .replace(" | esc to interrupt", "\n  esc to interrupt");
    expect(detectAskRegion(linesOf(notes))).toBeNull();
  });
});

// Notes on Codex 0.160.1, captured in a disposable session (PROBES_2026_10_NOTES.md).
describe("the notes box", () => {
  const p0 = (name: string) => linesOf(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));
  const panes = (name: string) => linesOf(readFileSync(join(import.meta.dirname, "../../../fixtures/panes", name), "utf8"));

  it("marks only the row that offers notes on a single-question card, and reads the pointer", () => {
    const ask = detectAskRegion(p0("ask-notes-row-pointed-v0160.txt"))!;
    expect(ask.model.options.map((o) => o.amend ?? false)).toEqual([false, false, true]);
    expect(ask.model.pointer).toBe(3);
    expect(detectAskRegion(p0("ask-plan-mode-v0160.txt"))!.model.pointer).toBe(1);
  });

  it("offers no notes on a multi-question card (not walked)", () => {
    const ask = detectAskRegion(panes("codex--ask-wizard-q1.txt"))!;
    expect(ask.model.options.some((o) => o.amend)).toBe(false);
  });

  it.each([
    ["ask-notes-open-v0160.txt", ""],
    ["ask-notes-typed-v0160.txt", "Mango please"],
  ])("%s: the open box is read back, and the buttons view still refuses it", (name, text) => {
    expect(detectAskNotes(p0(name))).toEqual({ question: "Which fruit do you prefer?", row: 3, text });
    expect(detectAskRegion(p0(name))).toBeNull();
  });

  it("reads the box on the earlier notes capture and nothing on a closed card", () => {
    expect(detectAskNotes(panes("codex--ask-notes-focused.txt"))).toEqual({ question: "Tabs or spaces?", row: 1, text: "" });
    expect(detectAskNotes(p0("ask-notes-row-pointed-v0160.txt"))).toBeNull();
    expect(detectAskNotes(linesOf(fruit))).toBeNull();
  });
});
