import { act, renderHook, waitFor } from "@testing-library/react";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, useComposerAttachments } from "./use-composer-attachments";
import { localImageUrl } from "@/lib/local-sends";
import type { UploadResponse } from "@/lib/types";

const png = (name: string) => new File(["x"], name, { type: "image/png" });

function setup(upload: (file: File) => Promise<UploadResponse>, initialPaths: string[] = []) {
  const onPathsChange = vi.fn();
  const hook = renderHook(() => useComposerAttachments({ upload, previewUrl: (path) => `/preview${path}`, onPathsChange, initialPaths }));
  return { ...hook, onPathsChange };
}

describe("useComposerAttachments", () => {
  it("uploads each picked image and reports ready, uploading and failed chips separately", async () => {
    let releaseSecond!: () => void;
    const upload = vi.fn((file: File): Promise<UploadResponse> => {
      if (file.name === "b.png") return new Promise((resolve) => { releaseSecond = () => resolve({ ok: true, path: "/up/b.png" }); });
      if (file.name === "c.png") return Promise.resolve({ ok: false, error: "too large" });
      return Promise.resolve({ ok: true, path: "/up/a.png" });
    });
    const { result, onPathsChange } = setup(upload);
    act(() => { result.current.add([png("a.png"), png("b.png"), png("c.png")]); });
    await waitFor(() => expect(result.current.items.map((item) => item.status)).toEqual(["ready", "uploading", "error"]));
    expect(result.current.uploading).toBe(true);
    expect(result.current.failed).toBe(true);
    expect(result.current.items[2]!.error).toBe("too large");
    expect(onPathsChange).toHaveBeenLastCalledWith(["/up/a.png"]);
    await act(async () => releaseSecond());
    expect(result.current.paths).toEqual(["/up/a.png", "/up/b.png"]);
    // The sent-image cache now owns the local preview, so the transcript never shows a broken image.
    expect(localImageUrl("/up/a.png")).toBe(result.current.items[0]!.url);
  });

  it("retries a failed upload with the same file", async () => {
    const upload = vi.fn<(file: File) => Promise<UploadResponse>>()
      .mockResolvedValueOnce({ ok: false, error: "offline" })
      .mockResolvedValueOnce({ ok: true, path: "/up/a.png" });
    const { result } = setup(upload);
    act(() => { result.current.add([png("a.png")]); });
    await waitFor(() => expect(result.current.failed).toBe(true));
    act(() => result.current.retry(result.current.items[0]!.id));
    await waitFor(() => expect(result.current.paths).toEqual(["/up/a.png"]));
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("takes any kind of file, and refuses one over 25 MB or past the count limit", async () => {
    const upload = vi.fn(() => new Promise<UploadResponse>(() => {}));
    const create = vi.spyOn(URL, "createObjectURL");
    const { result } = setup(upload);
    const big = new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], "too-big.bin");
    let refused: ReturnType<typeof result.current.add> | undefined;
    act(() => { refused = result.current.add([new File(["%PDF"], "spec.pdf", { type: "application/pdf" }), big, ...Array.from({ length: MAX_ATTACHMENTS }, (_, i) => png(`${i}.png`))]); });
    expect(refused).toEqual({ images: MAX_ATTACHMENTS - 1, tooLarge: ["too-big.bin"], overLimit: 1 });
    expect(result.current.items).toHaveLength(MAX_ATTACHMENTS);
    expect(result.current.items[0]).toEqual(expect.objectContaining({ name: "spec.pdf", size: 4, image: false, url: undefined }));
    // Only an image gets a local preview; a PDF or an archive is never read into the page.
    expect(create).toHaveBeenCalledTimes(MAX_ATTACHMENTS - 1);
    create.mockRestore();
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(MAX_ATTACHMENTS));
  });

  it("restores a saved non-image upload by its name, without asking for a preview", () => {
    const { result } = setup(() => new Promise(() => {}), ["/st/uploads/w1_p1-mv8g-0a1b2c3d-spec.pdf"]);
    expect(result.current.items).toEqual([expect.objectContaining({ status: "ready", image: false, name: "spec.pdf" })]);
    expect(result.current.items[0]!.url).toBeUndefined();
  });

  it("revokes the preview of an image removed before it was uploaded", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const { result } = setup(() => new Promise(() => {}));
    act(() => { result.current.add([png("a.png")]); });
    const { id, url } = result.current.items[0]!;
    act(() => result.current.remove(id));
    expect(revoke).toHaveBeenCalledWith(url);
    expect(result.current.items).toEqual([]);
    revoke.mockRestore();
  });

  it("restores saved uploads as ready chips and resets them", () => {
    const { result, onPathsChange } = setup(() => new Promise(() => {}), ["/up/saved.png"]);
    expect(result.current.items).toEqual([expect.objectContaining({ status: "ready", path: "/up/saved.png", url: "/preview/up/saved.png" })]);
    act(() => result.current.reset());
    expect(result.current.items).toEqual([]);
    expect(onPathsChange).toHaveBeenLastCalledWith([]);
  });
});
