import { downscaleImage, scaledSize } from "./image-downscale";

describe("scaledSize", () => {
  it("keeps an image at or under the long edge, scales a larger one by its long edge", () => {
    expect(scaledSize(2048, 1000)).toBeNull();
    expect(scaledSize(4032, 3024)).toEqual({ width: 2048, height: 1536 });
    expect(scaledSize(1000, 6000)).toEqual({ width: 341, height: 2048 });
  });
});

describe("downscaleImage", () => {
  const photo = new File([new Uint8Array(5_000_000)], "IMG_0001.jpeg", { type: "image/jpeg" });
  let drawn: { width: number; height: number } | undefined;

  beforeEach(() => {
    drawn = undefined;
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 4032, height: 3024, close: vi.fn() })));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
      return { drawImage: () => { drawn = { width: this.width, height: this.height }; } } as unknown as CanvasRenderingContext2D;
    } as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((done, type) => done(new Blob([new Uint8Array(400_000)], { type })));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("redraws a large photo at 2048 px as a smaller JPEG", async () => {
    const out = await downscaleImage(photo);
    expect(drawn).toEqual({ width: 2048, height: 1536 });
    expect(out).not.toBe(photo);
    expect(out.type).toBe("image/jpeg");
    expect(out.name).toBe("IMG_0001.jpg");
    expect(out.size).toBe(400_000);
  });

  it("leaves GIFs, small images and a larger re-encode alone", async () => {
    const gif = new File([new Uint8Array(10)], "a.gif", { type: "image/gif" });
    expect(await downscaleImage(gif)).toBe(gif);
    vi.mocked(createImageBitmap).mockResolvedValueOnce({ width: 800, height: 600, close: vi.fn() } as unknown as ImageBitmap);
    expect(await downscaleImage(photo)).toBe(photo);
    const tiny = new File([new Uint8Array(1000)], "big.png", { type: "image/png" });
    expect(await downscaleImage(tiny)).toBe(tiny);
  });

  it("uploads the original when the browser cannot decode it", async () => {
    vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error("decode"));
    expect(await downscaleImage(photo)).toBe(photo);
  });
});
