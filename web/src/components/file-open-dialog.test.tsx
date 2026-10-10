import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { vi } from "vitest";
import FilePreview from "./file-preview";
import { GRANT_REFRESH_MS } from "./file-open-dialog";
import { fetchPaneFile, grantFileOpen, PaneFileError } from "@/lib/api";

vi.mock("@/lib/api", async (original) => ({ ...(await original<typeof import("@/lib/api")>()), fetchPaneFile: vi.fn(), grantFileOpen: vi.fn() }));
const fetchFile = vi.mocked(fetchPaneFile);
const grant = vi.mocked(grantFileOpen);
const PATH = "/Users/fran/Obsidian/board/resultado-shopify.md";
const GRANT = { url: "/api/files/open?t=abc", name: "resultado-shopify.md", size: 6_500_000, type: "text/plain" };

beforeEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

const confirmDialog = () => screen.getByRole("dialog", { name: "Open this file outside Nenu's preview?" });

it("asks before opening a refused file and hands the tap a ready link", async () => {
  fetchFile.mockRejectedValue(new PaneFileError("Could not open file (404): This file is outside the project.", 404, true));
  grant.mockResolvedValue(GRANT);
  const close = vi.fn();
  render(<FilePreview paneId="w1:p1" session="qa" path={PATH} onClose={close} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open" }));
  expect(grant).toHaveBeenCalledExactlyOnceWith("w1:p1", PATH, "qa");
  const dialog = confirmDialog();
  expect(dialog).toHaveTextContent(PATH);
  expect(dialog).toHaveTextContent("sandboxed");
  const link = await within(dialog).findByRole("link", { name: "Open" });
  expect(dialog).toHaveTextContent("6.2 MB");
  expect(link).toHaveAttribute("href", GRANT.url);
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  // Escape closes the question, not the preview behind it.
  fireEvent.keyDown(link, { key: "Escape" });
  expect(close).not.toHaveBeenCalled();
});

it("cancelling opens nothing, and every new question asks for a fresh link", async () => {
  fetchFile.mockRejectedValue(new PaneFileError("Could not open file (404): This file is outside the project.", 404, true));
  grant.mockResolvedValue(GRANT);
  render(<FilePreview paneId="w1:p1" path={PATH} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open" }));
  await within(confirmDialog()).findByRole("link", { name: "Open" });
  fireEvent.click(within(confirmDialog()).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("link", { name: "Open" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(grant).toHaveBeenCalledTimes(2);
});

it("shows the bridge's refusal and lets the operator ask again", async () => {
  fetchFile.mockRejectedValue(new PaneFileError("Could not open file (404): This file is outside the project.", 404, true));
  grant.mockResolvedValueOnce({ error: "This file is private and cannot be opened from Nenu." }).mockResolvedValueOnce(GRANT);
  render(<FilePreview paneId="w1:p1" path={PATH} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open" }));
  expect(await within(confirmDialog()).findByRole("alert")).toHaveTextContent("private");
  expect(within(confirmDialog()).queryByRole("link")).not.toBeInTheDocument();
  fireEvent.click(within(confirmDialog()).getByRole("button", { name: "Try again" }));
  expect(await within(confirmDialog()).findByRole("link", { name: "Open" })).toHaveAttribute("href", GRANT.url);
});

it("offers Open for a file too large to preview, but not for a missing one", async () => {
  fetchFile.mockRejectedValueOnce(new PaneFileError("Could not open file (413): File is too large to preview (maximum 2 MB).", 413, false));
  const { unmount } = render(<FilePreview paneId="w1:p1" path="big.log" onClose={() => {}} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("too large");
  expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument();
  unmount();
  fetchFile.mockRejectedValueOnce(new PaneFileError("Could not open file (404): File unavailable in this workspace.", 404, false));
  render(<FilePreview paneId="w1:p1" path="gone.log" onClose={() => {}} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("unavailable");
  expect(screen.queryByRole("button", { name: "Open" })).not.toBeInTheDocument();
});

it("replaces a link before the bridge lets it expire", async () => {
  fetchFile.mockRejectedValue(new PaneFileError("Could not open file (404): This file is outside the project.", 404, true));
  grant.mockResolvedValueOnce(GRANT).mockResolvedValueOnce({ ...GRANT, url: "/api/files/open?t=fresh" });
  render(<FilePreview paneId="w1:p1" path={PATH} onClose={() => {}} />);
  const open = await screen.findByRole("button", { name: "Open" });
  vi.useFakeTimers();
  fireEvent.click(open);
  await act(async () => {});
  expect(within(confirmDialog()).getByRole("link", { name: "Open" })).toHaveAttribute("href", GRANT.url);
  await act(async () => { vi.advanceTimersByTime(GRANT_REFRESH_MS); });
  await act(async () => {});
  expect(within(confirmDialog()).getByRole("link", { name: "Open" })).toHaveAttribute("href", "/api/files/open?t=fresh");
});
