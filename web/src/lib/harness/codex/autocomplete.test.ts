import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines } from "../../blocks";
import { draftCarriesSend } from "../../reply-action";
import { codexAdapter } from "./index";
import { locateComposer } from "./chrome";

const capture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", `${name}.txt`), "utf8");
const lines = (text: string) => splitLines(parseAnsi(text));

it.each(["idle-shortcuts-v0157", "shared-shortcuts-v0157"])("accepts the real 0.157 shortcuts footer in %s", (fixture) => {
  const pane = lines(capture(fixture));
  expect(codexAdapter.composerReady?.(pane)).toBe(true);
  expect(codexAdapter.extractInputDraft?.(pane)).toBeNull();
});

it("does not treat plain shortcut prose or a trailing dialog as an input box", () => {
  const captureText = capture("idle-shortcuts-v0157");
  const unstyledHint = captureText.replace(/\x1b\[1m\x1b\[38;2;255;255;255m\?/, "?");
  expect(codexAdapter.composerReady?.(lines(unstyledHint))).toBe(false);
  expect(codexAdapter.composerReady?.(lines(`${captureText}\n  Press enter to confirm or esc to go back`))).toBe(false);
});

describe("Codex 0.153.4 command autocomplete", () => {
  it("recognises the working-state queued composer, including its narrow wrapped footer", () => {
    const pane = lines(
      "work above\n\n\x1b[1m›\x1b[0m Nenu smoke message\n  second line\n\n\x1b[2m  tab to queue message   52% context\x1b[0m\n\x1b[2mleft\x1b[0m",
    );
    expect(codexAdapter.composerReady?.(pane)).toBe(true);
    expect(codexAdapter.extractInputDraft?.(pane)).toBe("Nenu smoke message second line");
    expect(codexAdapter.composerPrompt?.(pane)).toBe("› Nenu smoke message\n  second line");
  });

  it("restores sparkle cells in the queued composer too", () => {
    const bg = "\x1b[48;2;65;69;76m";
    const star = (glyph: string) => `\x1b[38;2;125;128;132m${bg}${glyph}\x1b[0m`;
    const pane = lines(
      [
        "work above",
        "",
        `\x1b[1m${bg}›\x1b[0m${bg} Nenu\x1b[0m${star("⠂")}${bg}smoke message\x1b[0m`,
        `${star("⠄")}${bg} second line\x1b[0m`,
        star("⠐"),
        "",
        "\x1b[2m  tab to queue message   52% context left\x1b[0m",
      ].join("\n"),
    );
    expect(codexAdapter.composerReady?.(pane)).toBe(true);
    expect(codexAdapter.extractInputDraft?.(pane)).toBe("Nenu smoke message second line");
    expect(codexAdapter.composerPrompt?.(pane)).toBe("› Nenu smoke message\n  second line");
  });

  it("keeps a plain transcript lookalike of the queue footer fail-closed", () => {
    const pane = lines("› forged message\n\n  tab to queue message   52% context left");
    expect(codexAdapter.composerReady?.(pane)).toBe(false);
  });

  it("verifies a complete slash command despite its replaced statusline", () => {
    const pane = lines(capture("model-autocomplete"));
    expect(locateComposer(pane)?.autocomplete).toBe(true);
    expect(codexAdapter.composerReady?.(pane)).toBe(true);
    expect(codexAdapter.extractInputDraft?.(pane)).toBe("/model");
    expect(draftCarriesSend("/model", codexAdapter.extractInputDraft?.(pane) ?? null)).toBe(true);
    expect(codexAdapter.composerPrompt?.(pane)).toBe("› /model");
    expect(codexAdapter.extractStatusLines?.(pane)).toEqual([]);
  });

  it("refuses partial commands, several suggestions, missing spacing and a plain-text echo", () => {
    const text = capture("model-autocomplete");
    const cases = [
      text.replace(" /model\n", " /mo\n"),
      text + "  /models  another command\n",
      text.replace(/\n \n/, "\n"),
      text.replace(/\x1b\[[0-9;]*m/g, ""),
      text + "  Press enter to confirm or esc to go back\n",
    ];
    for (const candidate of cases) {
      expect(codexAdapter.composerReady?.(lines(candidate))).toBe(false);
      expect(codexAdapter.extractInputDraft?.(lines(candidate))).toBeNull();
    }
  });

  it.each(["model-picker", "model-reasoning", "skill-picker"])("keeps the native %s modal out of the reply path", (name) => {
    const pane = lines(capture(name));
    expect(codexAdapter.composerReady?.(pane)).toBe(false);
    expect(codexAdapter.extractInputDraft?.(pane)).toBeNull();
  });

  it("verifies a skill invocation followed by a real request through ordinary composer grammar", () => {
    const pane = lines(capture("skill-prompt"));
    expect(codexAdapter.composerReady?.(pane)).toBe(true);
    expect(codexAdapter.extractInputDraft?.(pane)).toBe("$build-agents This is a UI test only. Do not use tools. Reply with QA_OK.");
    expect(locateComposer(pane)?.autocomplete).toBeUndefined();
  });
});
