import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { isChatUploadPath } from "./chat-upload-preview.ts";
import { MAX_REQUEST_BODY_BYTES } from "./server.ts";
import { defaultStateDir } from "./config.ts";
import {
  filesToPrune, imageExtFromBytes, MAX_UPLOAD_BYTES, nenuDirs, saveUpload, sweepUploadDirs, sweepUploads, uploadDirs, type UploadFs,
} from "./uploads.ts";

// filesToPrune is the pure decision; sweepUploads is exercised with a fake fs so the stat/unlink
// orchestration (and its best-effort error handling) is covered without touching disk.

const HOUR = 60 * 60 * 1000;
const TTL = 48 * HOUR;

describe("imageExtFromBytes", () => {
  test("recognises PNG, JPEG, GIF, WebP by magic bytes", () => {
    expect(imageExtFromBytes(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe(
      "png",
    );
    expect(imageExtFromBytes(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0))).toBe("jpg");
    expect(imageExtFromBytes(Uint8Array.of(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe("gif");
    const webp = new Uint8Array(12);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    expect(imageExtFromBytes(webp)).toBe("webp");
  });

  test("rejects SVG, HTML, empty, and a RIFF that is not WebP", () => {
    expect(imageExtFromBytes(new TextEncoder().encode("<svg"))).toBeNull();
    expect(imageExtFromBytes(new TextEncoder().encode("<!doctype html>"))).toBeNull();
    expect(imageExtFromBytes(new Uint8Array())).toBeNull();
    const riff = new Uint8Array(12);
    riff.set([0x52, 0x49, 0x46, 0x46], 0);
    riff.set([0x57, 0x41, 0x56, 0x45], 8);
    expect(imageExtFromBytes(riff)).toBeNull();
  });
});

describe("filesToPrune", () => {
  const now = 1_000_000_000_000;

  test("prunes only entries strictly older than the TTL", () => {
    const entries = [
      { name: "fresh.png", mtimeMs: now - 1 * HOUR },
      { name: "old.png", mtimeMs: now - 49 * HOUR },
      { name: "ancient.jpg", mtimeMs: now - 100 * HOUR },
    ];
    expect(filesToPrune(entries, now, TTL)).toEqual(["old.png", "ancient.jpg"]);
  });

  test("an entry exactly at the TTL boundary is kept (not strictly older)", () => {
    expect(filesToPrune([{ name: "edge.png", mtimeMs: now - TTL }], now, TTL)).toEqual([]);
  });

  test("empty input yields nothing", () => {
    expect(filesToPrune([], now, TTL)).toEqual([]);
  });
});

describe("sweepUploads", () => {
  function fakeFs(
    files: Record<string, number>,
    opts: { failStat?: Set<string>; failUnlink?: Set<string> } = {},
  ): { fs: UploadFs; unlinked: string[] } {
    const unlinked: string[] = [];
    const fs: UploadFs = {
      readdir: () => Promise.resolve(Object.keys(files)),
      stat: (p) => {
        const name = p.split("/").pop()!;
        if (opts.failStat?.has(name)) return Promise.reject(new Error("stat gone"));
        return Promise.resolve({ mtimeMs: files[name]! });
      },
      unlink: (p) => {
        const name = p.split("/").pop()!;
        if (opts.failUnlink?.has(name)) return Promise.reject(new Error("unlink gone"));
        unlinked.push(name);
        return Promise.resolve();
      },
    };
    return { fs, unlinked };
  }

  const now = 1_000_000_000_000;

  test("removes expired files and returns their names", async () => {
    const { fs, unlinked } = fakeFs({
      "fresh.png": now - 1 * HOUR,
      "old.png": now - 72 * HOUR,
    });
    const removed = await sweepUploads("/uploads", TTL, now, fs);
    expect(removed).toEqual(["old.png"]);
    expect(unlinked).toEqual(["old.png"]);
  });

  test("a missing uploads dir is not an error (nothing uploaded yet)", async () => {
    const fs: UploadFs = {
      readdir: () => Promise.reject(new Error("ENOENT")),
      stat: () => Promise.reject(new Error("nope")),
      unlink: () => Promise.reject(new Error("nope")),
    };
    expect(await sweepUploads("/uploads", TTL, now, fs)).toEqual([]);
  });

  test("skips a file that vanishes between readdir and stat", async () => {
    const { fs, unlinked } = fakeFs(
      { "old.png": now - 72 * HOUR, "racy.png": now - 72 * HOUR },
      { failStat: new Set(["racy.png"]) },
    );
    const removed = await sweepUploads("/uploads", TTL, now, fs);
    expect(removed).toEqual(["old.png"]);
    expect(unlinked).toEqual(["old.png"]);
  });

  test("a failed unlink is skipped without aborting the sweep", async () => {
    const { fs, unlinked } = fakeFs(
      { "a.png": now - 72 * HOUR, "b.png": now - 72 * HOUR },
      { failUnlink: new Set(["a.png"]) },
    );
    const removed = await sweepUploads("/uploads", TTL, now, fs);
    expect(removed).toEqual(["b.png"]);
    expect(unlinked).toEqual(["b.png"]);
  });
});

describe("uploadDirs", () => {
  const home = "/home/op";

  test("with the default state dir, uploads go to a Nenu folder beside it and the old folder is still read", () => {
    expect(uploadDirs(defaultStateDir(home), home)).toEqual(["/home/op/.local/state/nenu/uploads", "/home/op/.local/state/collie/uploads"]);
  });

  test("a state dir the operator chose keeps its uploads inside it", () => {
    expect(uploadDirs("/srv/nenu-state", home)).toEqual(["/srv/nenu-state/uploads"]);
    expect(uploadDirs(`${defaultStateDir(home)}/`, home)[0]).toBe("/home/op/.local/state/nenu/uploads");
  });

  test("Nenu's own folders are its state and every uploads folder", () => {
    expect(nenuDirs(defaultStateDir(home), home)).toEqual([
      "/home/op/.local/state/collie", "/home/op/.local/state/nenu/uploads", "/home/op/.local/state/collie/uploads",
    ]);
  });
});

describe("sweepUploadDirs", () => {
  test("sweeps the new uploads folder and the old one", async () => {
    const now = 1_000_000_000_000;
    const home = "/home/op";
    const [current, legacy] = uploadDirs(defaultStateDir(home), home);
    const files: Record<string, Record<string, number>> = {
      [current!]: { "new-old.png": now - 72 * HOUR, "new-fresh.png": now - HOUR },
      [legacy!]: { "legacy-old.png": now - 72 * HOUR, "legacy-fresh.png": now - HOUR },
    };
    const unlinked: string[] = [];
    const fs: UploadFs = {
      readdir: (dir) => files[dir] ? Promise.resolve(Object.keys(files[dir]!)) : Promise.reject(new Error("ENOENT")),
      stat: (p) => Promise.resolve({ mtimeMs: files[dirname(p)]![basename(p)]! }),
      unlink: (p) => { unlinked.push(p); return Promise.resolve(); },
    };
    expect(await sweepUploadDirs(uploadDirs(defaultStateDir(home), home), TTL, now, fs)).toEqual(["new-old.png", "legacy-old.png"]);
    expect(unlinked).toEqual([join(current!, "new-old.png"), join(legacy!, "legacy-old.png")]);
  });
});

describe("saveUpload", () => {
  const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d);
  // `<state>/uploads`, as the bridge lays it out.
  let dir: string;
  beforeEach(async () => { dir = join(await mkdtemp(join(tmpdir(), "nenu-state-")), "uploads"); });
  afterEach(async () => { await rm(dirname(dir), { recursive: true, force: true }); });

  const save = async (name: string, body: BlobPart = "hello") => {
    const result = await saveUpload(dirname(dir), "w1:p2", new File([body], name));
    if (!result.ok) throw new Error(result.error);
    return result.path;
  };

  test("with the default state dir, the agent is handed a path in Nenu's uploads folder, not Collie's", async () => {
    const home = dirname(dir);
    const result = await saveUpload(defaultStateDir(home), "w1:p2", new File(["hello"], "notes.txt"), home);
    if (!result.ok) throw new Error(result.error);
    expect(dirname(result.path)).toBe(join(home, ".local", "state", "nenu", "uploads"));
    expect(result.path).not.toContain("collie");
    expect(await readFile(result.path, "utf8")).toBe("hello");
  });

  test("takes any kind of file and keeps its extension, so the agent can open it", async () => {
    for (const [name, ext] of [["spec.pdf", ".pdf"], ["bundle.zip", ".zip"], ["cart.ts", ".ts"], ["c.tar.gz", ".tar.gz"]] as const) {
      const path = await save(name, `body of ${name}`);
      expect(dirname(path)).toBe(dir);
      expect(path.endsWith(ext)).toBe(true);
      expect(await readFile(path, "utf8")).toBe(`body of ${name}`);
    }
  });

  test("an image is named by its bytes, in the shape the chat preview accepts", async () => {
    const path = await save("IMG_2041.HEIC", PNG);
    expect(basename(path)).toMatch(/^w1_p2-[a-z0-9]+-[a-f0-9]{8}\.png$/);
    expect(isChatUploadPath([dir], path)).toBe(true);
  });

  test("a file named like an image that is not one never keeps an image extension", async () => {
    for (const name of ["fake.png", "deadbeef.jpg", "x.webp"]) {
      const path = await save(name, "<!doctype html><script>alert(1)</script>");
      expect(path).not.toMatch(/\.(?:png|jpe?g|gif|webp)$/i);
      expect(isChatUploadPath([dir], path)).toBe(false);
      expect(basename(path)).toEndWith(".bin");
    }
  });

  test("odd client names become a generated, flat, portable name", async () => {
    const cases: Record<string, string> = {
      "my report (final).pdf": "-my_report_final.pdf",
      "../x.ts": "-x.ts",
      "CON": "-CON",
      "résumé ü.txt": "-resume_u.txt",
      "..": "-file",
      "": "-file",
      "a/b\\c.tar.gz": "-c.tar.gz",
      ".env": "-file.env",
      "...hidden..name...md": "-hidden.name.md",
      [`${"x".repeat(300)}.pdf`]: `-${"x".repeat(64)}.pdf`,
    };
    for (const [name, suffix] of Object.entries(cases)) {
      const path = await save(name);
      const saved = basename(path);
      expect(dirname(path)).toBe(dir);
      expect(saved).toMatch(/^w1_p2-[a-z0-9]+-[a-f0-9]{8}-/);
      expect(saved.endsWith(suffix)).toBe(true);
      expect(saved).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(saved).not.toContain("..");
      expect(saved.length).toBeLessThanOrEqual(120);
    }
  });

  test("refuses a file over 25 MB and writes nothing", async () => {
    expect(MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
    const result = await saveUpload(dirname(dir), "w1:p2", new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], "big.zip"));
    expect(result).toEqual({ ok: false, error: "File too large (max 25 MB)." });
    expect(await readdir(dir).catch(() => [])).toEqual([]);
    expect((await saveUpload(dirname(dir), "w1:p2", new File([new Uint8Array(MAX_UPLOAD_BYTES)], "edge.zip"))).ok).toBe(true);
  });
});

describe("the runtime's body cap", () => {
  test("lets a whole 25 MB upload and its multipart wrapping reach the route", () => {
    expect(MAX_REQUEST_BODY_BYTES).toBeGreaterThan(MAX_UPLOAD_BYTES + 64 * 1024);
  });
});
