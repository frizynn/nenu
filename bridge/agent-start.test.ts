import { describe, expect, test } from "bun:test";

import { launchAgent, startPaneAgent } from "./agent-start.ts";
import type { AgentView } from "./types.ts";

const shell: AgentView = { paneId: "w1:p1", workspaceId: "w1", workspaceLabel: "QA", workspaceNumber: 1, tabId: "w1:t1", agent: "shell", status: "unknown", cwd: "/tmp", focused: false, kind: "shell" };

async function argsFor(body: unknown): Promise<string[]> {
  const launch = launchAgent(body);
  if (!launch) throw new Error("refused");
  let args: string[] = [];
  await startPaneAgent(shell, launch, { startAgent: async (_pane, _kind, a = []) => void (args = a) });
  return args;
}

describe("permission allowlist", () => {
  test("a missing permission is the CLI's own default", async () => {
    expect(launchAgent({ agent: "claude" })).toEqual({ kind: "claude", permission: "ask" });
    expect((await argsFor({ agent: "claude" })).slice(2)).toEqual([]);
    expect(await argsFor({ agent: "codex", permission: "ask" })).toEqual(["--no-daemon"]);
  });

  test("each listed choice maps to the flags its CLI documents", async () => {
    expect((await argsFor({ agent: "claude", permission: "acceptEdits" })).slice(2)).toEqual(["--permission-mode", "acceptEdits"]);
    expect((await argsFor({ agent: "claude", permission: "plan" })).slice(2)).toEqual(["--permission-mode", "plan"]);
    expect((await argsFor({ agent: "claude", permission: "bypass" })).slice(2)).toEqual(["--dangerously-skip-permissions"]);
    expect(await argsFor({ agent: "codex", permission: "auto" })).toEqual(["--no-daemon", "--sandbox", "workspace-write", "--ask-for-approval", "never"]);
    expect(await argsFor({ agent: "codex", permission: "full" })).toEqual(["--no-daemon", "--dangerously-bypass-approvals-and-sandbox"]);
  });

  test("anything off the table is refused, never passed through", () => {
    for (const body of [
      { agent: "claude", permission: "auto" }, // Codex's choice, not Claude's
      { agent: "codex", permission: "bypass" },
      { agent: "claude", permission: "--dangerously-skip-permissions" },
      { agent: "claude", permission: "toString" },
      { agent: "claude", permission: "__proto__" },
      { agent: "claude", permission: ["bypass"] },
      { agent: "claude", permission: null },
      { agent: "codex", args: ["--yolo"], permission: "ask; rm -rf ~" },
      { agent: "shell", permission: "ask" },
    ]) expect(launchAgent(body)).toBeNull();
  });

  test("a hand-built launch outside the table never starts", async () => {
    let calls = 0;
    await expect(startPaneAgent(shell, { kind: "codex", permission: "constructor" }, { startAgent: async () => void calls++ })).rejects.toThrow("permission");
    expect(calls).toBe(0);
  });
});
