import { act, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import FilePreview from "./file-preview";
import { HTML_VERSION_POLL_MS } from "./html-viewer";
import { MarkdownText } from "./markdown-text";
import { FilePreviewContext } from "@/lib/file-preview-context";
import { fetchArtifactMetadata, fetchPaneFile, PaneFileError } from "@/lib/api";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { declarations } from "@/test/css-rules";

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
  expect(screen.getByText("/repo/assets")).toBeInTheDocument();
  unmount();
  render(<FilePreview paneId="w1:p1" path="gone.md" onClose={() => {}} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("File not found");
  expect(inspect).toHaveBeenCalledWith("w1:p1", ["gone.md"], undefined);
});

// A video plays from its own URL, so its failure is a bare media error: the viewer still asks the
// bridge why, and follows a name the pane's folder lacks to where the bridge finds it.
it("follows a video named outside the pane's folder to the file the bridge finds", async () => {
  fetchFile.mockRejectedValue(new PaneFileError("Could not open file (404): File unavailable in this workspace.", 404, false));
  inspect.mockResolvedValue([{ path: "out/film.mp4", state: "preview", resolved: "/repo/app/out/film.mp4" }]);
  render(<FilePreview paneId="w1:p1" path="out/film.mp4" onClose={() => {}} />);
  const video = () => document.querySelector("video")!;
  expect(video()).toHaveAttribute("src", "/api/pane/w1%3Ap1/file?path=out%2Ffilm.mp4");
  fireEvent.error(video());
  await waitFor(() => expect(video()).toHaveAttribute("src", "/api/pane/w1%3Ap1/file?path=%2Frepo%2Fapp%2Fout%2Ffilm.mp4"));
  expect(inspect).toHaveBeenCalledWith("w1:p1", ["out/film.mp4"], undefined);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("reports a video the browser cannot play after one successful bridge probe without retrying", async () => {
  fetchFile.mockResolvedValue(new Response("video bytes", { status: 206, headers: { "content-type": "video/mp4" } }));
  render(<FilePreview paneId="w1:p1" path="out/film.mp4" onClose={() => {}} />);

  fireEvent.error(document.querySelector("video")!);

  expect(await screen.findByRole("alert")).toHaveTextContent("Could not play this video. Download it to open in another player.");
  expect(fetchFile).toHaveBeenCalledExactlyOnceWith("w1:p1", "out/film.mp4", undefined, expect.any(AbortSignal));
  expect(inspect).not.toHaveBeenCalled();
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
  // The layer stays for its exit, then goes.
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});

it("explains a file outside the pane's folder with its path instead of a Retry that cannot work", async () => {
  const path = "/Users/demo/Obsidian/board/board-summary.md";
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
  // The file sits at the top of the worker's folder, so the line under its name only says whose it is.
  expect(screen.getByText("from worker")).toBeInTheDocument();
});

it("replaces a refused HTML frame with the reason once the frame has loaded", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    new Response("This file is outside the project.", { status: 404, headers: { "x-file-state": "outside-project" } }));
  try {
    render(<FilePreview paneId="w1:p1" path="/Users/demo/Obsidian/board/board-summary.html" onClose={() => {}} />);
    fireEvent.load(screen.getByTitle("Rendered preview of board-summary.html"));
    expect(await screen.findByRole("alert")).toHaveTextContent("outside this agent's folder");
    expect(screen.queryByTitle("Rendered preview of board-summary.html")).not.toBeInTheDocument();
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

// The gallery ends where it ends, for the buttons and the arrow keys as for a swipe.
it("steps through a gallery of journal images with previous, next and the arrow keys, and stops at its ends", () => {
  render(<FilePreview paneId="w1:p1" items={[
    { kind: "journal", entry: "e1", index: 0, label: "Image 1" },
    { kind: "journal", entry: "e1", index: 1, label: "Image 2" },
  ]} start={1} onClose={() => {}} />);
  expect(screen.getByRole("img", { name: "Image 2" })).toHaveAttribute("src", "/api/pane/w1%3Ap1/journal-image?entry=e1&n=1");
  expect(screen.getByText("2 of 2")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" });
  expect(screen.getByText("2 of 2")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  expect(screen.getByRole("img", { name: "Image 1" })).toHaveAttribute("src", "/api/pane/w1%3Ap1/journal-image?entry=e1&n=0");
  expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowLeft" });
  expect(screen.getByText("1 of 2")).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" });
  expect(screen.getByRole("img", { name: "Image 2" })).toBeInTheDocument();
  expect(fetchFile).not.toHaveBeenCalled();
});

// T07: the agent's own folder is where the operator thinks from. The heading is the file's name and
// the line under it the folder that holds it, so neither repeats the other.
it("names the file in the heading and its folder, from the agent's folder, under it", async () => {
  fetchFile.mockImplementation(async () => new Response("export {}", { headers: { "content-type": "text/plain" } }));
  const cwd = "/var/folders/zd/7_1tqb1n5s7fbmsk0dqnzsk40000gn/T/nenu-e2e-s76Uzr";
  const panes = [{ paneId: "w1:p1", cwd, label: "coordinator" }];
  const { unmount } = render(<FilePreview paneId="w1:p1" path={`${cwd}/web/src/hooks/use-app-viewport.ts`} panes={panes} onClose={() => {}} />);
  expect(screen.getByRole("heading", { name: "use-app-viewport.ts" })).toBeInTheDocument();
  expect(screen.getByText("web/src/hooks")).toBeInTheDocument();
  expect(screen.getAllByText(/use-app-viewport/)).toEqual([screen.getByRole("heading", { name: "use-app-viewport.ts" })]);
  expect(screen.queryByText(/\/var\/folders/)).not.toBeInTheDocument();
  await screen.findByText("export {}");
  unmount();
  // At the top of the folder there is no folder to name.
  render(<FilePreview paneId="w1:p1" path={`${cwd}/reporte-auditoria.md`} panes={panes} onClose={() => {}} />);
  expect(screen.getAllByText("reporte-auditoria.md")).toEqual([screen.getByRole("heading", { name: "reporte-auditoria.md" })]);
  await screen.findByText("export {}");
});

// Both lines are cut to the width they are drawn in, measured in their own font: the folder gives way
// from the front, and the name in the middle, keeping how it starts, how it ends and its extension.
it("cuts the folder from the front and the name in the middle to the measured width of the bar", async () => {
  fetchFile.mockImplementation(async () => new Response("export {}", { headers: { "content-type": "text/plain" } }));
  // 160px of bar and 8px a character: twenty characters to a line.
  const width = vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
    return this.classList.contains("file-preview-heading") ? 160 : 0;
  });
  const measure = vi.spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue({ font: "", measureText: (text: string) => ({ width: text.length * 8 }) } as unknown as CanvasRenderingContext2D);
  try {
    const panes = [{ paneId: "w1:p1", cwd: "/repo", label: "coordinator" }];
    const { unmount } = render(<FilePreview paneId="w1:p1" path="/repo/docs/rediseno/notas.md" panes={panes} onClose={() => {}} />);
    expect(screen.getByRole("heading", { name: "notas.md" })).toHaveTextContent(/^notas\.md$/);
    expect(screen.getByText("docs/rediseno")).toBeInTheDocument();
    await screen.findByText("export {}");
    unmount();
    const long = "informe-de-auditoria-de-la-interfaz-movil-completo.md";
    render(<FilePreview paneId="w1:p1" path={`/repo/docs/rediseno/2026/octubre/${long}`} panes={panes} onClose={() => {}} />);
    expect(screen.getByRole("heading", { name: long })).toHaveTextContent(/^informe-de-a…leto\.md$/);
    expect(screen.getByText("…/2026/octubre")).toBeInTheDocument();
    await screen.findByText("export {}");
  } finally {
    width.mockRestore();
    measure.mockRestore();
  }
});

// T28: on a phone the viewer is a screen of its own: Done leaves it, and what a desk header shows as
// buttons waits behind one menu.
it("closes on Done and keeps Reload and Copy path behind More actions", async () => {
  const path = "/repo/docs/guide.md";
  fetchFile.mockImplementation(async () => new Response("# Guide", { headers: { "content-type": "text/markdown" } }));
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const close = vi.fn();
  render(<FilePreview paneId="w1:p1" path={path} panes={[{ paneId: "w1:p1", cwd: "/repo", label: "coordinator" }]} onClose={close} />);
  expect(await screen.findByText("Guide")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Refresh preview" })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  await waitFor(() => expect(fetchFile).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("button", { name: "Reload" })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  fireEvent.click(screen.getByRole("button", { name: "Copy path" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(path));
  expect(await screen.findByRole("button", { name: "Copied path" })).toBeInTheDocument();
  // Escape closes the menu first, and only then the viewer.
  fireEvent.keyDown(screen.getByRole("button", { name: "Copied path" }), { key: "Escape" });
  expect(screen.queryByRole("button", { name: "Copied path" })).not.toBeInTheDocument();
  expect(close).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});

describe("image viewer", () => {
  const gallery = [
    { kind: "journal" as const, entry: "e1", index: 0, label: "Image 1" },
    { kind: "journal" as const, entry: "e1", index: 1, label: "Image 2" },
  ];
  const stage = () => document.querySelector<HTMLElement>("[data-image-stage]")!;
  const zoom = () => Number(/scale\(([\d.]+)\)/.exec(document.querySelector<HTMLElement>("[data-image-zoom]")!.style.transform)?.[1] ?? 1);
  const point = (id: number, x: number, y: number, type = "touch") => ({ pointerId: id, pointerType: type, clientX: x, clientY: y, isPrimary: id === 1, button: 0 });
  // The viewer reads a release's speed from the events' timeStamps. Synchronous dispatch gives them
  // whatever the machine's clock says, so a slow runner turned a short pull into a flick. Each step of
  // a drag is stamped `stepMs` after the last (a 60 Hz finger by default), and real waits between
  // gestures still count.
  let clock = 0;
  function fire(kind: "pointerDown" | "pointerMove" | "pointerUp", init: ReturnType<typeof point>) {
    const event = createEvent[kind](stage(), init);
    Object.defineProperty(event, "timeStamp", { value: clock });
    fireEvent(stage(), event);
  }
  function drag(points: [number, number][], type = "touch", stepMs = 16) {
    const [first, ...rest] = points;
    clock = Math.max(Date.now(), clock + 1);
    fire("pointerDown", point(1, ...first!, type));
    for (const [x, y] of rest) { clock += stepMs; fire("pointerMove", point(1, x, y, type)); }
    clock += stepMs;
    fire("pointerUp", point(1, ...points.at(-1)!, type));
  }
  const tap = (x: number, y: number, type = "touch") => drag([[x, y]], type);

  it("shows the picture alone on black, with Done and Download and nothing to reload", () => {
    render(<FilePreview paneId="w1:p1" items={gallery} onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Image 1" })).toBeInTheDocument();
    // The next picture waits beside this one for a swipe, out of the reading order.
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.getByRole("img", { name: "Image 1" })).toHaveAttribute("src", "/api/pane/w1%3Ap1/journal-image?entry=e1&n=0");
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download image" })).toHaveAttribute("href", "/api/pane/w1%3Ap1/journal-image?entry=e1&n=0");
    expect(screen.queryByRole("button", { name: /Refresh|Reload|More actions/ })).not.toBeInTheDocument();
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
  });

  it("opens an image file by its own URL and asks the bridge why when it will not load", async () => {
    fetchFile.mockRejectedValue(new PaneFileError("Could not open file (404): This file is outside the project.", 404, true));
    render(<FilePreview paneId="w1:p1" path="/elsewhere/shot.png" onClose={() => {}} />);
    const image = screen.getByRole("img", { name: "shot.png" });
    expect(image).toHaveAttribute("src", "/api/pane/w1%3Ap1/file?path=%2Felsewhere%2Fshot.png");
    expect(fetchFile).not.toHaveBeenCalled();
    fireEvent.error(image);
    expect(await screen.findByRole("alert")).toHaveTextContent("outside this agent's folder");
  });

  // A large picture over a slow link leaves the black empty: a spinner says it is on its way.
  it("says a picture is still on its way until it has loaded", () => {
    render(<FilePreview paneId="w1:p1" items={gallery} onClose={() => {}} />);
    expect(screen.getByRole("status", { name: "Loading image" })).toBeInTheDocument();
    fireEvent.load(screen.getByRole("img", { name: "Image 1" }));
    expect(screen.queryByRole("status", { name: "Loading image" })).not.toBeInTheDocument();
  });

  // A picture that fails while it waits beside the current one never fails again once it is the
  // current one: the same <img> with the same src fires no second error. The viewer remembers it.
  it("explains a picture that failed while it waited beside the current one, and retries it", async () => {
    fetchFile.mockRejectedValue(new PaneFileError("Could not open file (404): File unavailable in this workspace.", 404, false));
    inspect.mockImplementation(async (_pane, [path]) => [{ path: path!, state: "missing" as const }]);
    render(<FilePreview paneId="w1:p1" items={[{ kind: "file", path: "shots/a.png" }, { kind: "file", path: "shots/b.png" }]} onClose={() => {}} />);
    fireEvent.error(document.querySelector('img[src*="b.png"]')!);
    expect(fetchFile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("File not found");
    expect(fetchFile).toHaveBeenCalledWith("w1:p1", "shots/b.png", undefined, expect.any(AbortSignal));
    expect(screen.queryByRole("link", { name: "Download image" })).not.toBeInTheDocument();
    // Retry loads the picture again instead of answering from memory.
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("img", { name: "b.png" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("closes on a long pull down and settles back after a short one", async () => {
    const close = vi.fn();
    render(<FilePreview paneId="w1:p1" items={gallery} onClose={close} />);
    drag([[500, 300], [502, 320], [505, 340]], "touch", 50);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(close).not.toHaveBeenCalled();
    drag([[500, 300], [502, 400], [510, 550], [515, 700]]);
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it("turns to the next picture on a swipe sideways, and not past the last one", async () => {
    render(<FilePreview paneId="w1:p1" items={gallery} onClose={() => {}} />);
    drag([[900, 400], [700, 404], [400, 406], [150, 410]]);
    expect(await screen.findByText("2 of 2")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Image 2" })).toBeInTheDocument();
    drag([[900, 400], [700, 404], [400, 406], [150, 410]]);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
  });

  it("zooms where a double tap lands and back out on the next one, and pinches", async () => {
    render(<FilePreview paneId="w1:p1" items={gallery} onClose={() => {}} />);
    tap(600, 300); tap(600, 300);
    expect(zoom()).toBe(2.5);
    tap(600, 300); tap(600, 300);
    expect(zoom()).toBe(1);
    fireEvent.pointerDown(stage(), point(1, 480, 380));
    fireEvent.pointerDown(stage(), point(2, 540, 380));
    fireEvent.pointerMove(stage(), point(1, 400, 380));
    fireEvent.pointerMove(stage(), point(2, 620, 380));
    fireEvent.pointerUp(stage(), point(1, 400, 380));
    fireEvent.pointerUp(stage(), point(2, 620, 380));
    expect(zoom()).toBeGreaterThan(2);
  });

  it("hides and shows its bars on a single tap, after waiting out a double tap", async () => {
    render(<FilePreview paneId="w1:p1" items={gallery} onClose={() => {}} />);
    const viewer = document.querySelector("[data-chrome]")!;
    expect(viewer).toHaveAttribute("data-chrome", "shown");
    tap(500, 400);
    expect(viewer).toHaveAttribute("data-chrome", "shown");
    await waitFor(() => expect(viewer).toHaveAttribute("data-chrome", "hidden"));
    tap(500, 400);
    await waitFor(() => expect(viewer).toHaveAttribute("data-chrome", "shown"));
  });

  // CSS cuts a title at its end, which hid the extension: the picture's name is cut in the middle to
  // the bar's measured width, like a document's.
  it("cuts a long picture name in the middle, keeping its extension", () => {
    const width = vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
      return this.classList.contains("image-viewer-title") ? 160 : 0;
    });
    const measure = vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({ font: "", measureText: (text: string) => ({ width: text.length * 8 }) } as unknown as CanvasRenderingContext2D);
    try {
      const name = "screenshot-2026-10-12-at-14.03.22.png";
      render(<FilePreview paneId="w1:p1" path={`/repo/shots/${name}`} onClose={() => {}} />);
      expect(screen.getByRole("heading", { name })).toHaveTextContent(/^screenshot-…3\.22\.png$/);
    } finally {
      width.mockRestore();
      measure.mockRestore();
    }
  });

  // The stage holds the pointer capture, so every pointerup names the stage as its target: a click on
  // the picture read as one beside it and closed the viewer halfway through a double click.
  it("zooms on a double click on the picture on a desk, and stays open", () => {
    const close = vi.fn();
    render(<FilePreview paneId="w1:p1" items={gallery} onClose={close} />);
    const box = { left: 300, right: 700, top: 200, bottom: 500, x: 300, y: 200, width: 400, height: 300, toJSON: () => ({}) };
    vi.spyOn(screen.getByRole("img", { name: "Image 1" }), "getBoundingClientRect").mockReturnValue(box as DOMRect);
    tap(500, 300, "mouse"); tap(500, 300, "mouse");
    expect(zoom()).toBe(2.5);
    expect(close).not.toHaveBeenCalled();
  });

  // The build resolves every light-dark() token once, at :root, so a color-scheme on the viewer cannot
  // flip them: in the light theme its bars read #27272a on black. Its text takes a fixed colour.
  it("keeps the viewer's own text off the theme tokens, which follow the page and not the black", () => {
    const css = readFileSync(resolve(import.meta.dirname, "file-preview.css"), "utf8");
    expect(declarations(css, ".file-preview-panel--image").color).not.toMatch(/var\(--/);
    expect(declarations(css, ".image-viewer-error > *").color).toBe("var(--card-foreground)");
  });

  it("closes on a click beside the picture on a desk", async () => {
    const close = vi.fn();
    render(<FilePreview paneId="w1:p1" items={gallery} onClose={close} />);
    tap(20, 400, "mouse");
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });
});
