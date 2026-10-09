import { describe, expect, it } from "vitest";

import { terminalWait } from "./terminal-wait";

describe("terminalWait", () => {
  it("is nothing when no row names a key", () => {
    expect(terminalWait("● done\n  ⏵⏵ bypass permissions on (shift+tab to cycle)")).toBeNull();
  });

  it("reads Claude's usage-limit pause as a notice without its key hint", () => {
    const text = [
      "  Usage limit reached · continuing automatically at 1:20am · esc to cancel",
      "  ⚠ Usage limit reached · limit resets 1:20am",
      "    Continuing automatically at 1:20am · esc to cancel",
    ].join("\n");
    expect(terminalWait(text)).toEqual({ kind: "notice", text: "Usage limit reached · limit resets 1:20am" });
  });

  it("keeps a real wait an interaction even beside a usage-limit pause", () => {
    const text = ["  Continuing automatically at 1:20am · esc to cancel", "  Trust this folder?", "  Enter to confirm · Esc to cancel"].join("\n");
    expect(terminalWait(text)).toEqual({ kind: "interaction", hint: "Enter to confirm · Esc to cancel" });
  });

  it("ignores a hint that scrolled above the tail", () => {
    expect(terminalWait(["Enter to continue", ...Array(30).fill("output")].join("\n"))).toBeNull();
  });
});
