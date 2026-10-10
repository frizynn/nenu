import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkLogTools } from "./work-log-tools";
import { FileMediaContext } from "@/lib/file-preview-context";
import type { TranscriptPart } from "@/lib/types";

const calls: Array<{ id: string; part: Extract<TranscriptPart, { kind: "tool" }> }> = [
  { id: "first", part: { kind: "tool", name: "Bash", summary: "git status", result: { text: "clean" } } },
  { id: "second", part: { kind: "tool", name: "Read", summary: "/file.ts", result: { text: "file contents", isError: true, truncated: true } } },
  { id: "third", part: { kind: "tool", name: "Bash", summary: "pwd" } },
];

it("shows one unboxed sentence with visible error/truncation counts and keyboard expansion", async () => {
  const { container } = render(<WorkLogTools calls={calls} />);
  const group = screen.getByRole("button", { name: /3 tool calls · Bash, Read/ });
  expect(group).toHaveAttribute("aria-expanded", "false");
  expect(group).toHaveTextContent("1 error");
  expect(group).toHaveTextContent("1 truncated");
  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(container.querySelector(".work-log-tools")).not.toHaveClass("border", "bg-muted");
  group.focus();
  await userEvent.keyboard("{Enter}");
  expect(group).toHaveAttribute("aria-expanded", "true");
  expect([...container.querySelectorAll("[data-tool]")].map((node) => node.getAttribute("data-tool"))).toEqual(["first", "second", "third"]);
  expect(container.querySelector("[data-turn]")).toBeNull();
  expect(screen.queryByText("file contents")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /Read \/file.ts/ }));
  expect(screen.getByText("file contents")).toBeInTheDocument();
  expect(screen.getByText(/output truncated/)).toBeInTheDocument();
});

it.each(["Read", "/file.ts", "file contents"])("auto-expands only matching rows for query %s", (query) => {
  render(<WorkLogTools calls={calls} query={query} />);
  expect(screen.getByRole("button", { name: /3 tool calls/ })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: /Read \/file.ts/ })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: /Bash git status/ })).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByText("file contents")).toBeInTheDocument();
});

it("treats historical missing output as unknown and only active missing output as running", async () => {
  const { rerender } = render(<WorkLogTools calls={[calls[2]!]} />);
  await userEvent.click(screen.getByRole("button"));
  expect(screen.getByRole("button", { name: /Bash pwd No output recorded/ })).toBeEnabled();
  expect(screen.queryByText("Running…")).not.toBeInTheDocument();
  rerender(<WorkLogTools calls={[calls[2]!]} active />);
  expect(screen.getByRole("button", { name: /Bash pwd Running…/ })).toBeEnabled();
  expect(screen.queryByText("No output recorded")).not.toBeInTheDocument();
});

it("reveals literal command/output without Markdown or HTML execution and wraps long content", () => {
  const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const { container } = render(<WorkLogTools calls={[{ id: "xss", part: { kind: "tool", name: "Bash", summary: "echo **literal**", result: { text: `## literal heading\n${hostile}` } } }]} query="literal" />);
  expect(container.querySelector("img,script,strong,h2")).toBeNull();
  expect(container.textContent).toContain(hostile);
  const details = container.querySelectorAll("pre");
  expect(details).toHaveLength(2);
  for (const detail of details) expect(detail).toHaveClass("whitespace-pre-wrap", "[overflow-wrap:anywhere]");
});

it("renders nothing for an empty tool group", () => {
  const { container } = render(<WorkLogTools calls={[]} />);
  expect(container).toBeEmptyDOMElement();
});

it("reveals a focused entry without a query and marks only its assigned first tool part", () => {
  const { container } = render(<WorkLogTools calls={[
    { ...calls[0]!, entryId: "entry-a" },
    { ...calls[1]!, entryId: "entry-b" },
    calls[2]!,
  ]} focusedEntryId="entry-b" />);
  expect(screen.getByRole("button", { name: /3 tool calls/ })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: /Read \/file.ts/ })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: /Bash git status/ })).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByText("file contents")).toBeInTheDocument();
  expect(container.querySelectorAll('[data-turn="entry-b"]')).toHaveLength(1);
  expect(container.querySelector('[data-tool="third"]')).not.toHaveAttribute("data-turn");
  for (const button of screen.getAllByRole("button")) expect(button).toHaveAttribute("data-work-toggle");
});

it("shows the image a read tool opened as a thumbnail, folded or open", async () => {
  render(<FileMediaContext.Provider value={(path) => `/api/file?path=${path}`}>
    <WorkLogTools calls={[{ id: "read", owner: "e1", part: { kind: "tool", name: "Read", summary: "shots/home.png", result: { text: "" } } }]} />
  </FileMediaContext.Provider>);
  expect(screen.getByRole("img", { name: "home.png" })).toHaveAttribute("src", "/api/file?path=shots/home.png");
  await userEvent.click(screen.getByRole("button", { name: /^1 tool call/ }));
  expect(screen.getByRole("img", { name: "home.png" })).toBeInTheDocument();
});
