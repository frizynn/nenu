import { describe, it, expect } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactMetadata, mentionedFolders } from "./artifact-metadata.ts";
import { designboardTitle, designboardTitleFromHead, designboardPreview } from "./designboard.ts";
const canvas =
  '<script id="canvas-doc" type="application/json">{"title":"Checkout study","files":{"Main.html":"<h1>Checkout</h1>"}}</script>';
describe("artifact metadata", () => {
  it("identifies embedded designboards but rejects ordinary HTML and malformed documents", () => {
    expect(designboardTitle(canvas)).toBe("Checkout study");
    for (const source of [
      "<h1>App entry</h1>",
      '<script id="canvas-doc" type="application/json">{}</script>',
      canvas.replace('"Main.html"', '"data.json"'),
    ])
      expect(designboardTitle(source)).toBeNull();
  });
  it("reads contained canvases, refuses escaping symlinks and bounds requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "nenu-artifacts-"));
    const outside = await mkdtemp(join(tmpdir(), "nenu-outside-"));
    try {
      await writeFile(join(root, "canvas.html"), canvas);
      await writeFile(join(root, "index.html"), "<h1>Source</h1>");
      await writeFile(join(outside, "private.html"), canvas);
      await symlink(join(outside, "private.html"), join(root, "escape.html"));
      expect(
        await artifactMetadata(root, [
          "canvas.html",
          "index.html",
          "escape.html",
        ]),
      ).toEqual([
        { path: "canvas.html", state: "preview", designboard: "Checkout study" },
        { path: "index.html", state: "preview" },
        { path: "escape.html", state: "missing" },
      ]);
      await expect(
        artifactMetadata(root, Array(21).fill("canvas.html")),
      ).rejects.toThrow("At most 20");
    } finally {
      await rm(root, { recursive: true });
      await rm(outside, { recursive: true });
    }
  });
});

it("previews canvases in view mode without changing other HTML or allowing script breakout", () => {
  expect(designboardPreview(canvas)).toContain('"mode":"view"');
  expect(designboardPreview(canvas)).toContain('classList.add("no-side")');
  expect(designboardPreview("<h1>Source</h1>")).toBe("<h1>Source</h1>");
  const withComment = canvas.replace(
    "Checkout</h1>",
    "Checkout</h1><\\!-- note -->",
  );
  expect(designboardTitle(withComment)).toBe("Checkout study");
  expect(designboardPreview(withComment)).not.toContain("<h1>");
});

it("identifies a large canvas from its first bytes and caches the answer per file version", async () => {
  const root = await mkdtemp(join(tmpdir(), "nenu-artifacts-head-"));
  try {
    const big = (title: string) =>
      `<html><body><script id="canvas-doc" type="application/json">{"title":${JSON.stringify(title)},"mode":"edit","files":{"Main.html":"${"x".repeat(1024 * 1024)}"}}</script></body></html>`;
    await writeFile(join(root, "board.html"), big('Big "board"'));
    expect(await artifactMetadata(root, ["board.html"])).toEqual([
      { path: "board.html", state: "preview", designboard: 'Big "board"' },
    ]);
    await writeFile(join(root, "board.html"), big("Renamed"));
    expect((await artifactMetadata(root, ["board.html"]))[0]?.designboard).toBe("Renamed");
    // An unclosed prefix without an HTML artboard is not a canvas.
    await writeFile(join(root, "data.html"),
      `<script id="canvas-doc" type="application/json">{"title":"Data","files":{"data.json":"${"x".repeat(128 * 1024)}"}}</script>`);
    expect(await artifactMetadata(root, ["data.html"])).toEqual([{ path: "data.html", state: "preview" }]);
  } finally {
    await rm(root, { recursive: true });
  }
});

it("reads the title from a truncated head only when the canvas block is open", () => {
  const head = '<script id="canvas-doc" type="application/json">{"title":"Partial","files":{"Main.html":"<h1>';
  expect(designboardTitleFromHead(head, false)).toBe("Partial");
  expect(designboardTitleFromHead(head, true)).toBeNull();
  expect(designboardTitleFromHead("<h1>plain</h1>", false)).toBeNull();
});

