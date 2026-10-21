import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, vi } from "vitest";
import { LiveStepRow, ThinkingStep, ToolStep } from "./work-log-tools";
import { FileMediaContext } from "@/lib/file-preview-context";
import type { TranscriptPart } from "@/lib/types";

type Call = Extract<TranscriptPart, { kind: "tool" }>;
const status: Call = { kind: "tool", name: "Bash", summary: "git status", result: { text: "clean" } };
const failedRead: Call = { kind: "tool", name: "Read", summary: "/file.ts", result: { text: "file contents", isError: true, truncated: true } };
const pending: Call = { kind: "tool", name: "Bash", summary: "pwd" };

function Steps({ calls, query = "", active = false, focused }: { calls: Call[]; query?: string; active?: boolean; focused?: number }) {
  return <>{calls.map((part, i) => <ToolStep key={i} id={`call-${i}`} part={part} query={query} active={active} focused={focused === i} />)}</>;
}

afterEach(() => { vi.useRealTimers(); });

it("draws a command as one line, the command itself, with its output behind one tap", async () => {
  render(<Steps calls={[status]} />);
  const row = screen.getByRole("button", { name: "Ran git status", expanded: false });
  expect(row).toHaveTextContent(/^git status$/);
  expect(screen.queryByText("clean")).not.toBeInTheDocument();
  await userEvent.click(row);
  expect(row).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("clean")).toBeInTheDocument();
});

it("draws a step's line in the quiet greys, so it reads as the agent's work and not its words", () => {
  render(<Steps calls={[status, { kind: "tool", name: "Read", summary: "/repo/app/cart.ts", result: { text: "x" } }]} />);
  expect(screen.getByText("Read")).toHaveClass("text-muted-foreground");
  expect(screen.getByText("git status").parentElement).toHaveClass("text-muted-foreground");
  expect(screen.getByText("cart.ts").parentElement).toHaveClass("text-muted-foreground");
});

it("shows a failed call as Failed on its own line, and opens its output with one tap", async () => {
  render(<Steps calls={[status, failedRead, pending]} />);
  // Every call is its own row: there is no group to open first.
  expect(screen.getAllByRole("button")).toHaveLength(3);
  expect(screen.queryByText(/tool calls?/)).not.toBeInTheDocument();
  const failed = screen.getByRole("button", { name: /^Read \/file\.ts Failed/ });
  expect(failed).toHaveTextContent("Failed");
  await userEvent.click(failed);
  expect(screen.getByText("file contents")).toBeInTheDocument();
  expect(screen.getByText(/output truncated/)).toBeInTheDocument();
});

// A tool the timeline has no verb for is named by itself, and that name can be long. On a phone it
// must give way, so the Failed chip and the chevron stay on the row.
it("keeps a failed call's chip on its row when the tool's own name is long", () => {
  render(<Steps calls={[{ kind: "tool", name: "mcp__plugin_playwright_playwright__browser_take_screenshot", summary: "home-phone.png", result: { text: "Error: Browser is not installed.", isError: true } }]} />);
  const row = screen.getByRole("button", { name: /^browser_take_screenshot home-phone\.png Failed/ });
  expect(within(row).getByText("browser_take_screenshot")).toHaveClass("min-w-0", "truncate");
  expect(within(row).getByText("Failed")).toHaveClass("shrink-0");
});

it("keeps a file's name whole and drops the temp folders in front of it", () => {
  const path = "/var/folders/zd/7_1tqb1n5s7fbmsk0dqnzsk40000gn/T/nenu-e2e-kSVt1n/web/src/hooks/use-app-viewport.ts";
  render(<Steps calls={[{ kind: "tool", name: "Edit", summary: path, result: { text: "updated" } }]} />);
  const row = screen.getByRole("button", { name: `Edited ${path}` });
  expect(screen.getByText("use-app-viewport.ts")).toBeInTheDocument();
  expect(row.textContent).not.toContain("/var/folders");
  expect(row).toHaveTextContent(/hooks\/use-app-viewport\.ts/);
});

