import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, mkdir, realpath, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TranscriptEntry } from "./journal/types.ts";
import { deliveredFilePaths } from "./journal/delivered.ts";
import { artifactMetadata, mentionedFolders } from "./artifact-metadata.ts";
import { checkOpenable } from "./file-open.ts";
import { renderedHtmlResponse } from "./html-preview.ts";
import { FILE_STATE_HEADER, MAX_PREVIEW_FILE_BYTES, MAX_TEXT_FILE_BYTES, OUTSIDE_PROJECT_MESSAGE, paneFileResponse } from "./pane-files.ts";

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
      expect(response.headers.get("cache-control")).toBe("private, no-cache");
      expect(response.headers.get("etag")).toMatch(/^"[0-9a-z.-]+"$/);
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
    for (const path of ["outside/secret.md", "missing.md"]) {
      const response = await paneFileResponse(root, path);
      expect(response.status).toBe(404);
      expect(response.headers.get(FILE_STATE_HEADER)).toBeNull();
      expect(await response.text()).toBe("File unavailable in this workspace.");
    }
    // A name that points outside the project says so, decided from the name alone: an existing
    // and a missing file answer identically.
    for (const path of ["../project-extra/secret.md", join(sibling, "secret.md"), "../project-extra/missing.md"]) {
      const response = await paneFileResponse(root, path);
      expect(response.status).toBe(404);
      expect(response.headers.get(FILE_STATE_HEADER)).toBe("outside-project");
      expect(await response.text()).toBe(OUTSIDE_PROJECT_MESSAGE);
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

  // An agent that cd'd into a repo below the pane's folder names its files relative to that repo.
  describe("a relative name under a folder the conversation names", () => {
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.alloc(52)]);
    let repo: string;
    beforeEach(async () => {
      repo = join(root, "code", "film");
      await mkdir(join(repo, "out"), { recursive: true });
      await writeFile(join(repo, "out", "cut.mp4"), mp4);
      await writeFile(join(repo, "notes.md"), "# Notes\n");
    });

    test("is served from the one folder that holds it, any kind", async () => {
      const folders = async () => [join(dir, "elsewhere"), repo];
      const video = await paneFileResponse(root, "out/cut.mp4", { folders, range: "bytes=0-15" });
      expect(video.status).toBe(206);
      expect(video.headers.get("content-type")).toBe("video/mp4");
      const notes = await paneFileResponse(root, "notes.md", { folders });
      expect(await notes.text()).toBe("# Notes\n");
      // The pane's own folder still answers first.
      await writeFile(join(root, "notes.md"), "# Root\n");
      expect(await (await paneFileResponse(root, "notes.md", { folders })).text()).toBe("# Root\n");
    });

    test("uses the newest named folder when more than one holds the name", async () => {
      const other = join(root, "code", "other");
      await mkdir(other, { recursive: true });
      expect((await paneFileResponse(root, "notes.md", { folders: async () => [repo, other] })).status).toBe(200);
      await writeFile(join(other, "notes.md"), "# Other\n");
      const newest = await paneFileResponse(root, "notes.md", { folders: async () => [other, repo] });
      expect(await newest.text()).toBe("# Other\n");
    });

    test("never reaches past the pane's folder, by a named folder, traversal or a symlink", async () => {
      const outside = join(dir, "outside");
      await mkdir(outside);
      await writeFile(join(outside, "secret.md"), "secret");
      await symlink(join(outside, "secret.md"), join(repo, "linked.md"));
      const folders = async () => [outside, repo];
      // The same lookup finds a contained file, so the refusals below are the gate and not a miss.
      expect((await paneFileResponse(root, "notes.md", { folders })).status).toBe(200);
      for (const name of ["secret.md", "linked.md", "../../../outside/secret.md"]) {
        const denied = await paneFileResponse(root, name, { folders });
        expect(denied.status).toBe(404);
        expect(await denied.text()).not.toContain("secret");
      }
    });
  });

  test("previews a file the agent delivered from outside the workspace, and nothing else outside it", async () => {
    const outside = join(dir, "downloads");
    await mkdir(outside);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]);
    for (const name of ["sent.jpg", "mentioned.jpg", "failed.jpg"]) await writeFile(join(outside, name), jpeg);
    await mkdir(join(outside, ".ssh"));
    await writeFile(join(outside, ".ssh", "key.jpg"), jpeg);
    await symlink(join(outside, ".ssh", "key.jpg"), join(outside, "innocent.jpg"));
    const sent = (paths: string[], isError = false): TranscriptEntry["parts"][number] => ({
      kind: "tool", name: "SendUserFile", summary: "caption",
      result: { text: `${paths.length} files delivered to user.\n${paths.map((p) => `  ${p} → file_uuid: 1795c2da-acf0-4e82-b3d8-ccf28783bcfc`).join("\n")}`, ...(isError ? { isError } : {}) },
    });
    const entries: TranscriptEntry[] = [
      { uuid: "a", ts: "", role: "assistant", parts: [{ kind: "text", text: `See ${join(outside, "mentioned.jpg")}` }] },
      { uuid: "b", ts: "", role: "assistant", parts: [sent([join(outside, "sent.jpg"), join(outside, "innocent.jpg"), join(outside, ".ssh", "key.jpg")]), sent([join(outside, "failed.jpg")], true)] },
    ];
    const delivered = async () => deliveredFilePaths(entries);

    const response = await paneFileResponse(root, join(outside, "sent.jpg"), { delivered });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(jpeg));

    // The assistant's prose names a delivered file by its bare name or a trailing part of its path.
    for (const name of ["sent.jpg", "downloads/sent.jpg"]) {
      const named = await paneFileResponse(root, name, { delivered });
      expect(named.status).toBe(200);
      expect(new Uint8Array(await named.arrayBuffer())).toEqual(new Uint8Array(jpeg));
    }
    for (const name of ["mentioned.jpg", "failed.jpg", "ent.jpg"]) {
      expect((await paneFileResponse(root, name, { delivered })).status).toBe(404);
    }

    for (const name of ["mentioned.jpg", "failed.jpg"]) {
      const denied = await paneFileResponse(root, join(outside, name), { delivered });
      expect(denied.status).toBe(404);
      expect(await denied.text()).toBe(OUTSIDE_PROJECT_MESSAGE);
    }
    for (const name of ["innocent.jpg", ".ssh/key.jpg"]) {
      const denied = await paneFileResponse(root, join(outside, name), { delivered });
      expect(denied.status).toBe(404);
      expect(await denied.text()).toBe("File unavailable in this workspace.");
    }
  });

  test("revalidates with an ETag only after containment, and never caches errors", async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
    await writeFile(join(root, "shot.png"), png);
    const first = await paneFileResponse(root, "shot.png");
    const etag = first.headers.get("etag")!;
    expect(first.headers.get("cache-control")).toBe("private, no-cache");
    await first.arrayBuffer();

    const cached = await paneFileResponse(root, "shot.png", { ifNoneMatch: `W/${etag}, "other"` });
    expect(cached.status).toBe(304);
    expect(cached.headers.get("etag")).toBe(etag);
    expect(cached.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(await cached.text()).toBe("");

    await writeFile(join(root, "shot.png"), Buffer.concat([png, Buffer.alloc(1)]));
    const changed = await paneFileResponse(root, "shot.png", { ifNoneMatch: etag });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
    await changed.arrayBuffer();

    // A wildcard or a stale tag never turns a refused path into a 304.
    const outside = join(dir, "outside.png");
    await writeFile(outside, png);
    await rm(join(root, "shot.png"));
    await symlink(outside, join(root, "shot.png"));
    for (const path of ["shot.png", "../outside.png", ".env.png", "missing.png"]) {
      const denied = await paneFileResponse(root, path, { ifNoneMatch: "*" });
      expect(denied.status).toBe(404);
      expect(denied.headers.get("cache-control")).toBe("no-store");
      expect(denied.headers.get("etag")).toBeNull();
    }
  });

  test("streams images and PDFs in bounded chunks instead of buffering the whole file", async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(3 * 1024 * 1024, 7)]);
    await writeFile(join(root, "big.png"), png);
    const response = await paneFileResponse(root, "big.png");
    expect(response.headers.get("content-length")).toBe(String(png.length));
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    for (let read = await reader.read(); !read.done; read = await reader.read()) chunks.push(read.value);
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(256 * 1024);
    expect(Buffer.concat(chunks)).toEqual(png);
  });

  test("never serves Nenu's own state, uploads included, even from a folder that holds it", async () => {
    // A pane opened in the home folder holds the state dir; an upload the operator attached is
    // read by the agent, never served back by Nenu, whether named by path or delivered.
    const state = join(root, ".local", "nenu-state");
    await mkdir(join(state, "uploads"), { recursive: true });
    await writeFile(join(state, "uploads", "w1_p1-mv8g-0a1b2c3d-notes.txt"), "uploaded");
    await writeFile(join(state, "audit.log"), "audit");
    await symlink(join(state, "uploads"), join(root, "linked-uploads"));
    const delivered = async () => [join(state, "uploads", "w1_p1-mv8g-0a1b2c3d-notes.txt")];
    for (const path of [".local/nenu-state/uploads/w1_p1-mv8g-0a1b2c3d-notes.txt", ".local/nenu-state/audit.log",
      "linked-uploads/w1_p1-mv8g-0a1b2c3d-notes.txt", join(state, "uploads", "w1_p1-mv8g-0a1b2c3d-notes.txt"), "w1_p1-mv8g-0a1b2c3d-notes.txt"]) {
      const response = await paneFileResponse(root, path, { delivered, stateDir: state });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("uploaded");
    }
    await writeFile(join(root, "readme.md"), "fine");
    expect((await paneFileResponse(root, "readme.md", { stateDir: state })).status).toBe(200);
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
    const response = await paneFileResponse(root,"demo.mp4",{ range: "bytes=12-19" });
    expect(response.status).toBe(206);expect(response.headers.get("content-range")).toBe(`bytes 12-19/${bytes.length}`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(bytes.subarray(12,20)));
    expect((await paneFileResponse(root,"demo.mp4",{ range: "bytes=9999-" })).status).toBe(416);
    await writeFile(join(root,"bad.mp4"),"<script>bad</script>");
    expect((await paneFileResponse(root,"bad.mp4")).status).toBe(415);
  } finally { await rm(root,{recursive:true,force:true}); }
});

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

