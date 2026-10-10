import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import FilePreview from "./file-preview";
import { HTML_VERSION_POLL_MS } from "./html-viewer";
import { MarkdownText } from "./markdown-text";
import { FilePreviewContext } from "@/lib/file-preview-context";
import { fetchArtifactMetadata, fetchPaneFile, PaneFileError } from "@/lib/api";

vi.mock("@/lib/api", async (original) => ({ ...(await original<typeof import("@/lib/api")>()), fetchPaneFile: vi.fn(), fetchArtifactMetadata: vi.fn() }));
vi.mock("./pdf-preview", () => ({ default: () => <div>PDF canvas</div> }));
const fetchFile = vi.mocked(fetchPaneFile);
const inspect = vi.mocked(fetchArtifactMetadata);
beforeEach(() => {
  vi.clearAllMocks();
  inspect.mockResolvedValue([]);
  URL.createObjectURL = vi.fn(() => "blob:document-preview");
  URL.revokeObjectURL = vi.fn();
});

it("opens local links and code paths through the provider, keeps remote URLs as links", () => {
  const open = vi.fn();
  render(<FilePreviewContext.Provider value={open}><MarkdownText text={'[Guide](docs/guide.md) and `report.pdf` and [web](https://example.com)'} /></FilePreviewContext.Provider>);
  fireEvent.click(screen.getByRole("button", { name: "Guide" }));
  expect(open).toHaveBeenCalledWith("docs/guide.md");
  fireEvent.click(screen.getByRole("button", { name: "report.pdf" }));
  expect(open).toHaveBeenCalledWith("report.pdf");
  expect(screen.getByRole("link", { name: "web" })).toHaveAttribute("href", "https://example.com");
});

it("keeps code-formatted link labels from becoming nested buttons", () => {
  const open = vi.fn();
  const { container } = render(<FilePreviewContext.Provider value={open}><MarkdownText text={'[`guide.md`](docs/guide.md) and [`remote.md`](https://example.com)'} /></FilePreviewContext.Provider>);
  expect(container.querySelector("button button, a button")).toBeNull();
  expect(screen.getAllByRole("button")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "guide.md" }));
  expect(open).toHaveBeenCalledExactlyOnceWith("docs/guide.md");
});