it.each(["Read", "/file.ts", "file contents"])("opens only the rows that hold the query %s", (query) => {
  render(<Steps calls={[status, failedRead, pending]} query={query} />);
  expect(screen.getByRole("button", { name: /^Read \/file\.ts/ })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: /^Ran git status/ })).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByText("file contents")).toBeInTheDocument();
});

it("keeps the tool's own name findable: a search for it opens the row that shows it", () => {
  render(<Steps calls={[status]} query="Bash" />);
  expect(screen.getByRole("button", { name: /^Ran git status/ })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("Bash")).toBeInTheDocument();
});

it("treats historical missing output as unknown and only active missing output as running", async () => {
  const { rerender } = render(<Steps calls={[pending]} />);
  expect(screen.getByRole("button", { name: "Ran pwd No output recorded" })).toBeEnabled();
  expect(screen.queryByText("Running…")).not.toBeInTheDocument();
  rerender(<Steps calls={[pending]} active />);
  const running = screen.getByRole("button", { name: "Running pwd" });
  expect(screen.queryByText("No output recorded")).not.toBeInTheDocument();
  await userEvent.click(running);
  expect(screen.getByText("Running…")).toBeInTheDocument();
});

it("reveals literal command/output without Markdown or HTML execution and wraps long content", () => {
  const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const { container } = render(<Steps calls={[{ kind: "tool", name: "Bash", summary: "echo **literal**", result: { text: `## literal heading\n${hostile}` } }]} query="literal" />);
  expect(container.querySelector("img,script,strong,h2")).toBeNull();
  expect(container.textContent).toContain(hostile);
  const details = container.querySelectorAll("pre");
  expect(details).toHaveLength(2);
  for (const detail of details) expect(detail).toHaveClass("whitespace-pre-wrap", "[overflow-wrap:anywhere]");
});

it("opens a focused call without a query", () => {
  render(<Steps calls={[status, failedRead]} focused={1} />);
  expect(screen.getByRole("button", { name: /^Read \/file\.ts/ })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: /^Ran git status/ })).toHaveAttribute("aria-expanded", "false");
  for (const button of screen.getAllByRole("button")) expect(button).toHaveAttribute("data-work-toggle");
});

it("shows the image a read tool opened as a thumbnail, folded or open", async () => {
  render(<FileMediaContext.Provider value={(path) => `/api/file?path=${path}`}>
    <ToolStep id="read" owner="e1" part={{ kind: "tool", name: "Read", summary: "shots/home.png", result: { text: "" } }} query="" active={false} focused={false} />
  </FileMediaContext.Provider>);
  expect(screen.getByRole("img", { name: "home.png" })).toHaveAttribute("src", "/api/file?path=shots/home.png");
  await userEvent.click(screen.getByRole("button", { name: /^Read shots\/home\.png/ }));
  expect(screen.getByRole("img", { name: "home.png" })).toBeInTheDocument();
});

