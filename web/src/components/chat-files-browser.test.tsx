import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { FilePreviewContext } from "@/lib/file-preview-context";
import type { PaneHistoryResponse, TranscriptEntry } from "@/lib/types";
import { ChatFilesBrowser } from "./chat-files-browser";

const fetchHistory = vi.fn();
const fetchArtifactMetadata = vi.fn();
const grantFileOpen = vi.fn();
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  fetchHistory: (...args: unknown[]) => fetchHistory(...args),
  fetchProjectFiles: async () => ({ path: ".", files: [], truncated: false }),
  fetchArtifactMetadata: (...args: unknown[]) => fetchArtifactMetadata(...args),
  grantFileOpen: (...args: unknown[]) => grantFileOpen(...args),
}));

function entry(uuid: string, text: string): TranscriptEntry {
  return { uuid, ts: "", role: "assistant", parts: [{ kind: "text", text }] };
}

function available(entries: TranscriptEntry[], hasMore = false, total = entries.length): PaneHistoryResponse {
  return { paneId: "w1:p1", available: true, entries, hasMore, total, fileTruncated: false };
}

beforeEach(() => {
  fetchHistory.mockReset();
  grantFileOpen.mockReset().mockReturnValue(new Promise(() => {}));
  fetchArtifactMetadata.mockReset().mockResolvedValue([]);
});

