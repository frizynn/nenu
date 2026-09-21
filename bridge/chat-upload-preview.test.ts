import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chatUploadPreviewResponse, isChatUploadPath } from "./chat-upload-preview.ts";
import type { TranscriptEntry } from "./journal/types.ts";

describe("chat upload previews", () => {
  let temp: string;
  let state: string;
  let path: string;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const entry = (text: string, role: TranscriptEntry["role"] = "user"): TranscriptEntry => ({
    uuid: "entry", ts: "2026-09-21T12:00:00Z", role, parts: [{ kind: "text", text }],
  });
  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), "nenu-upload-preview-"));
    state = join(temp, ".config", "nenu state");
    await mkdir(join(state, "uploads"), { recursive: true });
    path = join(state, "uploads", "w1_p1-mabcd123-1234abcd.png");
    await writeFile(path, png);
  });
  afterEach(async () => { await rm(temp, { recursive: true, force: true }); });

  test("serves a user's uploaded image from protected state only with an exact journal reference", async () => {
    const response = await chatUploadPreviewResponse(state, path, [entry(`Review this photo: [image](<${path}>)`)]);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  });

  test("rejects missing, assistant-only, and partial-path references", async () => {
    for (const entries of [[], [entry(path, "assistant")], [entry(`${path}.bak`)], [entry(`prefix${path}`)]]) {
      expect((await chatUploadPreviewResponse(state, path, entries)).status).toBe(404);
    }
  });

  test("cannot browse arbitrary state files or sibling directories", async () => {
    for (const candidate of [join(state, "auth.json"), join(state, "uploads-extra", "w1_p1-mabcd123-1234abcd.png"),
      join(state, "uploads", "image.png"), `${join(state, "uploads")}/../uploads/${path.split("/").at(-1)}`]) {
      expect(isChatUploadPath(state, candidate)).toBe(false);
      expect((await chatUploadPreviewResponse(state, candidate, [entry(candidate)])).status).toBe(404);
    }
  });

  test("rejects escaped and same-directory symlinks even when referenced", async () => {
    const other = join(temp, "outside.png");
    await writeFile(other, png);
    await rm(path);
    await symlink(other, path);
    expect((await chatUploadPreviewResponse(state, path, [entry(path)])).status).toBe(404);
    await rm(path);
    const sibling = join(state, "uploads", "w2_p1-mabcd123-1234abcd.png");
    await writeFile(sibling, png);
    await symlink(sibling, path);
    expect((await chatUploadPreviewResponse(state, path, [entry(path)])).status).toBe(404);
  });

  test("refuses removed uploads, non-images, directories and oversized uploads", async () => {
    await writeFile(path, "<svg onload='alert(1)'/>");
    expect((await chatUploadPreviewResponse(state, path, [entry(path)])).status).toBe(404);
    await writeFile(path, Buffer.alloc(10 * 1024 * 1024 + 1));
    expect((await chatUploadPreviewResponse(state, path, [entry(path)])).status).toBe(404);
    await rm(path);
    expect((await chatUploadPreviewResponse(state, path, [entry(path)])).status).toBe(404);
    await mkdir(path);
    expect((await chatUploadPreviewResponse(state, path, [entry(path)])).status).toBe(404);
  });
});
