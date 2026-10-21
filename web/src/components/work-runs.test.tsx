import { useEffect } from "react";
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

  it("keeps a run drawn as rows as rows when a call joins it while the turn runs", async () => {
    const running = (calls: TranscriptPart[]): TranscriptEntry[] => [entries[0]!, { ...says("r", calls), turn: { status: "running" } }];
    const { rerender } = render(<TranscriptView entries={running([call("Bash", "pwd")])} activityStatus="working" />);
    await userEvent.click(screen.getByRole("button", { name: "Ran pwd" }));
    rerender(<TranscriptView entries={running([call("Bash", "pwd"), call("Bash", "date")])} activityStatus="working" />);
    expect(screen.queryByRole("button", { name: "Ran 2 commands" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ran pwd", expanded: true })).toBeInTheDocument();
  });

  it("draws calls that still run as rows, never under a line that says they ran", () => {
    const pending = (summary: string) => call("Bash", summary, { result: undefined });
    render(<TranscriptView entries={[entries[0]!, { ...says("r", [pending("a"), pending("b"), pending("c")]), turn: { status: "running" } }]} activityStatus="working" />);
    expect(screen.queryByRole("button", { name: /^Ran \d+ commands/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Running a" })).toBeInTheDocument();
  });

  it("puts a search hit inside a folded turn in the page in the same commit, for find to scroll to", () => {
    const seen: boolean[] = [];
    function Probe({ query }: { query: string }) {
      // Find's own effect looks for the hit as this one does: in the commit that set the query.
      useEffect(() => { if (query) seen.push(document.querySelector("mark") !== null); }, [query]);
      return null;
    }
    const view = (query: string) => <><TranscriptView entries={entries} activityStatus="done" query={query} /><Probe query={query} /></>;
    const { rerender } = render(view(""));
    rerender(view("requireRole"));
    expect(seen).toEqual([true]);
    expect(document.querySelector("[data-work-turn] > .fold")).toHaveAttribute("data-phase", "open");
  });

  it("unfolds a folded run into rows when a call that still runs joins it", () => {
    const running = (calls: TranscriptPart[]): TranscriptEntry[] => [entries[0]!, { ...says("r", calls), turn: { status: "running" } }];
    const done = [call("Bash", "a"), call("Bash", "b")];
    const { rerender } = render(<TranscriptView entries={running(done)} activityStatus="working" />);
    expect(screen.getByRole("button", { name: "Ran 2 commands" })).toBeInTheDocument();
    // c still runs inside the run; d, the latest, is the live row.
    rerender(<TranscriptView entries={running([...done, call("Bash", "c", { result: undefined }), call("Bash", "d", { result: undefined })])} activityStatus="working" />);
    expect(screen.queryByRole("button", { name: /^Ran \d+ commands/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Running c" })).toBeInTheDocument();
  });

  it("keeps the run the reader opened open when an older page goes in above it", async () => {
    const page = (older: TranscriptEntry[]) => [...older, says("r1", [call("Read", "a.ts"), call("Read", "b.ts")]),
      says("r2", [{ kind: "text", text: "Then the commands." }, call("Bash", "pwd"), call("Bash", "date")]), says("end", [{ kind: "text", text: "Done." }], "final_answer")];
    const { rerender } = render(<TranscriptView entries={page([])} activityStatus="done" />);
    await openTurn();
    await userEvent.click(screen.getByRole("button", { name: "Read 2 files" }));
    rerender(<TranscriptView entries={page([says("o", [call("Write", "x.ts"), call("Write", "y.ts"), { kind: "text", text: "Now the reads." }])])} activityStatus="done" />);
    expect(screen.getByRole("button", { name: "Read 2 files" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Ran 2 commands" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Wrote 2 files" })).toHaveAttribute("aria-expanded", "false");
  });
});
