import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TranscriptView } from "./transcript-view";
import { PaneCwdContext } from "./work-log-tools";
import type { TranscriptEntry, TranscriptPart } from "@/lib/types";

// On a desk, a turn's steps between two of the agent's texts fold into one line, a table when open.

const original = window.matchMedia;
beforeEach(() => {
  window.matchMedia = ((query: string) => ({ matches: query === "(min-width: 1024px)", media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as typeof window.matchMedia;
});
afterEach(() => { window.matchMedia = original; });

const ts = "2026-10-20T10:00:00Z";
const call = (name: string, summary: string, extra: Partial<Extract<TranscriptPart, { kind: "tool" }>> = {}): TranscriptPart =>
  ({ kind: "tool", name, summary, result: { text: "ok" }, ...extra });
const says = (uuid: string, parts: TranscriptPart[], phase: TranscriptEntry["phase"] = "commentary"): TranscriptEntry =>
  ({ uuid, ts, role: "assistant", turnId: "t", phase, parts });
const entries: TranscriptEntry[] = [
  { uuid: "u", ts, role: "user", parts: [{ kind: "text", text: "Fix the roles" }] },
  says("a", [{ kind: "text", text: "I look at the checks." }, call("Bash", "grep -rn requireRole src", { description: "Find every role check" }), call("Read", "src/auth.ts")]),
  says("b", [{ kind: "text", text: "Every check sits beside a module permission." },
    call("Edit", "src/auth.ts", { diff: { added: 31, removed: 4 } }),
    call("Bash", "bun test", { description: "Integration tests", result: { text: "Exit code 1\n1 fail", isError: true } })]),
  says("c", [{ kind: "text", text: "Done." }], "final_answer"),
];

describe("a desk's work log", () => {
  it("draws the agent's words at prose size and each run of steps as one line", () => {
    render(<TranscriptView entries={entries} activityStatus="done" />);
    expect(screen.getByText("I look at the checks.")).toBeVisible();
    expect(screen.getByText("Every check sits beside a module permission.")).toBeVisible();
    expect(screen.getByRole("button", { name: /^Ran 1 command, read 1 file/ })).toHaveAttribute("aria-expanded", "false");
    const second = screen.getByRole("button", { name: /^Edited 1 file, ran 1 command/ });
    expect(second).toHaveTextContent("+31");
    expect(second).toHaveTextContent("1 failed");
    expect(screen.queryByText("Find every role check")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Worked/ })).not.toBeInTheDocument();
  });

  it("opens a run as rows, verb and description or target, and a row onto its command and output", async () => {
    render(<TranscriptView entries={entries} activityStatus="done" />);
    await userEvent.click(screen.getByRole("button", { name: /^Edited 1 file, ran 1 command/ }));
    const row = screen.getByRole("button", { name: /^Ran\s*Integration tests/ });
    expect(row).toHaveTextContent("exit 1");
    expect(screen.getByRole("button", { name: /^Edited\s*src\/auth\.ts/ })).toHaveTextContent("+31");
    await userEvent.click(row);
    const body = row.closest("[data-step-row]") as HTMLElement;
    expect(within(body).getByText("bun test")).toBeVisible();
    expect(within(body).getByText("1 fail")).toBeVisible();
    expect(within(body).queryByText(/Exit code/)).not.toBeInTheDocument();
  });

  it("opens the run that holds find's hit, even after a tap closed it", async () => {
    const { rerender } = render(<TranscriptView entries={entries} activityStatus="done" />);
    const run = screen.getByRole("button", { name: /^Ran 1 command, read 1 file/ });
    await userEvent.click(run);
    await userEvent.click(run);
    expect(run).toHaveAttribute("aria-expanded", "false");
    rerender(<TranscriptView entries={entries} activityStatus="done" query="requireRole" />);
    expect(run).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps the step in progress outside every fold", () => {
    const live = says("d", [call("Bash", "bun test", { description: "Integration tests", result: undefined })]);
    render(<TranscriptView entries={[...entries.slice(0, 3), live]} activityStatus="working" />);
    const row = screen.getByText("Integration tests", { selector: "[data-live-step] *" });
    expect(row.closest("[data-live-step]")).toHaveTextContent("Running");
    expect(row.closest("[data-work-steps]")).toBeNull();
  });

  it("names the file a running step reads as its finished row will, from the pane's folder", () => {
    const live = says("d", [call("Read", "/repo/src/auth.ts", { result: undefined })]);
    render(<PaneCwdContext.Provider value="/repo"><TranscriptView entries={[...entries.slice(0, 3), live]} activityStatus="working" /></PaneCwdContext.Provider>);
    const step = document.querySelector("[data-live-step]") as HTMLElement;
    expect(step).toHaveTextContent("src/auth.ts");
    expect(step).not.toHaveTextContent("/repo/src/auth.ts");
  });

  it("draws a description unmarked, since find does not count it", async () => {
    render(<TranscriptView entries={entries} activityStatus="done" query="Integration" />);
    await userEvent.click(screen.getByRole("button", { name: /^Edited 1 file, ran 1 command/ }));
    expect(screen.getByRole("button", { name: /^Ran\s*Integration tests/ }).querySelector("mark")).toBeNull();
  });
});
