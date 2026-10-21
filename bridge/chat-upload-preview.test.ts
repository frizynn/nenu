import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { chatUploadPreviewResponse, isChatUploadPath } from "./chat-upload-preview.ts";
import { defaultStateDir } from "./config.ts";
import { uploadDirs } from "./uploads.ts";
import type { TranscriptEntry } from "./journal/types.ts";

describe("chat upload previews", () => {
  let temp: string;
  let state: string;
  let path: string;
  let uploads: string[];
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const entry = (text: string, role: TranscriptEntry["role"] = "user"): TranscriptEntry => ({
    uuid: "entry", ts: "2026-09-21T12:00:00Z", role, parts: [{ kind: "text", text }],
  });
  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), "nenu-upload-preview-"));
    state = join(temp, ".config", "nenu state");
    await mkdir(join(state, "uploads"), { recursive: true });
    uploads = [join(state, "uploads")];
    path = join(state, "uploads", "w1_p1-mabcd123-1234abcd.png");
    await writeFile(path, png);
  });
  afterEach(async () => { await rm(temp, { recursive: true, force: true }); });

  test("serves a user's uploaded image from protected state only with an exact journal reference", async () => {
    const response = await chatUploadPreviewResponse(uploads, path, [entry(`Review this photo: [image](<${path}>)`)]);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  });

  test("serves a picture a message still waiting in Nenu's queue on this pane names, before the journal has it (ADR 0114)", async () => {
    expect((await chatUploadPreviewResponse(uploads, path, [], null)).status).toBe(404);
    expect((await chatUploadPreviewResponse(uploads, path, [], null, [`mira esto ${path} se ve mal`])).status).toBe(200);
    // Only a whole token names it: a longer name that starts with it does not.
    expect((await chatUploadPreviewResponse(uploads, path, [], null, [`${path}x`])).status).toBe(404);
  });

  test("previews uploads from Nenu's uploads folder and from the old one beside the state", async () => {
    const home = join(temp, "home");
    const dirs = uploadDirs(defaultStateDir(home), home);
    const [current, legacy] = dirs;
    expect(current).toBe(join(home, ".local", "state", "nenu", "uploads"));
    const fresh = join(current!, "w1_p1-mabcd125-1234abcf.png");
    const older = join(legacy!, "w1_p1-mabcd126-1234abd0.png");
    for (const file of [fresh, older]) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, png); }
    const entries = [entry(`${fresh} and ${older}`)];
    for (const file of [fresh, older]) {
      expect(isChatUploadPath(dirs, file)).toBe(true);
      expect((await chatUploadPreviewResponse(dirs, file, entries)).status).toBe(200);
    }
    // A path in one folder never borrows the other's reference.
    const moved = join(current!, "w1_p1-mabcd126-1234abd0.png");
    await writeFile(moved, png);
    expect((await chatUploadPreviewResponse(dirs, moved, [entry(older)])).status).toBe(404);
  });

  test("revalidates with an ETag only while the reference and containment still hold", async () => {
    const entries = [entry(`see ${path}, thanks`)];
    const first = await chatUploadPreviewResponse(uploads, path, entries);
    const etag = first.headers.get("etag")!;
    await first.arrayBuffer();
    expect((await chatUploadPreviewResponse(uploads, path, entries, etag)).status).toBe(304);
    expect((await chatUploadPreviewResponse(uploads, path, [entry(path, "assistant")], etag)).status).toBe(404);
    await writeFile(join(temp, "outside.png"), png);
    await rm(path);
    await symlink(join(temp, "outside.png"), path);
    expect((await chatUploadPreviewResponse(uploads, path, entries, "*")).status).toBe(404);
  });

  test("finds every photo of a message from one scan of the same journal window", async () => {
    const second = join(state, "uploads", "w1_p1-mabcd124-1234abce.jpg");
    await writeFile(second, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]));
    const entries = [entry(`[image](<${path}>) and ${second}.`)];
    expect((await chatUploadPreviewResponse(uploads, path, entries)).status).toBe(200);
    expect((await chatUploadPreviewResponse(uploads, second, entries)).status).toBe(200);
    // Same entries object, different state dir: the memo never answers for another uploads root.
    const otherState = join(temp, "other");
    await mkdir(join(otherState, "uploads"), { recursive: true });
    expect((await chatUploadPreviewResponse([join(otherState, "uploads")], path, entries)).status).toBe(404);
  });

  test("rejects missing, assistant-only, and partial-path references", async () => {
    for (const entries of [[], [entry(path, "assistant")], [entry(`${path}.bak`)], [entry(`prefix${path}`)]]) {
      expect((await chatUploadPreviewResponse(uploads, path, entries)).status).toBe(404);
    }
  });

  test("cannot browse arbitrary state files or sibling directories", async () => {
    for (const candidate of [join(state, "auth.json"), join(state, "uploads-extra", "w1_p1-mabcd123-1234abcd.png"),
      join(state, "uploads", "image.png"), `${join(state, "uploads")}/../uploads/${path.split("/").at(-1)}`]) {
      expect(isChatUploadPath(uploads, candidate)).toBe(false);
      expect((await chatUploadPreviewResponse(uploads, candidate, [entry(candidate)])).status).toBe(404);
    }
  });

  test("rejects escaped and same-directory symlinks even when referenced", async () => {
    const other = join(temp, "outside.png");
    await writeFile(other, png);
    await rm(path);
    await symlink(other, path);
    expect((await chatUploadPreviewResponse(uploads, path, [entry(path)])).status).toBe(404);
    await rm(path);
    const sibling = join(state, "uploads", "w2_p1-mabcd123-1234abcd.png");
    await writeFile(sibling, png);
    await symlink(sibling, path);
    expect((await chatUploadPreviewResponse(uploads, path, [entry(path)])).status).toBe(404);
  });

  test("refuses removed uploads, non-images, directories and oversized uploads", async () => {
    await writeFile(path, "<svg onload='alert(1)'/>");
    expect((await chatUploadPreviewResponse(uploads, path, [entry(path)])).status).toBe(404);
    await writeFile(path, Buffer.alloc(10 * 1024 * 1024 + 1));
    expect((await chatUploadPreviewResponse(uploads, path, [entry(path)])).status).toBe(404);
    await rm(path);
    expect((await chatUploadPreviewResponse(uploads, path, [entry(path)])).status).toBe(404);
    await mkdir(path);
    expect((await chatUploadPreviewResponse(uploads, path, [entry(path)])).status).toBe(404);
  });
});
