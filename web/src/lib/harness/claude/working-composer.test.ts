import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines } from "../../blocks";
import { claudeAdapter } from "./index";

// Claude 2.1.296 prints "esc to interrupt" in the statusline while a turn runs. The input box under a
// running turn takes typing (its native queue, ADR 0056), so the composer guard must accept it, and
// only that hint: every dialog captured in the same probe stays refused.

const fixture = (name: string) =>
  splitLines(parseAnsi(readFileSync(join(import.meta.dirname, "fixtures", `${name}-v2296.txt`), "utf8")));
const ready = (name: string) => claudeAdapter.composerReady!(fixture(name));

describe("Claude 2.1.296 composer while a turn runs", () => {
  it("accepts the input box with a message already in Claude's own queue", () => {
    expect(ready("working-queued")).toBe(true);
    // The queued message sits above the box; the box itself shows only its placeholder.
    expect(claudeAdapter.extractInputDraft(fixture("working-queued"))).toBeNull();
  });

  it("accepts the input box while a slow hook holds the turn", () => {
    expect(ready("hook-holding")).toBe(true);
  });

  it.each(["permission-bash", "permission-bash-amend", "plan-approval", "ask-multiselect", "ask-review", "trust-prompt"])(
    "still refuses the %s dialog",
    (name) => {
      expect(ready(name)).toBe(false);
    },
  );

  it("still refuses a key hint beside the running-turn one", () => {
    const rule = "─".repeat(60);
    const screen = (footer: string) => splitLines(parseAnsi([rule, "❯ ", rule, footer].join("\n")));
    expect(claudeAdapter.composerReady!(screen("  ⏵⏵ auto mode on · esc to interrupt · ← for agents"))).toBe(true);
    expect(claudeAdapter.composerReady!(screen("  esc to interrupt · tab to amend"))).toBe(false);
    expect(claudeAdapter.composerReady!(screen("  Esc to cancel"))).toBe(false);
  });
});
