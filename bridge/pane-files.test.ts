import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MAX_PREVIEW_FILE_BYTES, MAX_TEXT_FILE_BYTES, paneFileResponse } from "./pane-files.ts";

describe("pane project files", () => {
  let dir: string;
  let root: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "collie-files-"));
    root = join(dir, "project");
    await mkdir(root);
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test("reads relative and absolute Markdown paths and reports a safe download name", async () => {
    await writeFile(join(root, "hello world.md"), "# Hello\n");
    for (const path of ["hello world.md", join(root, "hello world.md")]) {
      const response = await paneFileResponse(root, path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
      expect(response.headers.get("content-disposition")).toContain("hello%20world.md");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe("# Hello\n");
    }
  });

  test("normalizes symlinked workspace roots and permits contained file links", async () => {
    await writeFile(join(root, "readme.md"), "readme");
    await symlink(root, join(dir, "workspace"));
    await symlink(join(root, "readme.md"), join(root, "linked.md"));
    const response = await paneFileResponse(join(dir, "workspace"), "linked.md");
    expect(await response.text()).toBe("readme");
  });

  test("denies sibling prefix, traversal and symlink escapes without revealing existence", async () => {
    const sibling = join(dir, "project-extra");
    await mkdir(sibling);
    await writeFile(join(sibling, "secret.md"), "private");
    await symlink(sibling, join(root, "outside"));
    for (const path of ["../project-extra/secret.md", join(sibling, "secret.md"), "outside/secret.md", "missing.md"]) {
      const response = await paneFileResponse(root, path);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("File unavailable in this workspace.");
    }
  });

  test("rejects sensitive names and disguised links to sensitive paths", async () => {
    for (const name of [".env.local", "credentials.json", "auth.json", "id_ed25519", "private.key", ".npmrc"]) {
      await writeFile(join(root, name), "private");
      expect((await paneFileResponse(root, name)).status).toBe(404);
    }
    await symlink(join(root, "credentials.json"), join(root, "public.json"));
    expect((await paneFileResponse(root, "public.json")).status).toBe(404);
    await mkdir(join(root, ".ssh"));
    await writeFile(join(root, ".ssh", "notes.txt"), "private");
    expect((await paneFileResponse(join(root, ".ssh"), "notes.txt")).status).toBe(404);
  });

  test("does not serve project HTML or SVG as active documents", async () => {
    for (const name of ["attack.html", "attack.svg"]) {
      const content = "<script>alert(1)</script>";
      await writeFile(join(root, name), content);
      const response = await paneFileResponse(root, name);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toContain("sandbox");
      expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(await response.text()).toBe(content);
    }
  });

  test("sniffs PDF and raster data before assigning a non-text MIME", async () => {
    await writeFile(join(root, "document.pdf"), "%PDF-1.7\npreview");
    expect((await paneFileResponse(root, "document.pdf")).headers.get("content-type")).toBe("application/pdf");
    await writeFile(join(root, "fake.pdf"), "<html>not PDF</html>");
    expect((await paneFileResponse(root, "fake.pdf")).status).toBe(415);
    await writeFile(join(root, "photo.png"), Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    expect((await paneFileResponse(root, "photo.png")).headers.get("content-type")).toBe("image/jpeg");
    await writeFile(join(root, "fake.png"), "<svg onload=alert(1) />");
    expect((await paneFileResponse(root, "fake.png")).status).toBe(415);
  });

  test("caps text and PDF memory separately and rejects unknown binary files", async () => {
    await writeFile(join(root, "huge.md"), Buffer.alloc(MAX_TEXT_FILE_BYTES + 1));
    await writeFile(join(root, "huge.pdf"), Buffer.alloc(MAX_PREVIEW_FILE_BYTES + 1));
    await writeFile(join(root, "binary.txt"), Buffer.from([65, 0, 66]));
    await writeFile(join(root, "binary.zip"), "zip");
    expect((await paneFileResponse(root, "huge.md")).status).toBe(413);
    expect((await paneFileResponse(root, "huge.pdf")).status).toBe(413);
    expect((await paneFileResponse(root, "binary.txt")).status).toBe(415);
    expect((await paneFileResponse(root, "binary.zip")).status).toBe(415);
  });

  test("rejects missing panes, directories, filesystem root and malformed input", async () => {
    expect((await paneFileResponse(undefined, "file.md")).status).toBe(404);
    expect((await paneFileResponse("/", "etc/hosts")).status).toBe(404);
    await mkdir(join(root, "folder.md"));
    expect((await paneFileResponse(root, "folder.md")).status).toBe(404);
    for (const path of [null, "", "bad\0path", "x".repeat(4097)]) {
      expect((await paneFileResponse(root, path)).status).toBe(400);
    }
  });
});

test("video previews validate content and honor seek ranges", async () => {
  const root = await mkdtemp(join(tmpdir(), "nenu-video-"));
  try {
    const bytes = Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from("ftypisom"),Buffer.alloc(100,7)]);
    await writeFile(join(root,"demo.mp4"),bytes);
    const response = await paneFileResponse(root,"demo.mp4","bytes=12-19");
    expect(response.status).toBe(206);expect(response.headers.get("content-range")).toBe(`bytes 12-19/${bytes.length}`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(bytes.subarray(12,20)));
    expect((await paneFileResponse(root,"demo.mp4","bytes=9999-")).status).toBe(416);
    await writeFile(join(root,"bad.mp4"),"<script>bad</script>");
    expect((await paneFileResponse(root,"bad.mp4")).status).toBe(415);
  } finally { await rm(root,{recursive:true,force:true}); }
});
