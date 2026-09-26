import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import FilePreview from "./file-preview";
import { MarkdownText } from "./markdown-text";
import { FilePreviewContext } from "@/lib/file-preview-context";
import { fetchPaneFile } from "@/lib/api";

vi.mock("@/lib/api", async (original) => ({ ...(await original<typeof import("@/lib/api")>()), fetchPaneFile: vi.fn() }));
vi.mock("./pdf-preview", () => ({ default: () => <div>PDF canvas</div> }));
const fetchFile = vi.mocked(fetchPaneFile);
beforeEach(() => {
  vi.clearAllMocks();
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

it("loads the PDF renderer only for PDF responses", async () => {
  fetchFile.mockResolvedValue(new Response("%PDF-test", { headers: { "content-type": "application/pdf" } }));
  render(<FilePreview paneId="w1:p1" path="report.pdf" onClose={() => {}} />);
  await waitFor(() => expect(screen.getByText("PDF canvas")).toBeInTheDocument());
  expect(screen.getByRole("link", { name: "Download file" })).toHaveAttribute("download", "report.pdf");
});

it("renders HTML only in an opaque-origin script sandbox and keeps a literal code view", async () => {
  const attack = '<script>top.location="https://attacker.invalid";fetch("/api/snapshot");</script><form action="/api/pane/x/reply"><button>Attack</button></form>';
  fetchFile.mockResolvedValue(new Response(attack, { headers: { "content-type": "text/plain" } }));
  render(<FilePreview paneId="w1:p1" path="attack.html" onClose={() => {}} />);

  const frame = await screen.findByTitle("Rendered preview of attack.html");
  expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  expect(frame).not.toHaveAttribute("allow");
  for (const forbidden of ["allow-same-origin", "allow-forms", "allow-popups", "allow-top-navigation", "allow-downloads"]) {
    expect(frame.getAttribute("sandbox")).not.toContain(forbidden);
  }
  expect(frame).toHaveAttribute("src", "/api/pane/w1%3Ap1/html-preview?path=attack.html");
  expect(frame).not.toHaveAttribute("srcdoc");

  fireEvent.click(screen.getByRole("tab", { name: "Código" }));
  expect(screen.getByText(attack)).toBeInTheDocument();
  expect(screen.queryByTitle("Rendered preview of attack.html")).not.toBeInTheDocument();
});
