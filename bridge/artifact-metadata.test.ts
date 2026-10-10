import { describe, it, expect } from "bun:test";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactMetadata } from "./artifact-metadata.ts";
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
        { path: "canvas.html", kind: "designboard", title: "Checkout study" },
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
      { path: "board.html", kind: "designboard", title: 'Big "board"' },
    ]);
    await writeFile(join(root, "board.html"), big("Renamed"));
    expect((await artifactMetadata(root, ["board.html"]))[0]?.title).toBe("Renamed");
    // An unclosed prefix without an HTML artboard is not a canvas.
    await writeFile(join(root, "data.html"),
      `<script id="canvas-doc" type="application/json">{"title":"Data","files":{"data.json":"${"x".repeat(128 * 1024)}"}}</script>`);
    expect(await artifactMetadata(root, ["data.html"])).toEqual([]);
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
