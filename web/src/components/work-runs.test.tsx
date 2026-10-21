import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TranscriptView } from "./transcript-view";
import { PaneCwdContext } from "./work-log-tools";
import type { TranscriptEntry, TranscriptPart } from "@/lib/types";

// A turn reads the same on a phone and a desk (ADR 0113): the agent's words, and between two of them
// its steps. A single call is its own row; several fold under one line that says what they did.

const ts = "2026-10-20T10:00:00Z";
const call = (name: string, summary: string, extra: Partial<Extract<TranscriptPart, { kind: "tool" }>> = {}): TranscriptPart =>
  ({ kind: "tool", name, summary, result: { text: "ok" }, ...extra });
const says = (uuid: string, parts: TranscriptPart[], phase: TranscriptEntry["phase"] = "commentary"): TranscriptEntry =>
  ({ uuid, ts, role: "assistant", turnId: "t", phase, parts });
const entries: TranscriptEntry[] = [
  { uuid: "u", ts, role: "user", parts: [{ kind: "text", text: "Fix the roles" }] },
  says("a", [{ kind: "thinking", text: "Find every role check first." }, { kind: "text", text: "I look at the checks." },
    call("Bash", "grep -rn requireRole src", { description: "Find every role check" }), call("Bash", "pwd && ls -la"), call("Bash", "date")]),
  says("b", [{ kind: "text", text: "Every check sits beside a module permission." },
    call("Bash", "bun test", { description: "Integration tests", result: { text: "Exit code 1\n1 fail", isError: true } })]),
  says("c", [{ kind: "text", text: "Done." }], "final_answer"),
];

async function openTurn() {
  await userEvent.click(screen.getByRole("button", { name: /^Worked/, expanded: false }));
}

describe("a turn's runs of steps", () => {
  it("folds the finished turn to its line and its answer", () => {
    render(<TranscriptView entries={entries} activityStatus="done" />);
    expect(screen.getByRole("button", { name: /^Worked/, expanded: false })).toBeInTheDocument();
    expect(screen.getByText("Done.")).toBeVisible();
    expect(screen.queryByText("I look at the checks.")).not.toBeInTheDocument();
  });

  it("draws a thought and a single call as rows, and several calls as one line", async () => {
    render(<TranscriptView entries={entries} activityStatus="done" />);
    await openTurn();
    expect(screen.getByRole("button", { name: "Thinking: Find every role check first." })).toBeVisible();
    expect(screen.getByText("I look at the checks.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Ran 3 commands", expanded: false })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Ran pwd/ })).not.toBeInTheDocument();
    // One call is its own row: no line to open first.
    expect(screen.getByRole("button", { name: /^Ran bun test Failed/ })).toHaveTextContent(/^bun testFailed$/);
  });

  it("opens the line onto one row per command, each a tap from its command and output", async () => {
    render(<TranscriptView entries={entries} activityStatus="done" />);
    await openTurn();
    await userEvent.click(screen.getByRole("button", { name: "Ran 3 commands" }));
    for (const command of ["grep -rn requireRole src", "pwd && ls -la", "date"]) {
      expect(screen.getByRole("button", { name: `Ran ${command}` })).toHaveTextContent(command);
    }
    const row = screen.getByRole("button", { name: "Ran pwd && ls -la" });
    await userEvent.click(row);
    const body = row.closest("[data-tool]") as HTMLElement;
    expect(within(body).getAllByText("ok")[0]).toBeVisible();
  });

  it("opens the line that holds find's hit, even after a tap closed it", async () => {
    const { rerender } = render(<TranscriptView entries={entries} activityStatus="done" query="requireRole" />);
    const run = screen.getByRole("button", { name: "Ran 3 commands" });
    expect(run).toHaveAttribute("aria-expanded", "true");
    rerender(<TranscriptView entries={entries} activityStatus="done" />);
    await openTurn();
    await userEvent.click(screen.getByRole("button", { name: "Ran 3 commands" }));
    await userEvent.click(screen.getByRole("button", { name: "Ran 3 commands" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Ran pwd/ })).not.toBeInTheDocument());
    rerender(<TranscriptView entries={entries} activityStatus="done" query="requireRole" />);
    expect(screen.getByRole("button", { name: "Ran 3 commands" })).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps the step in progress outside every fold", () => {
    const live = says("d", [call("Bash", "bun test", { result: undefined })]);
    render(<TranscriptView entries={[...entries.slice(0, 3), live]} activityStatus="working" />);
    const row = document.querySelector("[data-live-step]") as HTMLElement;
    expect(row).toHaveTextContent("Running");
    expect(row.closest("[data-work-steps]")).toBeNull();
  });

  it("names the file a running step reads as its finished row will, from the pane's folder", () => {
    const live = says("d", [call("Read", "/repo/src/auth.ts", { result: undefined })]);
    render(<PaneCwdContext.Provider value="/repo"><TranscriptView entries={[...entries.slice(0, 3), live]} activityStatus="working" /></PaneCwdContext.Provider>);
    const step = document.querySelector("[data-live-step]") as HTMLElement;
    expect(step).toHaveTextContent("src/auth.ts");
    expect(step).not.toHaveTextContent("/repo/src/auth.ts");
  });
});
