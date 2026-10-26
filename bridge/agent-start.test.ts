import { describe, expect, test } from "bun:test";

import { CLAUDE_MODELS, CODEX_DOC_MODELS, launchAgent, startModels, startPaneAgent } from "./agent-start.ts";
import type { AgentView } from "./types.ts";

const shell: AgentView = { paneId: "w1:p1", workspaceId: "w1", workspaceLabel: "QA", workspaceNumber: 1, tabId: "w1:t1", agent: "shell", status: "unknown", cwd: "/tmp", focused: false, kind: "shell" };

const models = startModels([]);

async function argsFor(body: unknown): Promise<string[]> {
  const launch = launchAgent(body, models);
  if (!launch) throw new Error("refused");
  let args: string[] = [];
  await startPaneAgent(shell, launch, models, { startAgent: async (_pane, _kind, a = []) => void (args = a) });
  return args;
}

describe("permission allowlist", () => {
  test("a missing permission is the CLI's own default", async () => {
    expect(launchAgent({ agent: "claude" }, models)).toEqual({ kind: "claude", permission: "ask", model: "default" });
    expect((await argsFor({ agent: "claude" })).slice(2)).toEqual([]);
    expect(await argsFor({ agent: "codex", permission: "ask" })).toEqual(["--no-daemon"]);
  });

  test("each listed choice maps to the flags its CLI documents", async () => {
    expect((await argsFor({ agent: "claude", permission: "auto" })).slice(2)).toEqual(["--permission-mode", "auto"]);
    expect((await argsFor({ agent: "claude", permission: "acceptEdits" })).slice(2)).toEqual(["--permission-mode", "acceptEdits"]);
    expect((await argsFor({ agent: "claude", permission: "plan" })).slice(2)).toEqual(["--permission-mode", "plan"]);
    expect((await argsFor({ agent: "claude", permission: "bypass" })).slice(2)).toEqual(["--dangerously-skip-permissions"]);
    expect(await argsFor({ agent: "codex", permission: "auto" })).toEqual(["--no-daemon", "--sandbox", "workspace-write", "--ask-for-approval", "never"]);
    expect(await argsFor({ agent: "codex", permission: "full" })).toEqual(["--no-daemon", "--dangerously-bypass-approvals-and-sandbox"]);
  });

  test("anything off the table is refused, never passed through", () => {
    for (const body of [
      { agent: "claude", permission: "full" }, // Codex's choice, not Claude's
      { agent: "codex", permission: "bypass" },
      { agent: "claude", permission: "--dangerously-skip-permissions" },
      { agent: "claude", permission: "toString" },
      { agent: "claude", permission: "__proto__" },
      { agent: "claude", permission: ["bypass"] },
      { agent: "claude", permission: null },
      { agent: "codex", args: ["--yolo"], permission: "ask; rm -rf ~" },
      { agent: "shell", permission: "ask" },
    ]) expect(launchAgent(body, models)).toBeNull();
  });

  test("a hand-built launch outside the table never starts", async () => {
    let calls = 0;
    await expect(startPaneAgent(shell, { kind: "codex", permission: "constructor", model: "default" }, models, { startAgent: async () => void calls++ })).rejects.toThrow("permission");
    await expect(startPaneAgent(shell, { kind: "claude", permission: "ask", model: "opus; rm -rf ~" }, models, { startAgent: async () => void calls++ })).rejects.toThrow("model");
    expect(calls).toBe(0);
  });
});

describe("model allowlist", () => {
  test("the default adds no flag; a listed model is passed as --model", async () => {
    expect((await argsFor({ agent: "claude", model: "default" })).slice(2)).toEqual([]);
    expect((await argsFor({ agent: "claude", model: "opus[1m]", permission: "plan" })).slice(2)).toEqual(["--permission-mode", "plan", "--model", "opus[1m]"]);
    expect(await argsFor({ agent: "codex", model: "gpt-6.1-sol" })).toEqual(["--no-daemon", "--model", "gpt-6.1-sol"]);
  });

  test("a model off its agent's list is refused", () => {
    for (const body of [
      { agent: "claude", model: "gpt-6.1-sol" }, // Codex's model, not Claude's
      { agent: "codex", model: "opus" },
      { agent: "claude", model: "claude-opus-5-5" }, // a real name, but not one the list offers
      { agent: "claude", model: "opus --dangerously-skip-permissions" },
      { agent: "claude", model: ["opus"] },
      { agent: "claude", model: null },
      { agent: "codex", model: "toString" },
    ]) expect(launchAgent(body, models)).toBeNull();
  });

  test("Codex's own list replaces the documented one, after its default", () => {
    const own = startModels([{ name: "gpt-7", description: "Newest" }]);
    expect(own.codex.map((m) => m.id)).toEqual(["default", "gpt-7"]);
    expect(launchAgent({ agent: "codex", model: "gpt-6.1-sol" }, own)).toBeNull();
    expect(models.codex.slice(1)).toEqual([...CODEX_DOC_MODELS]);
    expect(models.claude).toBe(CLAUDE_MODELS);
  });
});