describe("ThinkingStep", () => {
  it("previews the thought's first line on one row and opens the whole of it", async () => {
    render(<ThinkingStep text={"Compare the two implementations.\nThen keep the smaller one."} query="" />);
    // Its name carries the words it shows, so VoiceOver reads them and Voice Control finds the row by them.
    const row = screen.getByRole("button", { name: "Thinking: Compare the two implementations.", expanded: false });
    expect(row).toHaveTextContent("Compare the two implementations.");
    expect(row).not.toHaveTextContent("Then keep the smaller one.");
    await userEvent.click(row);
    expect(screen.getByText(/Then keep the smaller one\./)).toBeInTheDocument();
  });

  it("tells two thoughts apart by name, and says when one was cut short", () => {
    render(<><ThinkingStep text="First look at the hook." query="" /><ThinkingStep text={"Then the chip.\nAnd more."} truncated query="" /></>);
    expect(screen.getByRole("button", { name: "Thinking: First look at the hook." })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Thinking: Then the chip. · truncated" })).toBeInTheDocument();
  });

  it("previews a bold title without its asterisks", () => {
    render(<ThinkingStep text={"**Inspecting TypeScript errors**\n\nThe build fails on the worker config."} query="" />);
    const row = screen.getAllByRole("button")[0]!;
    expect(row).toHaveTextContent("Inspecting TypeScript errors");
    expect(row).not.toHaveTextContent("*");
  });

  it("says Thinking when the thought carries no words, and offers nothing to open", () => {
    render(<ThinkingStep text="" query="" />);
    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("LiveStepRow", () => {
  it("says what runs now with the live mark, and leaves how long to the turn's line", () => {
    const { container } = render(<LiveStepRow step={{ part: { kind: "tool", name: "Bash", summary: "bun run test tab-strip" }, entry: "e", index: 0, since: "2026-09-08T12:00:30Z" }} query="" focused={false} />);
    const row = container.querySelector("[data-live-step]")!;
    expect(row).toHaveTextContent(/^Running\s*bun run test tab-strip$/);
    expect(row.querySelector("[data-live-glyph]")).not.toBeNull();
  });

  it("shows the thought's first line while the agent thinks", () => {
    const { container } = render(<LiveStepRow step={{ part: { kind: "thinking", text: "Ahora ajusto el chip.\nDespués el test." }, entry: "e", index: 0 }} query="" focused={false} />);
    expect(container.querySelector("[data-live-step]")).toHaveTextContent("ThinkingAhora ajusto el chip.");
  });
});

// A call the agent cannot run until the operator answers (a permission, a question, a plan) has not
// run: its line asks in the present, carries the blocked dot, and never says Ran or No output.
describe("a call waiting on the operator", () => {
  const bash: Call = { kind: "tool", name: "Bash", summary: "echo hi > hello.txt" };

  it("reads as the request, Waiting on you, not as a finished call", async () => {
    render(<ToolStep id="c" part={bash} query="" active={false} focused={false} waiting />);
    const row = screen.getByRole("button", { name: "Run echo hi > hello.txt Waiting on you" });
    expect(row).not.toHaveTextContent("Ran");
    expect(screen.queryByText("No output recorded")).not.toBeInTheDocument();
    await userEvent.click(row);
    // The opened call says the same thing its line says, in the same words.
    expect(screen.getAllByText("Waiting on you")).toHaveLength(2);
    expect(screen.queryByText("No output recorded")).not.toBeInTheDocument();
    expect(screen.queryByText("Running…")).not.toBeInTheDocument();
  });

  it("waits without a spinner or a clock even while the turn runs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T12:00:42Z"));
    const { container } = render(<LiveStepRow step={{ part: bash, entry: "e", index: 0, since: "2026-09-08T12:00:30Z" }} query="" focused={false} waiting />);
    expect(screen.getByRole("button", { name: "Run echo hi > hello.txt Waiting on you" })).toBeInTheDocument();
    expect(container.querySelector("[data-live-glyph]")).toBeNull();
    expect(screen.queryByText("<1m")).not.toBeInTheDocument();
  });

  it("keeps a finished call in the past even inside a waiting turn", () => {
    render(<ToolStep id="c" part={status} query="" active={false} focused={false} waiting />);
    expect(screen.getByRole("button", { name: "Ran git status" })).toBeInTheDocument();
    expect(screen.queryByText("Waiting on you")).not.toBeInTheDocument();
  });

  // Every verb the timeline knows has its present form; one it lacks falls back to "…ing", never to a past.
  it.each([
    ["Bash", "Run"], ["Read", "Read"], ["Edit", "Edit"], ["apply_patch", "Edit"], ["Write", "Write"], ["Grep", "Search"],
    ["ls", "List"], ["WebFetch", "Fetch"], ["WebSearch", "Search the web"], ["Task", "Run agent"], ["TodoWrite", "Update the plan"],
    ["mcp__plugin_playwright_playwright__browser_click", "browser_click"],
  ])("asks %s as %s", (name, verb) => {
    render(<ToolStep id="c" part={{ kind: "tool", name, summary: "x" }} query="" active={false} focused={false} waiting />);
    expect(screen.getByRole("button", { name: `${verb} x Waiting on you` })).toBeInTheDocument();
  });
});

// The dialogs a call opens on the operator read by what they are, not by the CLI's tool name.
describe("dialog calls", () => {
  const asked: Call = { kind: "tool", name: "AskUserQuestion", summary: "", questions: [{ title: "Which source?", options: ["Web", "Instagram"] }] };
  const plan: Call = { kind: "tool", name: "ExitPlanMode", summary: "# Plan: Add haiku.txt ## Context The user wants a haiku." };

  it("names a question Question, with the question it asks", () => {
    render(<Steps calls={[{ ...asked, result: { text: "User answered: Web" } }]} />);
    const row = screen.getByRole("button", { name: "Question Which source?" });
    expect(row).not.toHaveTextContent("AskUserQuestion");
  });

  it("names Codex's question tool Question too", () => {
    render(<Steps calls={[{ kind: "tool", name: "functions.request_user_input", summary: "", questions: [{ title: "Pick a fruit?", options: ["Apple"] }], result: { text: "Apple" } }]} />);
    expect(screen.getByRole("button", { name: "Question Pick a fruit?" })).toBeInTheDocument();
  });

  it("names a plan Plan, with its title and no heading marks", () => {
    render(<Steps calls={[{ ...plan, result: { text: "User approved" } }]} />);
    // The journal keeps the plan on one line; its title ends at the next heading.
    expect(screen.getByRole("button", { name: "Plan Add haiku.txt" })).not.toHaveTextContent("ExitPlanMode");
  });

  // Claude titles most plans "Plan: …"; the line already says Plan once.
  it("does not say Plan twice when the plan's title starts with it", () => {
    render(<Steps calls={[{ ...plan, summary: "# Plan: Add haiku.txt", result: { text: "User approved" } }, { ...plan, summary: "# Planning the parser", result: { text: "ok" } }]} />);
    expect(screen.getByRole("button", { name: "Plan Add haiku.txt" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Plan Planning the parser" })).toBeInTheDocument();
  });

  it("says a pending question waits on you", () => {
    render(<ToolStep id="c" part={asked} query="" active={false} focused={false} waiting />);
    expect(screen.getByRole("button", { name: "Question Which source? Waiting on you" })).toBeInTheDocument();
  });
});

// Find's current match is drawn solid; every other hit keeps the plain amber.
it("draws the current find match's hits apart from the others", () => {
  render(<>
    <ToolStep id="a" part={status} query="git" active={false} focused={false} />
    <ToolStep id="b" part={{ ...status, summary: "git diff" }} query="git" active={false} focused />
  </>);
  const [other, current] = [screen.getByRole("button", { name: /^Ran git status/ }), screen.getByRole("button", { name: /^Ran git diff/ })];
  expect(other.querySelector("mark")).not.toHaveAttribute("aria-current");
  expect(current.querySelector("mark")).toHaveAttribute("aria-current", "true");
});

it("opens a command onto itself in a shell's colours and its output in grey, a failure's exit code first", async () => {
  const failed: Call = { kind: "tool", name: "Bash", summary: "ls -la /nope", result: { text: "Exit code 1\nls: /nope: No such file or directory", isError: true } };
  const { container } = render(<Steps calls={[failed]} />);
  await userEvent.click(screen.getByRole("button", { name: /^Ran ls -la \/nope Failed/ }));
  const [command, output] = container.querySelectorAll("pre");
  expect(within(command as HTMLElement).getByText("ls").parentElement).toHaveClass("text-syntax-command");
  expect(within(command as HTMLElement).getByText("-la").parentElement).toHaveClass("text-syntax-flag");
  expect(output).toHaveClass("text-muted-foreground");
  expect(output).toHaveTextContent(/^Error: Exit code 1\s*ls: \/nope: No such file or directory$/);
  // Sober: the row says it failed in grey, and only its icon takes the destructive hue.
  expect(container.querySelector(".text-destructive")).toHaveClass("icon");
});

it("names a command's row by the line it ran, as written, never through Markdown", () => {
  render(<Steps calls={["echo `date`", "find . -name '*_test_*'", "# just a comment\nls"].map((summary) => ({ kind: "tool", name: "Bash", summary, result: { text: "" } }))} />);
  expect(screen.getByRole("button", { name: "Ran echo `date`" })).toHaveTextContent(/^echo `date`$/);
  expect(screen.getByRole("button", { name: "Ran find . -name '*_test_*'" })).toHaveTextContent(/^find \. -name '\*_test_\*'$/);
  expect(screen.getByRole("button", { name: /^Ran # just a comment/ })).toHaveTextContent(/^# just a comment$/);
});
