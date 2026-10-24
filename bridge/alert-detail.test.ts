import { describe, expect, test } from "bun:test";

import { describeAlert, turnOutcome } from "./alert-detail.ts";
import { parseClaudeTranscript } from "./journal/claude.ts";
import type { AgentView } from "./types.ts";

// What a notification says about a pane: who it is to the operator (its own label, else its
// workspace), where it runs, what started the turn that just ended, and the first line of what it
// answered. Pure — the bridge hands in the journal.

const pane = (over: Partial<AgentView> = {}): AgentView => ({
  paneId: "p1",
  workspaceId: "w1",
  workspaceLabel: "assistant",
  workspaceNumber: 1,
  tabId: "w1:t1",
  agent: "claude",
  status: "done",
  cwd: "/home/me/assistant",
  focused: false,
  kind: "agent",
  ...over,
});

const jsonl = (...rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n");
const human = (uuid: string, text: string) => ({ type: "user", uuid, timestamp: "2026-10-13T18:00:00Z", origin: { kind: "human" }, message: { role: "user", content: text } });
const answer = (uuid: string, text: string) => ({ type: "assistant", uuid, timestamp: "2026-10-13T18:00:05Z", message: { role: "assistant", content: [{ type: "text", text }] } });
const taskDone = (uuid: string) => ({
  type: "user",
  uuid,
  timestamp: "2026-10-13T18:01:00Z",
  origin: { kind: "task-notification" },
  message: { role: "user", content: "<task-notification>\n<task-id>a1</task-id>\n<summary>Agent \"Map sources\" finished</summary>\n</task-notification>" },
});

describe("describeAlert", () => {
  test("a loose agent is named by its own label before the CLI's name", () => {
    expect(describeAlert(pane({ paneLabel: "pedidos" }), "done").name).toBe("pedidos");
    expect(describeAlert(pane({ sessionName: "fix-login" }), "done").name).toBe("fix-login");
    expect(describeAlert(pane({ tabLabel: "api" }), "done")).toMatchObject({ name: "api", where: "assistant" });
    expect(describeAlert(pane({ terminalTitle: "Estado del RAG" }), "done")).toMatchObject({ name: "Estado del RAG", where: "assistant" });
  });

  test("a positional tab number or the CLI's default title names nobody, so the workspace does", () => {
    // Measured on a live herd: a tab labelled "1" and a pane titled "Claude Code".
    expect(describeAlert(pane({ tabLabel: "1", terminalTitle: "Estado del RAG" }), "done").name).toBe("Estado del RAG");
    expect(describeAlert(pane({ terminalTitle: "Claude Code" }), "done")).toMatchObject({ name: "assistant", where: "" });
    expect(describeAlert(pane(), "done")).toMatchObject({ name: "assistant", where: "" });
  });

  test("a finished turn carries the first line of its last answer", () => {
    const entries = parseClaudeTranscript(jsonl(human("u1", "abrí el html"), answer("a1", "## Listo\n\nEl **HTML** de avance ya está abierto.\nDetalles abajo.")));
    expect(describeAlert(pane(), "done", entries)).toMatchObject({ startedBy: "person", summary: "Listo" });
  });

  test("a turn a subagent's result started is background work", () => {
    const entries = parseClaudeTranscript(jsonl(human("u1", "investigá"), answer("a1", "Lanzo un agente."), taskDone("t1"), answer("a2", "El agente terminó: 3 fuentes.")));
    expect(describeAlert(pane(), "done", entries)).toMatchObject({ startedBy: "subagent", summary: "El agente terminó: 3 fuentes." });
  });
});

describe("launched", () => {
  test("an agent with a Herdr name was started by another agent", () => {
    expect(describeAlert(pane({ agentName: "perf-deep-dive" }), "done").launched).toBe(true);
    expect(describeAlert(pane(), "done").launched).toBe(false);
  });
});

describe("turnOutcome", () => {
  test("an empty or unreadable journal is the operator's turn with nothing to quote", () => {
    expect(turnOutcome([])).toEqual({ startedBy: "person" });
  });

  test("a long first line is cut on a word", () => {
    const long = `${"palabra ".repeat(40)}fin`;
    const { summary } = turnOutcome(parseClaudeTranscript(jsonl(human("u1", "x"), answer("a1", long))));
    expect(summary!.length).toBeLessThanOrEqual(120);
    expect(summary!.endsWith("…")).toBe(true);
  });
});