function prose(...texts: string[]): TranscriptEntry[] {
  return texts.map((text, index) => ({
    uuid: String(index),
    ts: String(index),
    role: "assistant",
    parts: [{ kind: "text", text }],
  }));
}

describe("relative files in folders named by the conversation", () => {
  let dir: string;
  let root: string;
  let state: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "nenu-pane-file-named-")));
    root = join(dir, "project");
    state = join(root, ".nenu-state");
    await mkdir(root);
    await mkdir(state);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("rechecks containment after a named folder is swapped for an outside symlink", async () => {
    const named = join(root, "repos", "film");
    const outside = join(dir, "outside");
    await mkdir(named, { recursive: true });
    await mkdir(outside);
    await writeFile(join(named, "notes.md"), "inside");
    await writeFile(join(outside, "notes.md"), "outside");

    const originalOpen = fsPromises.open;
    let swapped = false;
    const openSpy = spyOn(fsPromises, "open").mockImplementation(async (path, ...args) => {
      if (!swapped && String(path) === join(named, "notes.md")) {
        swapped = true;
        await rename(named, `${named}-before-swap`);
        await symlink(outside, named, "dir");
      }
      return originalOpen(path, ...args);
    });
    try {
      const response = await paneFileResponse(root, "notes.md", { folders: async () => [named] });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("outside");
    } finally {
      openSpy.mockRestore();
    }
  });

  test("the same swap under the pane folder is already caught", async () => {
    const named = join(root, "local");
    const outside = join(dir, "outside-local");
    await mkdir(named);
    await mkdir(outside);
    await writeFile(join(named, "notes.md"), "inside");
    await writeFile(join(outside, "notes.md"), "outside");

    const originalOpen = fsPromises.open;
    let swapped = false;
    const openSpy = spyOn(fsPromises, "open").mockImplementation(async (path, ...args) => {
      if (!swapped && String(path) === join(named, "notes.md")) {
        swapped = true;
        await rename(named, `${named}-before-swap`);
        await symlink(outside, named, "dir");
      }
      return originalOpen(path, ...args);
    });
    try {
      expect((await paneFileResponse(root, "local/notes.md")).status).toBe(404);
    } finally {
      openSpy.mockRestore();
    }
  });

  test.each([
    ["audio.wav", "RIFF", 4],
    ["large.pdf", "%PDF-1.7\n", MAX_PREVIEW_FILE_BYTES + 1],
  ] as const)("named %s stays a 404 and can be inspected then opened", async (name, content, size) => {
    const repo = join(root, "repo");
    await mkdir(repo);
    await writeFile(join(repo, name), content);
    if (size > content.length) await truncate(join(repo, name), size);
    const folders = async () => [repo];

    expect((await paneFileResponse(root, name, { folders })).status).toBe(404);
    const metadata = await artifactMetadata(root, [name], {
      folders,
      openable: async (path) => {
        const file = await checkOpenable(path, state);
        return "status" in file ? null : file.path;
      },
    });
    expect(metadata).toEqual([{ path: name, state: "preview", resolved: join(repo, name) }]);
    const inspected = metadata[0]!;
    if (!("resolved" in inspected)) throw new Error("inspection did not resolve the named file");
    expect(await checkOpenable(inspected.resolved, state)).toMatchObject({ path: join(repo, name) });
  });

  test("uses the same newest-first named-folder order as artifact inspection", async () => {
    const older = join(root, "older");
    const newer = join(root, "newer");
    await mkdir(older);
    await mkdir(newer);
    await writeFile(join(older, "notes.md"), "older");
    await writeFile(join(newer, "notes.md"), "newer");
    const entries = prose(`Worked in ${older}/notes.md`, `Finished in ${newer}/notes.md`);
    const folders = async () => mentionedFolders(entries);

    expect(await folders()).toEqual([newer, older]);
    expect(await (await paneFileResponse(root, "notes.md", { folders })).text()).toBe("newer");
    expect(await artifactMetadata(root, ["notes.md"], { folders })).toEqual([
      { path: "notes.md", state: "preview", resolved: join(newer, "notes.md") },
    ]);
  });

  test("skips a private newest folder and uses the next named folder", async () => {
    const older = join(root, "older");
    const privateFolder = join(root, ".ssh");
    await mkdir(older);
    await mkdir(privateFolder);
    await writeFile(join(older, "notes.md"), "public");
    await writeFile(join(privateFolder, "notes.md"), "private");
    const entries = prose(`Worked in ${older}/notes.md`, `Latest copy is ${privateFolder}/notes.md`);
    const folders = async () => mentionedFolders(entries);

    expect(await folders()).toEqual([privateFolder, older]);
    expect(await (await paneFileResponse(root, "notes.md", { folders })).text()).toBe("public");
    expect(await artifactMetadata(root, ["notes.md"], { folders })).toEqual([
      { path: "notes.md", state: "preview", resolved: join(older, "notes.md") },
    ]);
  });

  test("refuses an uploads folder even when the conversation names it", async () => {
    const uploads = join(state, "uploads");
    const name = "w1_p1-mv8g-0a1b2c3d-notes.txt";
    await mkdir(uploads);
    await writeFile(join(uploads, name), "uploaded");
    const folders = async () => mentionedFolders(prose(`The file is ${uploads}/${name}`));

    const response = await paneFileResponse(root, name, { folders, stateDir: state });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("uploaded");
  });

  test("HTML preview follows the named folder and inlines its sibling image", async () => {
    const site = join(root, "repo", "site");
    await mkdir(site, { recursive: true });
    await writeFile(join(site, "index.html"), '<h1>Page</h1><img src="sibling.png">');
    await writeFile(join(site, "sibling.png"), PNG);
    const folders = async () => mentionedFolders(prose(`Rendered ${site}/index.html`));

    const response = await renderedHtmlResponse(root, "index.html", { folders, inlineAssets: true });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`src="data:image/png;base64,${PNG.toString("base64")}"`);
  });
});
