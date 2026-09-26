import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { FilePreviewContext } from "@/lib/file-preview-context";
import type { PaneHistoryResponse, TranscriptEntry } from "@/lib/types";
import { ChatFilesBrowser } from "./chat-files-browser";

const fetchHistory = vi.fn();
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  fetchHistory: (...args: unknown[]) => fetchHistory(...args),
  fetchProjectFiles: async () => ({ path: ".", files: [], truncated: false }),
  fetchArtifactMetadata: async () => [],
}));

function entry(uuid: string, text: string): TranscriptEntry {
  return { uuid, ts: "", role: "assistant", parts: [{ kind: "text", text }] };
}

function available(entries: TranscriptEntry[], hasMore = false, total = entries.length): PaneHistoryResponse {
  return { paneId: "w1:p1", available: true, entries, hasMore, total, fileTruncated: false };
}

beforeEach(() => fetchHistory.mockReset());

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
    expect(fetchHistory).toHaveBeenCalledWith("w1:p1", { limit: 120, before: "new" }, undefined, expect.any(AbortSignal));
    await userEvent.click(screen.getByRole("button", { name: /Files · 1/ }));
    expect(screen.getByText("guide.md")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Media" }));
    expect(screen.getByText("demo.png")).toBeInTheDocument();
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