describe("where a name in the conversation leads", () => {
  // A compaction summary written in the designboard pane (cwd ~/Developer) names its files relative
  // to the folders it declares: the skill repo inside the cwd and a scratchpad outside it.
  it("finds a relative name in a folder the conversation names, inside or outside the agent's", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "nenu-cwd-")));
    const scratch = await realpath(await mkdtemp(join(tmpdir(), "nenu-scratch-")));
    try {
      const repo = join(root, "labs", "designboard");
      await mkdir(join(repo, "assets"), { recursive: true });
      await writeFile(join(repo, "assets", "canvas.template.html"), "<h1>Template</h1>");
      await mkdir(join(scratch, "real"));
      await writeFile(join(scratch, "real", "scroll.html"), "<h1>Scroll</h1>");
      const folders = async () => [repo, scratch];
      const openable = async (path: string) => realpath(path).catch(() => null);
      expect(await artifactMetadata(root, ["assets/canvas.template.html", "real/scroll.html", "gone.html"], { folders, openable })).toEqual([
        { path: "assets/canvas.template.html", state: "preview", resolved: join(repo, "assets", "canvas.template.html") },
        { path: "real/scroll.html", state: "outside", resolved: join(scratch, "real", "scroll.html") },
        { path: "gone.html", state: "missing" },
      ]);
      // A device that could not open a file outside the folder learns nothing about one.
      expect(await artifactMetadata(root, ["real/scroll.html"], { folders })).toEqual([{ path: "real/scroll.html", state: "missing" }]);
      // A declared folder is a place to look, not a way to climb out of it.
      expect(await artifactMetadata(root, ["../real/scroll.html"], { folders: async () => [join(scratch, "real")], openable }))
        .toEqual([{ path: "../real/scroll.html", state: "missing" }]);
    } finally {
      await rm(root, { recursive: true });
      await rm(scratch, { recursive: true });
    }
  });

  it("reads ~/ as the bridge user's home and an absolute path outside the folder as outside", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "nenu-cwd-")));
    const home = await realpath(await mkdtemp(join(tmpdir(), "nenu-home-")));
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      await mkdir(join(home, "Downloads", "boceto"), { recursive: true });
      await writeFile(join(home, "Downloads", "boceto", "v2.html"), "<h1>v2</h1>");
      const openable = async (path: string) => realpath(path).catch(() => null);
      expect(await artifactMetadata(root, ["~/Downloads/boceto/v2.html", "~/Downloads/boceto/v9.html"], { openable })).toEqual([
        { path: "~/Downloads/boceto/v2.html", state: "outside", resolved: join(home, "Downloads", "boceto", "v2.html") },
        { path: "~/Downloads/boceto/v9.html", state: "missing" },
      ]);
      // Without a way to open it, an absolute path outside the folder is outside by its name alone.
      expect(await artifactMetadata(root, [join(home, "Downloads", "boceto", "v9.html")])).toEqual([
        { path: join(home, "Downloads", "boceto", "v9.html"), state: "outside" },
      ]);
    } finally {
      process.env.HOME = previous;
      await rm(root, { recursive: true });
      await rm(home, { recursive: true });
    }
  });

  it("collects the folders the conversation names, newest first, without URLs or elided paths", () => {
    const previous = process.env.HOME;
    process.env.HOME = "/home/op";
    try {
      const text = (body: string) => ({ uuid: body, ts: "", role: "summary" as const, parts: [{ kind: "text" as const, text: body }] });
      expect(mentionedFolders([
        text("Base directory for this skill: /home/op/.agents/skills/designboard\n\nSee https://example.com/docs/a.html"),
        text("The skill lives in `~/Developer/labs/designboard`. Key files: `assets/canvas.template.html`."),
        text("Scratch at /private/tmp/s/scratchpad (e.g. file:///private/tmp/s/scratchpad/awam-scroll.html, /Users/.../x.html)."),
      ])).toEqual(["/private/tmp/s/scratchpad", "/home/op/Developer/labs/designboard", "/home/op/.agents/skills/designboard"]);
    } finally {
      process.env.HOME = previous;
    }
  });
});
