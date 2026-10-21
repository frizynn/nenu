import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines, type StyledLine } from "../../blocks";
import { extractInputDraft, hasInputBox, inputBoxShowsHistory, readClaudeTurn } from "./chrome";

// Claude Code 2.1.306 in a Herdr pane of its own, under a statusline long enough to fill its row:
// two messages queued while a command ran, then Up in the empty box (ADR 0118).
const fixture = (name: string): StyledLine[] =>
  splitLines(parseAnsi(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")));

describe("Claude's own queue, taken back with Up", () => {
  it("reads the empty box that says the queue holds something", () => {
    const lines = fixture("queue-waiting-v2306.txt");
    expect(hasInputBox(lines)).toBe(true);
    expect(extractInputDraft(lines)).toBeNull();
    expect(readClaudeTurn(lines).queued).toBe("sends");
  });

  // The statusline fills its row, so Claude glues its editor hint to it with one space; read as a
  // dialog's footer, it hid the box and refused every send while a draft of two lines was in it.
  it("finds the box holding every queued message, the editor hint glued to a full statusline", () => {
    const lines = fixture("queue-recalled-v2306.txt");
    expect(hasInputBox(lines)).toBe(true);
    expect(extractInputDraft(lines)).toBe("cola A cola B con más palabras");
    expect(inputBoxShowsHistory(lines)).toBe(false);
  });

  it("tells a message from the history apart: the queue had been read", () => {
    const lines = fixture("history-recall-v2296.txt");
    expect(extractInputDraft(lines)).not.toBeNull();
    expect(inputBoxShowsHistory(lines)).toBe(true);
  });
});