it("renders Markdown as safe text, resolves sibling documents, releases the URL and restores focus", async () => {
  fetchFile.mockResolvedValue(new Response("# Guide\n\n<script>alert(1)</script>\n\n[Next](next.md)", { headers: { "content-type": "text/markdown" } }));
  const opener = document.createElement("button"); document.body.append(opener); opener.focus();
  const focus = vi.spyOn(opener, "focus");
  const open = vi.fn();
  const { unmount } = render(<FilePreviewContext.Provider value={open}><FilePreview paneId="w1:p1" session="qa" path="docs/guide.md" onClose={() => {}} /></FilePreviewContext.Provider>);
  expect(await screen.findByText("Guide")).toBeInTheDocument();
  expect(screen.getByText("<script>alert(1)</script>")).toBeInTheDocument();
  expect(document.querySelector("script")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(open).toHaveBeenCalledWith("docs/next.md");
  const signal = fetchFile.mock.calls[0]![3];
  unmount();
  expect(signal.aborted).toBe(true);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:document-preview");
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  opener.remove();
});

// A link in prose names a file relative to whatever folder the text was about; the pane's folder
// answers 404 for it. The viewer asks the bridge where the name leads before reporting a failure.
it("follows a name the pane's folder lacks to the file the bridge finds, and says when there is none", async () => {
  const unavailable = new PaneFileError("Could not open file (404): File unavailable in this workspace.", 404, false);
  fetchFile.mockImplementation(async (_pane, path) => {
    if (path === "/repo/assets/notes.md") return new Response("# Found it", { headers: { "content-type": "text/markdown" } });
    throw unavailable;
  });
  inspect.mockImplementation(async (_pane, [path]) => [path === "assets/notes.md"
    ? { path, state: "preview" as const, resolved: "/repo/assets/notes.md" }
    : { path: path!, state: "missing" as const }]);
  const { unmount } = render(<FilePreview paneId="w1:p1" path="assets/notes.md" onClose={() => {}} />);
  expect(await screen.findByText("Found it")).toBeInTheDocument();
  expect(screen.getByText("/repo/assets/notes.md")).toBeInTheDocument();
  unmount();
  render(<FilePreview paneId="w1:p1" path="gone.md" onClose={() => {}} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("File not found");
  expect(inspect).toHaveBeenCalledWith("w1:p1", ["gone.md"], undefined);
});

it("surfaces unavailable files and retries without leaving the chat", async () => {
  fetchFile.mockRejectedValueOnce(new Error("File unavailable in this workspace."));
  fetchFile.mockResolvedValueOnce(new Response("hello", { headers: { "content-type": "text/plain" } }));
  const close = vi.fn();
  render(<FilePreview paneId="w1:p1" path="note.txt" onClose={close} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("File unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("hello")).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
});

it("explains a file outside the pane's folder with its path instead of a Retry that cannot work", async () => {
  const path = "/Users/fran/Obsidian/board/resultado-shopify.md";
  fetchFile.mockRejectedValue(new PaneFileError("Could not open file (404): This file is outside the project.", 404, true));
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  render(<FilePreview paneId="w1:p1" path={path} panes={[{ paneId: "w1:p1", cwd: "/repo", label: "coordinator" }]} onClose={() => {}} />);
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("outside this agent's folder");
  expect(alert).toHaveTextContent(path);
  expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Open from/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Copy path" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(path));
  expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
});

it("opens a refused file from the pane whose folder holds it", async () => {
  const path = "/repo/.worktrees/fix/report.md";
  fetchFile.mockImplementation(async (paneId) => {
    if (paneId === "w1:p1") throw new PaneFileError("Could not open file (404): This file is outside the project.", 404, true);
    return new Response("# Report", { headers: { "content-type": "text/markdown" } });
  });
  render(<FilePreview paneId="w1:p1" path={path} panes={[
    { paneId: "w1:p1", cwd: "/elsewhere", label: "coordinator" },
    { paneId: "w1:p2", cwd: "/repo/.worktrees/fix", label: "worker" },
  ]} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open from worker" }));
  expect(await screen.findByText("Report")).toBeInTheDocument();
  expect(fetchFile).toHaveBeenLastCalledWith("w1:p2", path, undefined, expect.any(AbortSignal));
  expect(screen.getByText(`${path} · from worker`)).toBeInTheDocument();
});

it("replaces a refused HTML frame with the reason once the frame has loaded", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    new Response("This file is outside the project.", { status: 404, headers: { "x-file-state": "outside-project" } }));
  try {
    render(<FilePreview paneId="w1:p1" path="/Users/fran/Obsidian/board/resultado-shopify.html" onClose={() => {}} />);
    fireEvent.load(screen.getByTitle("Rendered preview of resultado-shopify.html"));
    expect(await screen.findByRole("alert")).toHaveTextContent("outside this agent's folder");
    expect(screen.queryByTitle("Rendered preview of resultado-shopify.html")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Download file" })).not.toBeInTheDocument();
  } finally {
    fetchSpy.mockRestore();
  }
});

it("loads the PDF renderer only for PDF responses", async () => {
  fetchFile.mockResolvedValue(new Response("%PDF-test", { headers: { "content-type": "application/pdf" } }));
  render(<FilePreview paneId="w1:p1" path="report.pdf" onClose={() => {}} />);
  await waitFor(() => expect(screen.getByText("PDF canvas")).toBeInTheDocument());
  expect(screen.getByRole("link", { name: "Download file" })).toHaveAttribute("download", "report.pdf");
});

it("renders HTML only in an opaque-origin script sandbox, mounting the frame before any source fetch", async () => {
  const attack = '<script>top.location="https://attacker.invalid";fetch("/api/snapshot");</script><form action="/api/pane/x/reply"><button>Attack</button></form>';
  fetchFile.mockResolvedValue(new Response(attack, { headers: { "content-type": "text/plain" } }));
  render(<FilePreview paneId="w1:p1" path="attack.html" onClose={() => {}} />);

  const frame = screen.getByTitle("Rendered preview of attack.html");
  expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  expect(frame).not.toHaveAttribute("allow");
  for (const forbidden of ["allow-same-origin", "allow-forms", "allow-popups", "allow-top-navigation", "allow-downloads"]) {
    expect(frame.getAttribute("sandbox")).not.toContain(forbidden);
  }
  expect(frame).toHaveAttribute("src", "/api/pane/w1%3Ap1/html-preview?path=attack.html");
  expect(frame).not.toHaveAttribute("srcdoc");
  // One request opens the page: the iframe's own. The source waits for the Code view.
  expect(fetchFile).not.toHaveBeenCalled();
  expect(screen.getByRole("link", { name: "Download file" })).toHaveAttribute("href", "/api/pane/w1%3Ap1/file?path=attack.html");

  fireEvent.click(screen.getByRole("tab", { name: "Code" }));
  expect(await screen.findByText(attack)).toBeInTheDocument();
  expect(fetchFile).toHaveBeenCalledOnce();
  expect(screen.queryByTitle("Rendered preview of attack.html")).not.toBeInTheDocument();
});

it("switches the HTML frame between desktop and phone width", () => {
  render(<FilePreview paneId="w1:p1" path="site/index.html" onClose={() => {}} />);
  const stage = screen.getByTitle("Rendered preview of index.html").parentElement!;
  expect(stage).not.toHaveClass("html-viewer-stage--phone");
  fireEvent.click(screen.getByRole("button", { name: "Phone" }));
  expect(stage).toHaveClass("html-viewer-stage--phone");
  expect(screen.getByRole("button", { name: "Phone" })).toHaveAttribute("aria-pressed", "true");
});

it("reloads an open HTML frame when the file's ETag changes, and only then", async () => {
  vi.useFakeTimers();
  const answers = [
    new Response("<p>v1</p>", { headers: { etag: '"a"' } }),
    new Response(null, { status: 304, headers: { etag: '"a"' } }),
    new Response("<p>v2</p>", { headers: { etag: '"b"' } }),
  ];
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => answers.shift()!);
  try {
    render(<FilePreview paneId="w1:p1" path="site/index.html" onClose={() => {}} />);
    const first = screen.getByTitle("Rendered preview of index.html");
    await act(() => vi.advanceTimersByTimeAsync(HTML_VERSION_POLL_MS));
    expect(fetchSpy).not.toHaveBeenCalled(); // nothing asks before the page has loaded
    fireEvent.load(first);
    await act(() => vi.advanceTimersByTimeAsync(HTML_VERSION_POLL_MS));
    expect(screen.getByTitle("Rendered preview of index.html")).toBe(first);
    expect(fetchSpy.mock.calls[1]![1]!.headers).toEqual({ "if-none-match": '"a"' });
    await act(() => vi.advanceTimersByTimeAsync(HTML_VERSION_POLL_MS));
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(screen.getByTitle("Rendered preview of index.html")).not.toBe(first);
  } finally {
    fetchSpy.mockRestore();
    vi.useRealTimers();
  }
});

it("steps through a gallery of journal images with previous, next and the arrow keys", () => {
  render(<FilePreview paneId="w1:p1" items={[
    { kind: "journal", entry: "e1", index: 0, label: "Image 1" },
    { kind: "journal", entry: "e1", index: 1, label: "Image 2" },
  ]} start={1} onClose={() => {}} />);
  expect(screen.getByRole("img", { name: "Image 2" })).toHaveAttribute("src", "/api/pane/w1%3Ap1/journal-image?entry=e1&n=1");
  expect(screen.getByText("· 2 of 2")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByRole("img", { name: "Image 1" })).toHaveAttribute("src", "/api/pane/w1%3Ap1/journal-image?entry=e1&n=0");
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowLeft" });
  expect(screen.getByRole("img", { name: "Image 2" })).toBeInTheDocument();
  expect(fetchFile).not.toHaveBeenCalled();
});