describe("ChatFilesBrowser", () => {

  it("pages to the beginning before claiming the conversation is scanned and deduplicates references", async () => {
    let resolveOlder!: (value: PaneHistoryResponse) => void;
    fetchHistory.mockReturnValueOnce(new Promise<PaneHistoryResponse>((resolve) => { resolveOlder = resolve; }));
    render(<ChatFilesBrowser paneId="w1:p1" history={available([entry("new", "docs/guide.md")], true, 2)} />);
    await userEvent.click(screen.getByRole("button", { name: "Artifacts and files" }));
    await userEvent.click(screen.getByRole("button", { name: "Artifacts" }));
    expect(screen.getByRole("status")).toHaveTextContent("Scanning the full conversation");
    resolveOlder(available([entry("old", "docs/guide.md and shots/demo.png")], false, 2));
    await waitFor(() => expect(screen.getByRole("button", { name: /Files · 1/ })).toBeInTheDocument());
    expect(fetchHistory).toHaveBeenCalledWith("w1:p1", { limit: 1_000, before: "new" }, undefined, expect.any(AbortSignal));
    await userEvent.click(screen.getByRole("button", { name: /Files · 1/ }));
    expect(screen.getByText("guide.md")).toBeInTheDocument();
  });

  it("marks each file the conversation names with the icon of its kind", async () => {
    render(<ChatFilesBrowser paneId="w1:p1" history={available([entry("one", "docs/report.md, src/app.tsx and out/run.log")])} />);
    await userEvent.click(screen.getByRole("button", { name: "Artifacts and files" }));
    await userEvent.click(await screen.findByRole("button", { name: /^Files/ }));
    const glyph = (name: string) => screen.getByRole("button", { name: `Open ${name}` }).querySelector("svg")?.getAttribute("class");
    expect(glyph("report.md")).toContain("icon-file-type");
    expect(glyph("app.tsx")).toContain("icon-typescript");
    expect(glyph("run.log")).toContain("icon-file-text");
  });

  // Leaving for Project aborts the scan mid-page. Coming back must resume from the oldest page it
  // already holds: resuming from the newest one re-reads known turns and blames the conversation.
  it("resumes an interrupted scan where it stopped, without saying the conversation changed", async () => {
    let resolveOldest!: (value: PaneHistoryResponse) => void;
    fetchHistory
      .mockResolvedValueOnce(available([entry("middle", "docs/middle.md")], true, 3))
      // As fetch does, an aborted read rejects.
      .mockImplementationOnce((_pane: string, _page: unknown, _session: unknown, signal: AbortSignal) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))))
      .mockReturnValueOnce(new Promise<PaneHistoryResponse>((resolve) => { resolveOldest = resolve; }));
    render(<ChatFilesBrowser paneId="w1:p1" history={available([entry("new", "docs/new.md")], true, 3)} />);
    await userEvent.click(screen.getByRole("button", { name: "Artifacts and files" }));
    await userEvent.click(screen.getByRole("button", { name: /^Files/ }));
    await waitFor(() => expect(fetchHistory).toHaveBeenCalledTimes(2));
    await userEvent.click(screen.getByRole("button", { name: "Project" }));
    await userEvent.click(screen.getByRole("button", { name: /^Files/ }));
    await waitFor(() => expect(fetchHistory).toHaveBeenCalledTimes(3));
    expect(fetchHistory).toHaveBeenLastCalledWith("w1:p1", { limit: 1_000, before: "middle" }, undefined, expect.any(AbortSignal));
    resolveOldest(available([entry("old", "docs/old.md")], false, 3));
    await waitFor(() => expect(screen.getByRole("button", { name: /Files · 3/ })).toBeInTheDocument());
    expect(screen.queryByText(/conversation changed/i)).not.toBeInTheDocument();
  });

  it("opens a selected reference through FilePreviewProvider's context", async () => {
    const open = vi.fn();
    render(<FilePreviewContext.Provider value={open}><ChatFilesBrowser paneId="w1:p1" session="qa" history={available([entry("one", "[Report](reports/audit.pdf)")])} /></FilePreviewContext.Provider>);
    await userEvent.click(screen.getByRole("button", { name: "Artifacts and files" }));
    await userEvent.click(screen.getByRole("button", { name: "Artifacts" }));
    await userEvent.click(await screen.findByRole("button", { name: /Files · 1/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Open audit.pdf" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("reports/audit.pdf"));
    expect(screen.queryByRole("dialog", { name: "Artifacts and files" })).not.toBeInTheDocument();
  });

  it("discloses a tail-limited journal instead of calling it complete", async () => {
    const history = available([], false, 0);
    if (!history.available) throw new Error("fixture must be available");
    render(<ChatFilesBrowser paneId="w1:p1" history={{ ...history, fileTruncated: true }} />);
    await userEvent.click(screen.getByRole("button", { name: "Artifacts and files" }));
    await userEvent.click(screen.getByRole("button", { name: "Artifacts" }));
    expect(await screen.findByText(/journal retains only the newest part/i)).toBeInTheDocument();
  });

  it("shows an empty state and retries failed older-page reads", async () => {
    fetchHistory.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(available([], false, 1));
    render(<ChatFilesBrowser paneId="w1:p1" history={available([entry("new", "No references")], true, 1)} />);
    await userEvent.click(screen.getByRole("button", { name: "Artifacts and files" }));
    await userEvent.click(screen.getByRole("button", { name: "Artifacts" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Some older messages");
    await userEvent.click(screen.getByRole("button", { name: /Retry/ }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByText("No artifacts in this conversation")).toBeInTheDocument();
  });

  it("dismisses stale paths immediately when the pane scope changes", async () => {
    const { rerender } = render(<ChatFilesBrowser paneId="w1:p1" history={available([entry("one", "secret/old.pdf")])} />);
    await userEvent.click(screen.getByRole("button", { name: "Artifacts and files" }));
    await userEvent.click(screen.getByRole("button", { name: "Artifacts" }));
    await userEvent.click(await screen.findByRole("button", { name: /Files · 1/ }));
    expect(await screen.findByText("old.pdf")).toBeInTheDocument();
    rerender(<ChatFilesBrowser paneId="w1:p2" history={{ ...available([entry("two", "new.pdf")]), paneId: "w1:p2" }} />);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Artifacts and files" })).not.toBeInTheDocument());
    expect(screen.queryByText("old.pdf")).not.toBeInTheDocument();
  });
});

it("opens the project tree without scanning older conversation pages", async () => {
  render(<ChatFilesBrowser paneId="w1:p1" history={available([entry("one", "old.pdf")], true, 1000)} />);
  await userEvent.click(screen.getByRole("button", { name: "Artifacts and files" }));
  expect(screen.getByRole("button", { name: "Project" })).toHaveAttribute("aria-pressed", "true");
  await screen.findByText("Empty folder");
  expect(fetchHistory).not.toHaveBeenCalled();
});

// One segmented control in the app: the chosen list is pressed and neutral, never an accent. jsdom
// paints nothing, so the bench measures the neutral tile (redesign-shots/labels-type-reach).
it("picks a list with a neutral segmented control", async () => {
  render(<ChatFilesBrowser paneId="w1:p1" history={available([])} />);
  await userEvent.click(screen.getByRole("button", { name: "Artifacts and files" }));
  const group = screen.getByRole("group", { name: "File type" });
  expect(within(group).getByRole("button", { name: "Project" })).toHaveAttribute("aria-pressed", "true");
  expect(within(group).getByRole("button", { name: "Artifacts" })).toHaveAttribute("aria-pressed", "false");
  for (const button of within(group).getAllByRole("button")) expect(button.className).not.toMatch(/\b(?:bg|border|text)-(?:primary|ring|accent)\b/);
});

// Four names share a phone's width. At the docks' subhead step "Artifacts" ran over "Project" on a
// 320px phone and a three-digit Files count did at 375 (bench, r2/seg.ts). The footnote step is the
// size of an iOS segmented control; past it (a four-digit count, larger browser text) a name ends in
// an ellipsis inside its own segment instead of running over the next one.
it("lists artifacts, the project and files, with no Media tab", async () => {
  render(<ChatFilesBrowser paneId="w1:p1" history={available([])} />);
  await userEvent.click(screen.getByRole("button", { name: "Artifacts and files" }));
  const names = within(screen.getByRole("group", { name: "File type" })).getAllByRole("button").map(button => button.textContent);
  expect(names).toEqual(["Artifacts", "Project", "Files · 0"]);
});

describe("Artifacts", () => {
  const conversation = available([
    entry("one", "![After](shots/after.png) and [Notes](docs/notes.pdf). I also read /srv/vault/one.png and /srv/vault/two.png."),
  ]);
  const published = [{ id: "a1", url: "https://claude.ai/artifact/a1", title: "Review notes" }];
  beforeEach(() => {
    fetchArtifactMetadata.mockImplementation(async (_pane: string, paths: string[]) => paths.map(path =>
      path.startsWith("/srv/") ? { path, state: "outside" } : { path, state: "preview" }));
  });

  async function openArtifacts() {
    render(<ChatFilesBrowser paneId="w1:p1" history={conversation} published={published} />);
    await userEvent.click(screen.getByRole("button", { name: "Artifacts and files" }));
    await userEvent.click(screen.getByRole("button", { name: "Artifacts" }));
  }

  it("shows what was published and delivered, with a thumbnail only for an image Nenu can serve", async () => {
    await openArtifacts();
    expect(await screen.findByRole("link", { name: /Review notes/ })).toHaveAttribute("href", "https://claude.ai/artifact/a1");
    expect(screen.getByRole("button", { name: "Open notes.pdf" })).toBeInTheDocument();
    const thumbnail = await screen.findByRole("button", { name: "Open after.png" });
    expect(within(thumbnail).getByRole("presentation")).toHaveAttribute("src", expect.stringContaining("shots%2Fafter.png"));
    const images = screen.getAllByRole("presentation").map(image => image.getAttribute("src"));
    expect(images.join(" ")).not.toContain("vault");
  });

  it("gathers images beyond the pane's folder in one row that opens only after a confirmation", async () => {
    await openArtifacts();
    const row = await screen.findByRole("button", { name: /2 images named outside the pane's folder/ });
    expect(row).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(row);
    await userEvent.click(screen.getByRole("button", { name: "Open one.png" }));
    expect(await screen.findByRole("dialog", { name: "Open this file outside Nenu's preview?" })).toBeInTheDocument();
    expect(grantFileOpen).toHaveBeenCalledWith("w1:p1", "/srv/vault/one.png", undefined);
  });
});

it("fits the three list names to a narrow phone, ending a name that cannot fit inside its segment", async () => {
  render(<ChatFilesBrowser paneId="w1:p1" history={available([])} />);
  await userEvent.click(screen.getByRole("button", { name: "Artifacts and files" }));
  for (const button of within(screen.getByRole("group", { name: "File type" })).getAllByRole("button")) {
    expect(button).toHaveClass("text-footnote");
    expect(button).not.toHaveClass("text-subhead");
    expect(button.firstElementChild).toHaveClass("truncate");
  }
});

it("sorts by latest mention and filters file names and extensions", async () => {
  render(<ChatFilesBrowser paneId="w1:p1" history={available([
    entry("old", "a.pdf"), entry("middle", "b.md"), entry("new", "a.pdf and z.csv"),
  ])} />);
  await userEvent.click(screen.getByRole("button", { name: "Artifacts and files" }));
  await userEvent.click(screen.getByRole("button", { name: /Files/ }));
  const names = () => screen.getAllByRole("button", { name: /^Open / }).map(button => button.getAttribute("aria-label"));
  await waitFor(() => expect(names()).toEqual(["Open a.pdf", "Open z.csv", "Open b.md"]));
  await userEvent.selectOptions(screen.getByLabelText("Sort files"), "extension");
  expect(names()).toEqual(["Open z.csv", "Open b.md", "Open a.pdf"]);
  await userEvent.selectOptions(screen.getByLabelText("File extension"), "md");
  expect(names()).toEqual(["Open b.md"]);
  await userEvent.type(screen.getByLabelText("Search files"), "missing");
  expect(screen.getByText("No matching files")).toBeInTheDocument();
});

describe("first focus on a desk", () => {
  afterEach(() => vi.unstubAllGlobals());
  function pointer(kind: "fine" | "coarse") {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === `(pointer: ${kind})`, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }));
  }

  it("puts the cursor in the search when a list with one is picked", async () => {
    pointer("fine");
    render(<ChatFilesBrowser paneId="w1:p1" history={available([entry("one", "a.pdf")])} />);
    await userEvent.click(screen.getByRole("button", { name: "Artifacts and files" }));
    await userEvent.click(screen.getByRole("button", { name: /Files/ }));
    expect(screen.getByLabelText("Search files")).toHaveFocus();
  });

  it("leaves the search for a tap on a touch screen", async () => {
    pointer("coarse");
    render(<ChatFilesBrowser paneId="w1:p1" history={available([entry("one", "a.pdf")])} />);
    await userEvent.click(screen.getByRole("button", { name: "Artifacts and files" }));
    await userEvent.click(screen.getByRole("button", { name: /Files/ }));
    expect(screen.getByLabelText("Search files")).not.toHaveFocus();
  });
});
