import { vi } from "vitest";
import { QuestionLiveContext, QuestionReplyContext } from "./transcript-question";
import { FileMediaContext } from "@/lib/file-preview-context";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "@/test/setup";

import { TranscriptView } from "./transcript-view";
import { FilePreviewProvider } from "./file-preview-provider";
import { PaneCwdContext } from "./work-log-tools";
import type { TranscriptEntry } from "@/lib/types";

// TranscriptView renders the agent's own conversation log — the only history a Claude pane can have
// (its terminal runs on the alternate screen, which keeps no scrollback). The load-bearing
// behaviours: tool output stays collapsed so prose isn't buried, every string renders as TEXT (the
// same XSS boundary as the mirror), and a compaction summary is visibly not a human turn.

const turn = (over: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  uuid: "u1",
  ts: "2026-07-25T06:22:21.253Z",
  role: "user",
  parts: [{ kind: "text", text: "hello" }],
  ...over,
});

/** Opens the turn's work: its steps are rows right under it, with nothing more to open first. */
async function openWork() {
  const work = screen.getByRole("button", { name: /^Work log/ });
  if (work.getAttribute("aria-expanded") === "false") await userEvent.click(work);
}

describe("TranscriptView", () => {
  it("renders your turn as a bubble and the agent's as plain text, with no speaker labels", () => {
    render(
      <TranscriptView
        entries={[
          turn({ uuid: "u1", role: "user", parts: [{ kind: "text", text: "what changed?" }] }),
          turn({
            uuid: "a1",
            role: "assistant",
            parts: [{ kind: "text", text: "One commit." }],
          }),
        ]}
      />,
    );
    expect(screen.getByText("what changed?").closest("[data-speaker]")).toHaveAttribute("data-speaker", "user");
    expect(screen.getByText("One commit.").closest("[data-speaker]")).toHaveAttribute("data-speaker", "assistant");
    expect(screen.queryByText("You")).not.toBeInTheDocument();
    expect(screen.queryByText("claude")).not.toBeInTheDocument();
  });

  it("shows a tool call's summary but keeps its output collapsed until tapped", async () => {
    render(
      <TranscriptView
        entries={[
          turn({
            role: "assistant",
            parts: [
              {
                kind: "tool",
                name: "Bash",
                summary: "git log --oneline",
                result: { text: "abc1234 the commit body" },
              },
            ],
          }),
        ]}
      />,
    );

    await openWork();
    // A command's row is the command: its verb stays in the row's name, not on every line.
    expect(screen.getByRole("button", { name: "Ran git log --oneline" })).toHaveTextContent(/^git log --oneline$/);
    // Collapsed by default — a real thread is mostly tool traffic, and expanding it all buries the prose.
    expect(screen.queryByText(/abc1234 the commit body/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Ran git log --oneline", expanded: false }));
    expect(screen.getByText(/abc1234 the commit body/)).toBeInTheDocument();
  });

  it("a historical tool with missing output reports unknown rather than pretending it is still running", async () => {
    render(
      <TranscriptView
        entries={[
          turn({
            role: "assistant",
            parts: [{ kind: "tool", name: "Read", summary: "/a.ts" }],
          }),
        ]}
      />,
    );
    await openWork();
    const tool = screen.getByRole("button", { name: "Read /a.ts No output recorded" });
    expect(tool).toBeEnabled();
    expect(screen.queryByText("Running…")).not.toBeInTheDocument();
    await userEvent.click(tool);
    expect(screen.getAllByText("No output recorded")).toHaveLength(2);
  });

  it("shows a step's file relative to the pane's folder, and one outside it from home", async () => {
    render(
      <PaneCwdContext value="/home/you/webapp">
        <TranscriptView
          entries={[turn({ role: "assistant", parts: [
            { kind: "tool", name: "Read", summary: "/home/you/webapp/web/src/workbench.css", result: { text: "" } },
            { kind: "tool", name: "Edit", summary: "/home/you/.config/nenu/keys.toml", result: { text: "" } },
          ] })]}
        />
      </PaneCwdContext>,
    );
    await openWork();
    // Two calls fold under the line that says what they did.
    await userEvent.click(screen.getByRole("button", { name: "Read 1 file, edited 1 file" }));
    expect(screen.getByRole("button", { name: /^Read web/ })).toHaveTextContent(/^Read\s*web\/src\/workbench\.css$/);
    expect(screen.getByRole("button", { name: /^Edited / })).toHaveTextContent(/^Edited\s*~\/\.config\/nenu\/keys\.toml$/);
    // The row is named by what it shows, so a spoken "tap Read web src workbench.css" finds it.
    expect(screen.getByRole("button", { name: "Read web/src/workbench.css" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edited ~/.config/nenu/keys.toml" })).toBeInTheDocument();
  });

  it("flags truncated output rather than silently dropping the tail", async () => {
    render(
      <TranscriptView
        entries={[
          turn({
            role: "assistant",
            parts: [
              {
                kind: "tool",
                name: "Read",
                summary: "/big",
                result: { text: "start of output", truncated: true },
              },
            ],
          }),
        ]}
      />,
    );
    await openWork();
    await userEvent.click(screen.getByRole("button", { name: "Read /big Truncated", expanded: false }));
    expect(screen.getByText(/output truncated/)).toBeInTheDocument();
  });

  it("marks a compaction summary as one folded line, not as something a human said", async () => {
    render(
      <TranscriptView
        entries={[turn({ role: "summary", parts: [{ kind: "text", text: "…prior context…" }] })]}
      />,
    );
    expect(screen.queryByText("You")).not.toBeInTheDocument();
    expect(screen.queryByText("…prior context…")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Context compacted/, expanded: false }));
    expect(screen.getByText("…prior context…")).toBeInTheDocument();
  });

  // Markdown introduced ONE new way for log content to reach the browser: an <a href>. A hostile
  // scheme must never survive as a real link — the parser refuses it and the text stays literal.
  it("never turns an unsafe link target into an anchor", () => {
    const { container } = render(
      <TranscriptView
        entries={[
          turn({ parts: [{ kind: "text", text: "[tap me](javascript:alert(1))" }] }),
        ]}
      />,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByText(/tap me/)).toBeInTheDocument();
  });

  it("a safe link renders as an anchor that can't reach back into the app", () => {
    const { container } = render(
      <TranscriptView
        entries={[turn({ parts: [{ kind: "text", text: "[docs](https://example.com)" }] })]}
      />,
    );
    const a = container.querySelector("a");
    expect(a).toHaveAttribute("href", "https://example.com");
    expect(a).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("renders log text as TEXT, never as markup (the XSS boundary)", () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const { container } = render(
      <TranscriptView entries={[turn({ parts: [{ kind: "text", text: hostile }] })]} />,
    );
    // The characters survive verbatim…
    expect(screen.getByText(hostile)).toBeInTheDocument();
    // …and no element was ever constructed from them.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });

  it("tints the slash commands in your message, never in the agent's words", () => {
    const { container } = render(
      <TranscriptView
        entries={[
          turn({ uuid: "u1", role: "user", parts: [{ kind: "text", text: "/merge-pr 260 then /afk, not /Users/fran or https://x.dev/a" }] }),
          turn({ uuid: "a1", role: "assistant", parts: [{ kind: "text", text: "Ran /merge-pr for you." }] }),
        ]}
      />,
    );
    const user = container.querySelector('[data-speaker="user"]')!;
    expect([...user.querySelectorAll(".slash-command")].map((el) => el.textContent)).toEqual(["/merge-pr", "/afk"]);
    expect(user.textContent).toContain("/merge-pr 260 then /afk, not /Users/fran or https://x.dev/a");
    expect(container.querySelector('[data-speaker="assistant"] .slash-command')).toBeNull();
  });

  it("renders prose as formatted Markdown", () => {
    const { container } = render(
      <TranscriptView
        entries={[
          turn({ parts: [{ kind: "text", text: "## Heading\n\n**bold** and `code`" }] }),
        ]}
      />,
    );
    // The syntax is consumed into structure rather than shown literally…
    expect(screen.queryByText(/## Heading/)).not.toBeInTheDocument();
    expect(screen.getByText("Heading")).toBeInTheDocument();
    // …and the emphasis/code become real elements.
    expect(container.querySelector("strong")).toHaveTextContent("bold");
    expect(container.querySelector("code")).toHaveTextContent("code");
  });

  it("tool output is NOT markdown-parsed — it's command output, kept verbatim", async () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const { container } = render(
      <TranscriptView
        entries={[
          turn({
            role: "assistant",
            parts: [
              {
                kind: "tool",
                name: "Bash",
                summary: "cat notes.md",
                result: { text: `## literal heading\n**literal stars**\n${hostile}` },
              },
            ],
          }),
        ]}
      />,
    );
    await openWork();
    await userEvent.click(screen.getByRole("button", { name: "Ran cat notes.md", expanded: false }));
    expect(screen.getByText(/## literal heading/)).toBeInTheDocument();
    expect(container.textContent).toContain(hostile);
    expect(container.querySelector("img,script,strong,h2")).toBeNull();
  });

  it("groups turns under a day divider, once per day", () => {
    render(
      <TranscriptView
        entries={[
          turn({ uuid: "a", ts: "2026-07-25T06:00:00.000Z" }),
          turn({ uuid: "b", ts: "2026-07-25T07:00:00.000Z" }),
          turn({ uuid: "c", ts: "2026-07-26T08:00:00.000Z" }),
        ]}
      />,
    );
    const day25 = new Date("2026-07-25T06:00:00.000Z").toLocaleDateString(undefined, {
      dateStyle: "medium",
    });
    const day26 = new Date("2026-07-26T08:00:00.000Z").toLocaleDateString(undefined, {
      dateStyle: "medium",
    });
    expect(screen.getAllByText(day25)).toHaveLength(1);
    expect(screen.getAllByText(day26)).toHaveLength(1);
  });

  it("survives a turn with no timestamp (no divider, no crash)", () => {
    render(<TranscriptView entries={[turn({ ts: "" })]} />);
    expect(screen.getByText("hello")).toBeInTheDocument();
  });
});

// Grouping: a real thread is overwhelmingly long runs of assistant turns, so only the first turn of
// a run carries the role/time header. Without this the scroll length roughly doubles with nothing
// new in it.
describe("TranscriptView — speaker grouping", () => {
  const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const at = "2026-07-25T06:22:21.253Z";

  it("times only the first of your consecutive messages", () => {
    render(
      <TranscriptView
        entries={[
          turn({ uuid: "u1", parts: [{ kind: "text", text: "one" }] }),
          turn({ uuid: "u2", parts: [{ kind: "text", text: "two" }] }),
          turn({ uuid: "u3", parts: [{ kind: "text", text: "three" }] }),
        ]}
      />,
    );
    expect(screen.getAllByText(time(at))).toHaveLength(1);
    // Every turn's content still renders — only the repeated time is suppressed.
    for (const t of ["one", "two", "three"]) expect(screen.getByText(t)).toBeInTheDocument();
  });

  it("times your message again after the agent answers", () => {
    render(
      <TranscriptView
        entries={[
          turn({ uuid: "u1", parts: [{ kind: "text", text: "ask" }] }),
          turn({ uuid: "a1", role: "assistant", parts: [{ kind: "text", text: "answer" }] }),
          turn({ uuid: "u2", parts: [{ kind: "text", text: "follow up" }] }),
        ]}
      />,
    );
    expect(screen.getAllByText(time(at))).toHaveLength(2);
  });

  it("a day divider restarts the run even for the same speaker", () => {
    render(
      <TranscriptView
        entries={[
          turn({ uuid: "u1", ts: "2026-07-25T06:00:00.000Z" }),
          turn({ uuid: "u2", ts: "2026-07-26T06:00:00.000Z" }),
        ]}
      />,
    );
    expect(screen.getAllByText(time("2026-07-25T06:00:00.000Z"))).toHaveLength(2);
  });
});

// Machine-injected content (a background task finishing, another session's message, a loaded
// skill) is real, but it is NOT speech: one quiet line each, never a bubble or a block, its body
// behind the line.
describe("TranscriptView — system notes", () => {
  it("draws a note as one line attributed to neither party, with no box around it", () => {
    const { container } = render(
      <TranscriptView entries={[turn({ role: "note", parts: [{ kind: "context", label: 'Agent "issue 8 fixes" finished', text: "" }] })]} />,
    );
    expect(screen.getByText('Agent "issue 8 fixes" finished')).toBeInTheDocument();
    // Nothing more to show, so nothing offers to open.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText(/System/)).not.toBeInTheDocument();
    expect(container.querySelector('[data-speaker]')).toBeNull();
    expect(container.querySelector(".border-dashed")).toBeNull();
  });

  it("keeps a note's body behind its line until tapped", async () => {
    render(<TranscriptView entries={[turn({ role: "note", parts: [{ kind: "context", label: "Message from nenustop", text: "PR #63 is green, not merged." }] })]} />);
    expect(screen.queryByText("PR #63 is green, not merged.")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Message from nenustop", expanded: false }));
    expect(screen.getByText("PR #63 is green, not merged.")).toBeInTheDocument();
  });

  // The web is live the moment it is built; the bridge only after a restart, so an older bridge's
  // notes (plain text) still read as one line: their first line, the rest behind it.
  it("draws an older bridge's text note as its first line", async () => {
    render(<TranscriptView entries={[turn({ role: "note", parts: [{ kind: "text", text: "Stop hook feedback: fix these\n- app.tsx: missing test" }] })]} />);
    expect(screen.queryByText(/missing test/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Stop hook feedback: fix these", expanded: false }));
    expect(screen.getByText(/missing test/)).toBeInTheDocument();
  });

  it("keeps a compaction summary distinct from an ordinary note", () => {
    render(
      <TranscriptView
        entries={[
          turn({ uuid: "s", role: "summary", parts: [{ kind: "text", text: "…prior…" }] }),
          turn({ uuid: "n", role: "note", parts: [{ kind: "context", label: "task done", text: "" }] }),
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: /^Context compacted/ })).toBeInTheDocument();
    expect(screen.getByText("task done")).toBeInTheDocument();
  });

  it("shows the command the operator typed in their bubble, and the skill it loaded as a line beside it", async () => {
    const { container } = render(<TranscriptView entries={[turn({ role: "user", parts: [
      { kind: "text", text: "/designboard Rediseño del checkout" },
      { kind: "context", label: "Skill · designboard", text: "Base directory for this skill: /skills/designboard" },
    ] })]} />);
    const bubble = container.querySelector('[data-speaker="user"] > div')!;
    expect(bubble).toHaveTextContent("/designboard Rediseño del checkout");
    expect(bubble).not.toHaveTextContent("Skill");
    expect(screen.queryByText(/Base directory/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Skill · designboard", expanded: false }));
    expect(screen.getByText(/Base directory for this skill/)).toBeInTheDocument();
  });

  it("opens a folded line whose body holds the searched words", () => {
    render(<TranscriptView query="green" entries={[turn({ role: "note", parts: [{ kind: "context", label: "Message from nenustop", text: "PR #63 is green." }] })]} />);
    expect(screen.getByRole("button", { name: "Message from nenustop", expanded: true })).toBeInTheDocument();
  });
});

describe("TranscriptView — work folding", () => {
  const activity = turn({ uuid: "work-entry", role: "assistant", turnId: "native-turn", phase: "commentary",
    parts: [{ kind: "text", text: "Checking the import graph." }, { kind: "thinking", text: "Compare dependency direction." }],
    turn: { status: "running", startedAt: "2026-07-25T06:22:00Z" } });
  const final = turn({ uuid: "final-entry", role: "assistant", turnId: "native-turn", phase: "final_answer",
    parts: [{ kind: "text", text: "The dependency cycle is fixed." }],
    turn: { status: "completed", durationMs: 21_000 } });

  it("collapses completed work while leaving the answer and measured duration visible", async () => {
    render(<TranscriptView entries={[activity, final]} activityStatus="done" />);
    const fold = screen.getByRole("button", { name: "Worked for 21s", expanded: false });
    expect(screen.getByText("The dependency cycle is fixed.")).toBeVisible();
    expect(screen.queryByText("Checking the import graph.")).not.toBeInTheDocument();
    await userEvent.click(fold);
    expect(screen.getByText("Checking the import graph.")).toBeVisible();
    expect(screen.getByText("The dependency cycle is fixed.")).toBeVisible();
    await userEvent.click(fold);
    // It folds as a panel does, then leaves the page.
    await waitFor(() => expect(screen.queryByText("Checking the import graph.")).not.toBeInTheDocument());
    expect(screen.getByText("The dependency cycle is fixed.")).toBeVisible();
  });

  it("says how long the turn worked as Worked for 1m 52s", () => {
    const long = { ...final, turn: { status: "completed" as const, durationMs: 112_000 } };
    render(<TranscriptView entries={[activity, long]} activityStatus="done" />);
    expect(screen.getByRole("button", { name: "Worked for 1m 52s", expanded: false })).toHaveTextContent(/^Worked for 1m 52s$/);
  });

  it("says a stopped turn stopped, and after how long when the journal measured it", () => {
    const stopped = (turnState: TranscriptEntry["turn"]) => [activity, { ...final, phase: undefined, turn: turnState }];
    const { rerender } = render(<TranscriptView entries={stopped({ status: "aborted", durationMs: 9_000 })} activityStatus="idle" />);
    expect(screen.getByRole("button", { name: "Stopped after 9s" })).toBeInTheDocument();
    rerender(<TranscriptView entries={stopped({ status: "aborted" })} activityStatus="idle" />);
    expect(screen.getByRole("button", { name: "Stopped" })).toBeInTheDocument();
  });

  it("lets the work flow in the conversation under its line, with no rail or indent, running or reopened", async () => {
    const { container, rerender } = render(<TranscriptView entries={[activity]} activityStatus="working" />);
    expect(container.querySelector("[data-step]")!.closest(".border-l, .pl-3")).toBeNull();
    rerender(<TranscriptView entries={[activity, final]} activityStatus="done" />);
    await waitFor(() => expect(container.querySelector("[data-step]")).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Worked for 21s" }));
    expect(container.querySelector("[data-step]")!.closest(".border-l, .pl-3")).toBeNull();
  });

  it("leaves no empty box under a message that names no media", () => {
    const { container } = render(<FileMediaContext.Provider value={() => "/api/file"}>
      <TranscriptView entries={[turn({ uuid: "q" }), turn({ uuid: "a", role: "assistant", parts: [{ kind: "text", text: "Done, nothing to show." }] })]} />
    </FileMediaContext.Provider>);
    expect(container.querySelectorAll("[data-speaker] div:empty")).toHaveLength(0);
  });

  it("animates the work it opens only when you open it, never on its own", async () => {
    const { container, rerender } = render(<TranscriptView entries={[activity]} activityStatus="working" />);
    // Open by itself while it runs: it draws in place.
    const turnBody = () => container.querySelector("[data-work-turn] > .fold");
    expect(turnBody()).toHaveAttribute("data-phase", "open");
    rerender(<TranscriptView entries={[activity, final]} activityStatus="done" />);
    await waitFor(() => expect(turnBody()).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Worked for 21s" }));
    // Tapped, it folds open as a panel does (index.css's .fold), then settles.
    expect(turnBody()).toHaveAttribute("data-phase", "opening");
    await waitFor(() => expect(turnBody()).toHaveAttribute("data-phase", "open"));
  });

  it("opens active work, then collapses it automatically on completion", async () => {
    const { rerender } = render(<TranscriptView entries={[activity]} activityStatus="working" />);
    expect(screen.getByRole("button", { name: /^Working/, expanded: true })).toBeInTheDocument();
    expect(screen.getByText("Checking the import graph.")).toBeVisible();
    rerender(<TranscriptView entries={[activity, final]} activityStatus="done" />);
    expect(screen.getByRole("button", { name: "Worked for 21s", expanded: false })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Checking the import graph.")).not.toBeInTheDocument());
    expect(screen.getByText("The dependency cycle is fixed.")).toBeVisible();
  });

  it("preserves an explicit open choice so completion does not remove work being read", async () => {
    const { rerender } = render(<TranscriptView entries={[activity]} activityStatus="working" />);
    const fold = screen.getByRole("button", { name: /^Working/, expanded: true });
    await userEvent.click(fold);
    await userEvent.click(fold);
    rerender(<TranscriptView entries={[activity, final]} activityStatus="done" />);
    expect(screen.getByRole("button", { name: "Worked for 21s", expanded: true })).toBeInTheDocument();
    expect(screen.getByText("Checking the import graph.")).toBeVisible();
    expect(screen.getByText("The dependency cycle is fixed.")).toBeVisible();
  });

  it("a query opens completed work and its matching thinking detail, then restores the fold", () => {
    const { rerender } = render(<TranscriptView entries={[activity, final]} activityStatus="done" query="dependency direction" />);
    expect(screen.getByRole("button", { name: "Worked for 21s", expanded: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Thinking: /, expanded: true })).toBeInTheDocument();
    expect(screen.getByText("dependency direction")).toBeVisible();
    rerender(<TranscriptView entries={[activity, final]} activityStatus="done" />);
    expect(screen.getByRole("button", { name: "Worked for 21s", expanded: false })).toBeInTheDocument();
  });

  it("a focused tool entry opens all nested disclosures and has one scroll marker", () => {
    const action = turn({ uuid: "tool-entry", role: "assistant", turnId: "native-turn", parts: [{ kind: "tool", name: "Read", summary: "src/app.ts", result: { text: "source contents" } }] });
    const { container } = render(<TranscriptView entries={[action, final]} activityStatus="done" focusedUuid="tool-entry" />);
    expect(screen.getByRole("button", { name: /^Worked for 21s/, expanded: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Read src/app.ts", expanded: true })).toBeInTheDocument();
    expect(screen.getByText("source contents")).toBeVisible();
    expect(container.querySelectorAll('[data-turn="tool-entry"]')).toHaveLength(1);
  });

  it("preserves an expanded fold when older unrelated turns are prepended", async () => {
    const { rerender } = render(<TranscriptView entries={[activity, final]} activityStatus="done" />);
    await userEvent.click(screen.getByRole("button", { name: "Worked for 21s" }));
    const old = turn({ uuid: "old-work", role: "assistant", turnId: "old-turn", parts: [{ kind: "tool", name: "Read", summary: "old.ts" }], turn: { status: "completed" } });
    rerender(<TranscriptView entries={[old, activity, final]} activityStatus="done" />);
    expect(screen.getByRole("button", { name: "Worked for 21s", expanded: true })).toBeInTheDocument();
    expect(screen.getByText("Checking the import graph.")).toBeVisible();
  });
});

it("shows uploaded images as compact previews instead of local paths", () => {
  const path = "/Users/operator/.local/state/collie/uploads/pane-mabcd123-1234abcd.png";
  render(<FileMediaContext.Provider value={() => "/api/preview.png"}>
    <TranscriptView entries={[turn({ parts: [{ kind: "text", text: `Look at this ${path}` }] })]} />
  </FileMediaContext.Provider>);
  expect(screen.getByRole("img")).toHaveAttribute("src", "/api/preview.png");
  expect(screen.queryByText(path, { exact: false })).not.toBeInTheDocument();
  expect(screen.getByRole("img")).toHaveAccessibleName("Image 1");
});

it("keeps the agent question visible when its work log is collapsed", () => {
  render(<TranscriptView entries={[turn({ role: "assistant", turn: { status: "completed" }, parts: [{ kind: "tool", name: "request_user_input_async", summary: "Question", questions: [{ title: "Which source?", options: ["Web", "Instagram"] }] }] })]} />);
  expect(screen.getByRole("region", { name: "Agent question" })).toBeVisible();
  expect(screen.getByText("Which source?")).toBeVisible();
});

it("prepares a selected question answer without submitting a terminal action", async () => {
  const prepare = vi.fn();
  render(<QuestionReplyContext.Provider value={prepare}><TranscriptView entries={[turn({ role: "assistant", turn: { status: "completed" }, parts: [{ kind: "tool", name: "request_user_input_async", summary: "Question", questions: [{ title: "Which source?", options: ["Web", "Instagram"] }] }] })]} /></QuestionReplyContext.Provider>);
  await userEvent.click(screen.getByRole("button", { name: "Instagram" }));
  expect(prepare).toHaveBeenCalledWith("Which source?\nInstagram");
});

describe("journal media", () => {
  const withViewer = (ui: React.ReactNode) => <FilePreviewProvider paneId="w1:p1">{ui}</FilePreviewProvider>;
  // /history sends image markers with no text; the web union does not list them yet.
  const image = (index: number) => ({ kind: "image", index, mediaType: "image/png" }) as unknown as TranscriptEntry["parts"][number];

  it("shows a pasted image from the journal by entry and index, without a path or a crash", () => {
    render(withViewer(<TranscriptView query="look" entries={[turn({ uuid: "u-paste", parts: [{ kind: "text", text: "[Image #1] look" }, image(0)] })]} />));
    expect(screen.getByRole("img", { name: "Image 1" })).toHaveAttribute("src", "/api/pane/w1%3Ap1/journal-image?entry=u-paste&n=0");
  });

  // ADR 0104: the k-th token is the message's k-th picture, whatever number the CLI gave it.
  const order = (bubble: HTMLElement) => {
    const out: string[] = [];
    const walk = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let node = walk.nextNode(); node; node = walk.nextNode()) {
      if (node instanceof HTMLImageElement) out.push(`<${node.alt}>`);
      else if (node.nodeType === Node.TEXT_NODE && node.textContent!.trim()) out.push(node.textContent!.trim());
    }
    return out.join(" ");
  };

  it("draws each picture of your message where its token was, as Claude logs it", () => {
    render(withViewer(<TranscriptView entries={[turn({ uuid: "u-placed", parts: [{ kind: "text", text: "first the red one [Image #6] then the blue one [Image #7] and that is all" }, image(0), image(1)] })]} />));
    const bubble = document.querySelector<HTMLElement>('[data-speaker="user"]')!;
    expect(order(bubble)).toMatch(/^first the red one <Image 1> then the blue one <Image 2> and that is all/);
    expect(bubble).not.toHaveTextContent("[Image #6]");
  });

  it("draws them in place from Codex's shape too: the pictures first, then the text with the tokens", () => {
    render(withViewer(<TranscriptView entries={[turn({ uuid: "u-codex", parts: [image(0), image(1), { kind: "text", text: "first [Image #1]  then [Image #2]  end" }] })]} />));
    expect(order(document.querySelector<HTMLElement>('[data-speaker="user"]')!)).toMatch(/^first <Image 1> then <Image 2> end/);
  });

  it("puts a picture the words never place after them, and leaves an unmatched token as words", () => {
    render(withViewer(<TranscriptView entries={[turn({ uuid: "u-extra", parts: [{ kind: "text", text: "look [Image #1]" }, image(0), image(1)] })]} />));
    expect(order(document.querySelector<HTMLElement>('[data-speaker="user"]')!)).toMatch(/^look <Image 1> <Image 2>/);
  });

  it("draws a picture path left in the text where it was", () => {
    const up = "/home/you/.local/state/nenu/uploads/w1_p1-mv8g-0a1b2c3d.png";
    render(withViewer(<TranscriptView entries={[turn({ uuid: "u-path", parts: [{ kind: "text", text: `before ${up} after` }] })]} />));
    expect(order(document.querySelector<HTMLElement>('[data-speaker="user"]')!)).toMatch(/^before <Image 1> after/);
  });

  it("shows what a tool returned as thumbnails, addressed through the entry that made the call", async () => {
    render(withViewer(<TranscriptView activityStatus="working" entries={[
      turn({ uuid: "ask", parts: [{ kind: "text", text: "check the screenshot" }] }),
      turn({ uuid: "call", role: "assistant", parts: [{ kind: "tool", name: "Read", summary: "/tmp/shot.png", result: { text: "", attachments: [{ kind: "image", index: 0, mediaType: "image/png" }] } }] }),
    ]} />));
    expect(await screen.findByRole("img", { name: "Image 1" })).toHaveAttribute("src", "/api/pane/w1%3Ap1/journal-image?entry=call&n=0");
  });

  it("keeps what a folded run of calls returned in sight under its line, the turn open", () => {
    const read = (uuid: string, summary: string) => turn({ uuid, role: "assistant", turnId: "t", turn: { status: "running" },
      parts: [{ kind: "tool", name: "Read", summary, result: { text: "", attachments: [{ kind: "image" as const, index: 0 }] } }] });
    render(withViewer(<TranscriptView activityStatus="working" entries={[turn({ uuid: "ask", parts: [{ kind: "text", text: "shots" }] }), read("a", "a.png"), read("b", "b.png")]} />));
    expect(screen.getByRole("button", { name: "Read 2 files", expanded: false })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Images these steps returned" }).querySelectorAll("img")).toHaveLength(2);
  });

  it("keeps the images of folded work visible as one gallery for the turn", () => {
    render(withViewer(<TranscriptView activityStatus="done" entries={[
      turn({ uuid: "ask", parts: [{ kind: "text", text: "shots" }] }),
      turn({ uuid: "call", role: "assistant", turn: { status: "completed" }, parts: [{ kind: "tool", name: "Read", summary: "a.png", result: { text: "", attachments: [0, 1, 2, 3, 4].map((index) => ({ kind: "image" as const, index })) } }] }),
      turn({ uuid: "done", role: "assistant", phase: "final_answer", turn: { status: "completed" }, parts: [{ kind: "text", text: "Done." }] }),
    ]} />));
    expect(screen.getByRole("button", { name: /^Worked/, expanded: false })).toBeInTheDocument();
    const strip = screen.getByRole("list", { name: "Images from this turn" });
    expect(strip.querySelectorAll("img")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Open 2 more images" })).toBeInTheDocument();
  });

  it("shows a delivered HTML file as a card that mounts no frame until opened", async () => {
    server.use(http.get(/\/api\/pane\/[^/]+\/files$/, ({ request }) => HttpResponse.json(
      new URL(request.url).searchParams.getAll("inspect").map((path) => ({ path, state: "preview" })))));
    render(withViewer(<TranscriptView activityStatus="done" entries={[
      turn({ uuid: "ask", parts: [{ kind: "text", text: "make a page" }] }),
      turn({ uuid: "send", role: "assistant", turn: { status: "completed" }, parts: [{ kind: "tool", name: "SendUserFile", summary: "/tmp/out/report.html", result: { text: "sent", attachments: [{ kind: "file", path: "/tmp/out/report.html" }] } }] }),
      turn({ uuid: "done", role: "assistant", phase: "final_answer", turn: { status: "completed" }, parts: [{ kind: "text", text: "Here it is." }] }),
    ]} />));
    const card = await screen.findByRole("link", { name: "Open report.html" });
    // A real link to the file's own page, so a long-press or a modified click opens it in a new tab.
    expect(card).toHaveAttribute("href", "/pane/w1%3Ap1/file?path=%2Ftmp%2Fout%2Freport.html");
    expect(card).toHaveTextContent("HTML page · out/");
    expect(document.querySelector("iframe")).toBeNull();
    await userEvent.click(card);
    const frame = await screen.findByTitle("Rendered preview of report.html");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  });

  // The designboard pane's compaction summary named files relative to other folders; each became an
  // Open card that answered 404. A recap or a system note names files, it does not hand them over.
  it("shows no cards for the files a compaction summary or a system note names", async () => {
    render(withViewer(<TranscriptView entries={[
      turn({ uuid: "s", role: "summary", parts: [{ kind: "text", text: "Key files: `assets/canvas.template.html`, the real one `real/scroll.html`, shots in frames/frame1.png." }] }),
      turn({ uuid: "n", role: "note", parts: [{ kind: "text", text: "Base directory for this skill: /skills/designboard\n\nOpen assets/canvas.template.html or report.html" }] }),
    ]} />));
    await userEvent.click(screen.getByRole("button", { name: /^Context compacted/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Base directory for this skill/ }));
    expect(screen.queryByRole("link", { name: /^Open / })).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    // The names stay in the text, and a code-formatted one still opens by name.
    expect(screen.getByRole("link", { name: "assets/canvas.template.html" })).toHaveAttribute("href", "/pane/w1%3Ap1/file?path=assets%2Fcanvas.template.html");
  });

  // The phone drew this link as plain text over a "resumen-del-dia.html · 8443/ · Not found" card.
  it("opens a web URL in prose as a link, with no file card for the page it names", async () => {
    const href = "https://rise-l.taild6bfcf.ts.net:8443/resumen-del-dia.html";
    render(withViewer(<TranscriptView entries={[turn({ role: "assistant", parts: [{ kind: "text", text: `Resumen al día: ${href}` }] })]} />));
    expect(screen.getByRole("link", { name: href })).toHaveAttribute("href", href);
    expect(screen.queryByRole("button", { name: /resumen-del-dia\.html/ })).not.toBeInTheDocument();
  });

  it("opens a Markdown link to a web page and draws no card for it", async () => {
    // The second capture: the link opened, and the "8443/ · Not found" card stayed under it.
    const href = "https://rise-l.taild6bfcf.ts.net:8443/resumen-del-dia.html";
    render(withViewer(<TranscriptView entries={[turn({ role: "assistant", parts: [{ kind: "text", text: `Te paso los links con nombre, como [el resumen del día](${href}), que Nenu ya deja tocar.` }] })]} />));
    expect(screen.getByRole("link", { name: "el resumen del día" })).toHaveAttribute("href", href);
    expect(screen.queryByRole("button", { name: /resumen-del-dia\.html/ })).not.toBeInTheDocument();
  });

  it("draws a card only for a file the bridge finds, and nothing for a name with nothing behind it", async () => {
    const asked: string[] = [];
    server.use(http.get(/\/api\/pane\/[^/]+\/files$/, ({ request }) => {
      const names = new URL(request.url).searchParams.getAll("inspect");
      asked.push(...names);
      return HttpResponse.json(names.map((path) => path === "later.html" ? { path, state: "missing" } : { path, state: "preview", resolved: `/repo/${path}` }));
    }));
    render(withViewer(<TranscriptView entries={[turn({ role: "assistant", parts: [{ kind: "text", text: "Edited `assets/canvas.template.html`; writing `later.html` next." }] })]} />));
    // Each step is a request and a render; a loaded machine (the pre-push hook beside other suites)
    // needs more than findBy's default second for them.
    const slow = { timeout: 5000 };
    await userEvent.click(await screen.findByRole("link", { name: "Open canvas.template.html" }, slow));
    // The line under the name is the folder; its tooltip is the whole path the preview opened.
    const viewer = await screen.findByRole("dialog", { name: "canvas.template.html" }, slow);
    expect(within(viewer).getByTitle("/repo/assets/canvas.template.html")).toHaveTextContent("/repo/assets");
    expect(asked).toContain("later.html");
    expect(screen.queryByRole("button", { name: /later\.html: / })).not.toBeInTheDocument();
    expect(screen.queryByText("Not found")).not.toBeInTheDocument();
  });

  it("shows a named image only once the bridge finds it, from where it found it", async () => {
    server.use(http.get(/\/api\/pane\/[^/]+\/files$/, ({ request }) => HttpResponse.json(
      new URL(request.url).searchParams.getAll("inspect").map((path) => path === "shots/gone.png"
        ? { path, state: "missing" }
        : { path, state: "preview", resolved: `/repo/${path}` }))));
    render(withViewer(<TranscriptView entries={[turn({ role: "assistant", parts: [{ kind: "text", text: "Before: shots/home.png. The old one, shots/gone.png, is deleted." }] })]} />));
    const image = await screen.findByRole("img", { name: "home.png" }, { timeout: 5000 });
    expect(image).toHaveAttribute("src", `/api/pane/w1%3Ap1/file?path=${encodeURIComponent("/repo/shots/home.png")}`);
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /gone\.png/ })).not.toBeInTheDocument();
  });

  it("renders a local Markdown image in place and keeps it out of the media list below", () => {
    render(withViewer(<TranscriptView entries={[turn({ role: "assistant", parts: [{ kind: "text", text: "Before ![the home screen](shots/home.png) after" }] })]} />));
    const images = screen.getAllByRole("img");
    expect(images).toHaveLength(1);
    expect(images[0]).toHaveAttribute("alt", "the home screen");
    expect(images[0]).toHaveAttribute("src", "/api/pane/w1%3Ap1/file?path=shots%2Fhome.png");
  });
});

it("treats an AskUserQuestion that already has its answer as closed", () => {
  render(<QuestionReplyContext.Provider value={vi.fn()}><TranscriptView entries={[turn({ role: "assistant", turn: { status: "completed" }, parts: [{ kind: "tool", name: "AskUserQuestion", summary: "Question", questions: [{ title: "Which source?", options: ["Web", "Instagram"] }], result: { text: "User answered: Web" } }] })]} /></QuestionReplyContext.Provider>);
  expect(screen.getByRole("button", { name: "Instagram" })).toBeDisabled();
});

it("leaves a live question to the card under it, and only that one", () => {
  const asked = [turn({ role: "assistant", turn: { status: "running" }, parts: [
    { kind: "tool", name: "AskUserQuestion", summary: "Question", questions: [{ title: "Which source?", options: ["Web", "Instagram"] }], result: { text: "User answered: Web" } },
    { kind: "tool", name: "AskUserQuestion", summary: "Question", questions: [{ title: "Which format?", options: ["CSV", "JSON"] }] },
  ] })];
  const view = (live: "card" | "dialog" | null) => <QuestionLiveContext.Provider value={live}><QuestionReplyContext.Provider value={vi.fn()}><TranscriptView entries={asked} /></QuestionReplyContext.Provider></QuestionLiveContext.Provider>;
  const { rerender } = render(view(null));
  expect(screen.getAllByRole("region", { name: "Agent question" })).toHaveLength(2);
  rerender(view("card"));
  expect(screen.getByRole("region", { name: "Agent question" })).toHaveTextContent("Which source?");
  // A dialog the card does not draw (a preview, a menu) leaves the question in the transcript, without prepare buttons.
  rerender(view("dialog"));
  expect(screen.getAllByRole("region", { name: "Agent question" })).toHaveLength(2);
  expect(screen.queryByText(/prepare your reply/)).not.toBeInTheDocument();
});

// A turn reads as a timeline: one row per step, the failure on its own row, and while the agent
// works, the step in progress at the bottom saying what it is doing now.
describe("TranscriptView — the work timeline", () => {
  const at = (hm: string) => `2026-07-25T${hm}:00`;
  const ask = turn({ uuid: "ask", ts: at("09:05"), parts: [{ kind: "text", text: "Fix the composer gap." }] });
  const step = (uuid: string, hm: string, parts: TranscriptEntry["parts"], extra: Partial<TranscriptEntry> = {}) =>
    turn({ uuid, ts: at(hm), role: "assistant", turnId: "t1", ...extra, parts });
  const settled = [
    ask,
    step("think", "09:05", [{ kind: "thinking", text: "The inset is counted twice.\nLook at the viewport hook." }]),
    step("grep", "09:06", [{ kind: "tool", name: "Grep", summary: "safe-area-inset-bottom", result: { text: "web/src/workbench.css:212" } }]),
    step("edit", "09:06", [{ kind: "tool", name: "Edit", summary: "/home/demo/repo/web/src/index.css", result: { text: "updated" } }]),
    step("test", "09:07", [{ kind: "tool", name: "Bash", summary: "bun run test composer", result: { text: "FAIL composer.test.tsx", isError: true } }]),
    step("final", "09:09", [{ kind: "text", text: "Fixed." }], { phase: "final_answer", turn: { status: "completed", durationMs: 252_000 } }),
  ];
  const clock = (hm: string) => new Date(at(hm)).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  // Claude read a queued message mid-turn: it sits between the work it split (as T3 Code draws a steer).
  it("splits a turn a queued message cut at that message: each line its part, Continued there from the start", () => {
    const running = { status: "running" as const, startedAt: at("09:05") };
    const steer = turn({ uuid: "steer", ts: at("09:06"), turnId: "t1", parts: [{ kind: "text", text: "y al final decime cuántos archivos hay" }], turn: running });
    const { container, rerender } = render(<TranscriptView activityStatus="working" entries={[
      ask, step("grep", "09:05", [{ kind: "tool", name: "Grep", summary: "inset", result: { text: "x" } }], { turn: running }), steer,
    ]} />);
    // The part above is over at the message; the line that continues the turn is already under it.
    expect(screen.getByRole("button", { name: /^Worked for 1m 0s/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Working for/ })).not.toBeInTheDocument();
    const thinking = container.querySelector('[data-live-step="thinking"]')!;
    expect(thinking.previousElementSibling).toHaveTextContent(/^Continued for/);
    const done = { status: "completed" as const, startedAt: at("09:05"), completedAt: at("09:08"), durationMs: 180_000 };
    rerender(<TranscriptView activityStatus="done" entries={[
      ask, step("grep", "09:05", [{ kind: "tool", name: "Grep", summary: "inset", result: { text: "x" } }], { turn: done }), { ...steer, turn: done },
      step("ls", "09:07", [{ kind: "tool", name: "Bash", summary: "ls", result: { text: "a b" } }], { turn: done }),
      step("final", "09:08", [{ kind: "text", text: "Hay 2." }], { phase: "final_answer", turn: done }),
    ]} />);
    // The two lines add up to the turn's 3m.
    expect(screen.getByRole("button", { name: /^Worked for 1m 0s/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Continued for 2m 0s/ })).toBeInTheDocument();
    expect(screen.getByText("y al final decime cuántos archivos hay")).toBeInTheDocument();
  });

  it("opens a finished turn onto the one line of its calls, the thought among them, each a tap from its output", async () => {
    render(<TranscriptView entries={settled} activityStatus="done" />);
    const fold = screen.getByRole("button", { name: /^Worked for 4m 12s/, expanded: false });
    // The failure shows on the folded line, before anything is opened.
    expect(fold).toHaveTextContent("1 failed");
    await userEvent.click(fold);
    // The line counts the calls; the thought that led into them folds with them.
    const run = screen.getByRole("button", { name: "Searched 1 pattern, edited 1 file, ran 1 command, 1 failed", expanded: false });
    expect(screen.queryByRole("button", { name: /^Searched safe-area-inset-bottom/ })).not.toBeInTheDocument();
    await userEvent.click(run);
    expect(screen.getByRole("button", { name: "Thinking: The inset is counted twice." })).toHaveTextContent("The inset is counted twice.");
    expect(screen.getByRole("button", { name: /^Searched safe-area-inset-bottom/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Edited / })).toHaveTextContent("index.css");
    expect(screen.queryByText(/tool calls?/)).not.toBeInTheDocument();
    // The failed step is one tap from its output.
    const failed = screen.getByRole("button", { name: /^Ran bun run test composer Failed/ });
    expect(failed).toHaveTextContent("Failed");
    await userEvent.click(failed);
    expect(screen.getByText("FAIL composer.test.tsx")).toBeVisible();
  });

  it("times your message and the finished turn once each, with no leading zero", () => {
    const { container } = render(<TranscriptView entries={settled} activityStatus="done" />);
    expect(clock("09:05")).toMatch(/^9:05/);
    expect(screen.getAllByText(clock("09:05"))).toHaveLength(1);
    const line = container.querySelector("[data-work-turn]")!;
    expect(line).toHaveTextContent(clock("09:09"));
    expect(container.textContent!.split(clock("09:09")).length - 1).toBe(1);
    expect(container.textContent).not.toMatch(/\b0\d:\d\d/);
  });

  it("puts the finished turn's time at the end of its Worked line, not beside its answer's Copy", () => {
    const { container } = render(<TranscriptView entries={settled} activityStatus="done" />);
    const line = screen.getByRole("button", { name: /^Worked for 4m 12s/ }).parentElement!;
    expect(line).toHaveTextContent(clock("09:09"));
    const answer = container.querySelector('[data-work-turn] [data-speaker="assistant"]') as HTMLElement;
    expect(answer).not.toHaveTextContent(clock("09:09"));
    expect(container.querySelectorAll("[data-work-turn] time")).toHaveLength(1);
  });

  it("gives a turn that ends in the minute it started no second time, since its question already shows it", () => {
    const { container } = render(<TranscriptView activityStatus="done" entries={[
      ask,
      step("look", "09:05", [{ kind: "tool", name: "Grep", summary: "x", result: { text: "y" } }]),
      step("final", "09:05", [{ kind: "text", text: "Done." }], { phase: "final_answer", turn: { status: "completed", durationMs: 17_000 } }),
    ]} />);
    expect(screen.getByRole("button", { name: /^Worked for 17s/ })).toBeInTheDocument();
    expect(screen.getAllByText(clock("09:05"))).toHaveLength(1);
    expect(container.querySelector("[data-work-turn] time")).toBeNull();
  });

  const working = (last: TranscriptEntry["parts"]) => [
    ask,
    step("read", "09:06", [{ kind: "tool", name: "Read", summary: "/repo/web/src/components/tab-strip.tsx", result: { text: "import" } }], { turn: { status: "running", startedAt: at("09:05") } }),
    step("now", "09:07", last, { turn: { status: "running", startedAt: at("09:05") } }),
  ];

  it("says Working on the turn and draws the running step in its run, where it stays, drawn once", async () => {
    const { container, rerender } = render(<TranscriptView entries={working([{ kind: "tool", name: "Bash", summary: "bun run test tab-strip" }])} activityStatus="working" />);
    const header = screen.getByRole("button", { name: /^Working/, expanded: true });
    expect(header).not.toHaveTextContent("Thinking");
    const live = container.querySelector("[data-live-step]")!;
    expect(live).toHaveTextContent("Running");
    expect(live).toHaveTextContent("bun run test tab-strip");
    expect(screen.getAllByText("bun run test tab-strip")).toHaveLength(1);
    // In its run, after the step before it, never in a row of its own under the turn.
    const rows = [...container.querySelectorAll("[data-work-log] > li")];
    expect(rows.at(-1)).toBe(live);
    expect(rows.at(-2)).toHaveTextContent("tab-strip.tsx");
    // Done, it is the same row, now in the past tense, and nothing says Running.
    rerender(<TranscriptView entries={working([{ kind: "tool", name: "Bash", summary: "bun run test tab-strip", result: { text: "ok" } }])} activityStatus="working" />);
    expect(container.querySelectorAll("[data-work-log] > li").item(1)).toBe(live);
    expect(live).not.toHaveAttribute("data-live-step");
    expect(screen.getByRole("button", { name: "Ran bun run test tab-strip" })).toBeInTheDocument();
    await userEvent.click(header);
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Read / })).not.toBeInTheDocument());
  });

  it("says Thinking with the thought's first line on the bottom row, never on the turn's line", () => {
    const { container } = render(<TranscriptView entries={working([{ kind: "thinking", text: "Now the chip height.\nThen the e2e." }])} activityStatus="working" />);
    expect(screen.getByRole("button", { name: /^Working/ })).not.toHaveTextContent("Thinking");
    expect(container.querySelector("[data-live-step]")).toHaveTextContent("ThinkingNow the chip height.");
    // Drawn once: the thought is the bottom row, not also a step above it.
    expect(screen.getAllByText("Now the chip height.")).toHaveLength(1);
  });

  it("previews a thought's bold title on the bottom row without its asterisks", () => {
    const { container } = render(<TranscriptView entries={working([{ kind: "thinking", text: "**Inspecting the inset**\n\nThe composer adds it twice." }])} activityStatus="working" />);
    expect(container.querySelector("[data-live-step]")).toHaveTextContent("Inspecting the inset");
    expect(container.querySelector("[data-live-step]")).not.toHaveTextContent("*");
  });

  it("keeps the agent that still runs on the bottom row when a parallel one finishes first", () => {
    const running = { turn: { status: "running" as const, startedAt: at("09:05") } };
    const { container } = render(<TranscriptView activityStatus="working" entries={[
      ask,
      step("a", "09:06", [{ kind: "tool", name: "Task", summary: "Audit the tab strip" }], running),
      step("b", "09:06", [{ kind: "tool", name: "Task", summary: "Audit the composer", result: { text: "fine" } }], running),
    ]} />);
    const live = container.querySelector("[data-live-step]")!;
    expect(live).toHaveTextContent("Running agent");
    expect(live).toHaveTextContent("Audit the tab strip");
    expect(screen.getAllByText("Audit the tab strip")).toHaveLength(1);
  });

  // The step in progress is the one the operator most wants to read whole: it opens like any step.
  const command = "cd web && bun run test tab-strip --watch=false";
  const liveRow = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-live-step]")!;

  it("opens the running step with one tap onto its whole command, still running", async () => {
    const { container } = render(<TranscriptView entries={working([{ kind: "tool", name: "Bash", summary: command }])} activityStatus="working" />);
    const row = within(liveRow(container)).getByRole("button", { name: `Running ${command}`, expanded: false });
    await userEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(within(liveRow(container)).getByText("Running…")).toBeVisible();
    expect(liveRow(container).querySelector("pre")).toHaveTextContent(command);
  });

  it("opens the thought being written onto the whole of it", async () => {
    const { container } = render(<TranscriptView entries={working([{ kind: "thinking", text: "Now the chip height.\nThen the e2e." }])} activityStatus="working" />);
    await userEvent.click(within(liveRow(container)).getByRole("button", { name: /^Thinking/ }));
    expect(screen.getByText(/Then the e2e\./)).toBeVisible();
  });

  it("opens the running step on a search hit inside it, and marks the hit", () => {
    const { container } = render(<TranscriptView query="watch=false" entries={working([{ kind: "tool", name: "Bash", summary: command }])} activityStatus="working" />);
    expect(within(liveRow(container)).getByRole("button", { name: /^Running/ })).toHaveAttribute("aria-expanded", "true");
    expect(liveRow(container).querySelector("mark")).toHaveTextContent("watch=false");
  });

  it("opens the running step when search focus lands on its entry", () => {
    const { container } = render(<TranscriptView focusedUuid="now" entries={working([{ kind: "tool", name: "Bash", summary: command }])} activityStatus="working" />);
    expect(within(liveRow(container)).getByRole("button", { name: /^Running/ })).toHaveAttribute("aria-expanded", "true");
  });

  // A toggle reports itself so the thread can hold still and stop following, and a held thread
  // draws no turn as running. The live row is the tail the thread follows: opening it must keep the
  // turn live, so it does not report.
  it("opens the running step without holding the thread still, and a finished step still does", async () => {
    const onWorkToggle = vi.fn();
    const { container } = render(<TranscriptView entries={working([{ kind: "tool", name: "Bash", summary: command }])} activityStatus="working" onWorkToggle={onWorkToggle} />);
    await userEvent.click(within(liveRow(container)).getByRole("button", { name: /^Running/ }));
    expect(onWorkToggle).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /^Read / }));
    expect(onWorkToggle).toHaveBeenCalledTimes(1);
  });

  // The system's tooltip of a hover title faded in over the bubble as a ghost of its time (1.41.1).
  it("gives no row of the thread a hover title", () => {
    const { container } = render(<TranscriptView entries={settled} activityStatus="done" />);
    expect(container.querySelector('[data-speaker="user"]')).not.toHaveAttribute("title");
    expect([...container.querySelectorAll("[data-turn], [data-speaker], [data-notice]")].filter((el) => el.hasAttribute("title"))).toEqual([]);
  });

  it("draws the live line as its word glowing beside a quiet time, read as Working for", () => {
    render(<TranscriptView entries={working([{ kind: "tool", name: "Bash", summary: "ls" }])} activityStatus="working" />);
    const line = screen.getByRole("button", { name: /^Working for/ });
    expect(line.querySelector("[data-glow]")).toHaveTextContent(/^Working$/);
  });

  it("says Thinking where the next step will land while no step is in flight", () => {
    const { container } = render(<TranscriptView entries={working([{ kind: "tool", name: "Grep", summary: "chip", result: { text: "chip.tsx" } }])} activityStatus="working" />);
    expect(screen.getByRole("button", { name: /^Working/ })).toBeInTheDocument();
    const thinking = container.querySelector('[data-live-step="thinking"]')!;
    expect(thinking).toHaveTextContent("Thinking…");
    expect(thinking.previousElementSibling).toHaveTextContent("Read 1 file, searched 1 pattern");
  });

  it("says nothing more once the turn has ended", () => {
    const { container } = render(<TranscriptView entries={settled} activityStatus="done" />);
    expect(container.querySelector("[data-live-step]")).toBeNull();
  });

  it("draws compaction as a divider that carries its time and opens onto the summary", async () => {
    render(<TranscriptView entries={[turn({ uuid: "s", ts: at("13:40"), role: "summary", parts: [{ kind: "text", text: "The operator asked for X." }] })]} />);
    const divider = screen.getByRole("button", { name: `Context compacted · ${clock("13:40")}`, expanded: false });
    await userEvent.click(divider);
    expect(screen.getByText("The operator asked for X.")).toBeVisible();
  });

  it("draws no text tone from alpha: times, the day, the work line and every step are solid", async () => {
    const { container } = render(<TranscriptView entries={settled} activityStatus="done" />);
    await userEvent.click(screen.getByRole("button", { name: /^Worked / }));
    await userEvent.click(screen.getByRole("button", { name: /^Searched 1 pattern/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Ran bun run test/ }));
    const faded = [...container.querySelectorAll("[class]")].flatMap((el) => [...el.classList].filter((name) => /^text-(muted-foreground|foreground|destructive)\/\d+$/.test(name)));
    expect(faded).toEqual([]);
  });
});

// While a dialog waits on the operator, the newest turn's calls without a result are what it waits
// for: they have not run. Older turns and the history page keep what the journal says.
describe("TranscriptView — a turn waiting on the operator", () => {
  const at = (hm: string) => `2026-07-25T${hm}:00`;
  const old = [
    turn({ uuid: "q0", ts: at("08:00"), parts: [{ kind: "text", text: "Earlier." }] }),
    turn({ uuid: "old", ts: at("08:01"), role: "assistant", turnId: "t0", parts: [{ kind: "tool", name: "Bash", summary: "sleep 9" }] }),
    turn({ uuid: "old-end", ts: at("08:02"), role: "assistant", turnId: "t0", phase: "final_answer", parts: [{ kind: "text", text: "Done earlier." }] }),
  ];
  const blocked = [
    ...old,
    turn({ uuid: "q1", ts: at("09:00"), parts: [{ kind: "text", text: "Seguí con lo que haga falta." }] }),
    turn({ uuid: "a1", ts: at("09:01"), role: "assistant", turnId: "t1", parts: [
      { kind: "text", text: "Antes de seguir necesito una decisión tuya." },
      { kind: "tool", name: "Bash", summary: "echo hi > hello.txt" },
    ] }),
  ];
  const view = (live: "card" | "dialog" | null, entries = blocked, status: "blocked" | "working" = "blocked") =>
    <QuestionLiveContext.Provider value={live}><TranscriptView entries={entries} activityStatus={status} /></QuestionLiveContext.Provider>;

  it("says the pending call waits on you, in the present, under a live card", () => {
    render(view("card"));
    expect(screen.getByRole("button", { name: "Run echo hi > hello.txt Waiting on you" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Ran echo hi/ })).not.toBeInTheDocument();
  });

  it("says so for a dialog drawn elsewhere too", () => {
    render(view("dialog"));
    expect(screen.getByRole("button", { name: "Run echo hi > hello.txt Waiting on you" })).toBeInTheDocument();
  });

  it("names the question it waits on", () => {
    const asked = [...blocked.slice(0, -1), turn({ uuid: "a1", ts: at("09:01"), role: "assistant", turnId: "t1", parts: [
      { kind: "tool", name: "AskUserQuestion", summary: "", questions: [{ title: "Which source?", options: ["Web", "Instagram"] }] },
    ] })];
    render(view("card", asked));
    expect(screen.getByRole("button", { name: "Question Which source? Waiting on you" })).toBeInTheDocument();
    expect(screen.queryByText("AskUserQuestion")).not.toBeInTheDocument();
  });

  it("waits on the bottom row of a turn the agent's state still calls running", () => {
    const running = blocked.map((entry) => entry.uuid === "a1" ? { ...entry, turn: { status: "running" as const, startedAt: at("09:00") } } : entry);
    const { container } = render(view("card", running, "working"));
    expect(within(container.querySelector<HTMLElement>("[data-live-step]")!).getByRole("button", { name: "Run echo hi > hello.txt Waiting on you" })).toBeInTheDocument();
    expect(container.querySelector<HTMLElement>("[data-live-step]")!.querySelector("[data-glow]")).toBeNull();
  });

  // Claude runs subagents side by side; when one of them asks for a permission, the dialog is the
  // subagent's. Their own calls keep running, and none of them is the request.
  it("keeps parallel subagents running while a dialog inside one waits", () => {
    const agents = [...blocked.slice(0, -1), turn({ uuid: "a1", ts: at("09:01"), role: "assistant", turnId: "t1", parts: [
      { kind: "tool", name: "Task", summary: "Review the parser" },
      { kind: "tool", name: "Task", summary: "Review the UI" },
      { kind: "tool", name: "Task", summary: "Review the tests" },
    ] })];
    render(view("card", agents));
    for (const name of ["Review the parser", "Review the UI", "Review the tests"]) {
      expect(screen.getByRole("button", { name: `Running agent ${name}` })).toBeInTheDocument();
    }
    expect(screen.queryByText("Waiting on you")).not.toBeInTheDocument();
    expect(screen.queryByText("No output recorded")).not.toBeInTheDocument();
  });

  // The agent stops at the first call it needs an answer for; the ones after it have not been reached.
  it("puts the wait on one call, the first the agent stopped at", () => {
    const two = [...blocked.slice(0, -1), turn({ uuid: "a1", ts: at("09:01"), role: "assistant", turnId: "t1", parts: [
      { kind: "tool", name: "Bash", summary: "rm -rf build" },
      { kind: "tool", name: "Bash", summary: "bun run build" },
    ] })];
    render(view("card", two));
    expect(screen.getByRole("button", { name: "Run rm -rf build Waiting on you" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Running bun run build" })).toBeInTheDocument();
    expect(screen.getAllByText("Waiting on you")).toHaveLength(1);
  });

  it("leaves an older turn's missing output as it was", async () => {
    render(view("card"));
    await userEvent.click(screen.getByRole("button", { name: /^Worked/ }));
    expect(screen.getByRole("button", { name: "Ran sleep 9 No output recorded" })).toBeInTheDocument();
  });

  it("claims no wait without a live dialog", () => {
    render(view(null));
    expect(screen.queryByText("Waiting on you")).not.toBeInTheDocument();
  });
});

// Find's current match is drawn solid wherever its words are: prose, a fold, a step.
describe("TranscriptView — the current find match", () => {
  const entries = [
    turn({ uuid: "u1", parts: [{ kind: "text", text: "Fix the composer." }] }),
    turn({ uuid: "n1", role: "note", parts: [{ kind: "context", label: "Message from nenustop", text: "The composer is green." }] }),
    turn({ uuid: "a1", role: "assistant", turnId: "t1", parts: [{ kind: "thinking", text: "The composer gap.\nCounted twice." }] }),
    turn({ uuid: "a2", role: "assistant", turnId: "t1", parts: [{ kind: "tool", name: "Bash", summary: "bun run test composer", result: { text: "ok" } }] }),
    turn({ uuid: "a3", role: "assistant", turnId: "t1", phase: "final_answer", turn: { status: "completed" }, parts: [{ kind: "text", text: "The composer is fixed." }] }),
  ];
  const current = (container: HTMLElement) => [...container.querySelectorAll("mark")].filter((mark) => mark.getAttribute("aria-current") === "true");

  it.each(["u1", "n1", "a1", "a2", "a3"])("marks only the hits of %s as current", (uuid) => {
    const { container } = render(<TranscriptView entries={entries} query="composer" focusedUuid={uuid} activityStatus="done" />);
    const marks = current(container);
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) expect(mark.closest("[data-turn]")).toHaveAttribute("data-turn", uuid);
    expect(container.querySelectorAll("mark").length).toBeGreaterThan(marks.length);
  });
});

describe("TranscriptView — copying a message", () => {
  afterEach(() => Reflect.deleteProperty(navigator, "clipboard"));

  // 0.65.0 had no Copy on a message: the only way out was a long-press selection.
  it("copies the agent's message as the Markdown it wrote, and says Copied", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(
      <TranscriptView
        entries={[
          turn({ uuid: "u1", role: "user", parts: [{ kind: "text", text: "compare them" }] }),
          turn({ uuid: "a1", role: "assistant", parts: [{ kind: "text", text: "**B** wins." }, { kind: "text", text: "| A | B |\n|---|---|\n| 1 | 2 |" }] }),
        ]}
      />,
    );
    const message = screen.getByText("wins.", { exact: false }).closest("[data-speaker]")!;
    // A quiet icon under the message: no word beside it until it has something to say.
    expect(within(message as HTMLElement).getByRole("button", { name: "Copy message" })).toHaveTextContent(/^$/);
    await userEvent.click(within(message as HTMLElement).getByRole("button", { name: "Copy message" }));
    expect(await within(message as HTMLElement).findByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledExactlyOnceWith("**B** wins.\n\n| A | B |\n|---|---|\n| 1 | 2 |");
    // Your own message is yours already.
    const yours = screen.getByText("compare them").closest("[data-speaker]")!;
    expect(within(yours as HTMLElement).queryByRole("button", { name: /^Copy/ })).toBeNull();
  });

  it("leaves the agent's message selectable as text", () => {
    render(<TranscriptView entries={[turn({ uuid: "a1", role: "assistant", parts: [{ kind: "text", text: "Select me." }] })]} />);
    expect(screen.getByText("Select me.").closest("[data-speaker]")).toHaveClass("select-text");
  });
});

