import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { libraryFileResponse } from "./org-library.ts";

// A project's library is the folder Organizations copies each thread's captures and deliverables
// into (`<project>/library/<thread id>/`). The route serves pictures, HTML and PDFs from it and
// nothing else: every refusal below is a 404 whatever the reason, so a probe learns nothing.

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c40000000049454e44ae426082", "hex");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A projects root with `demo`'s library holding one thread's files, and secrets beside it. */
function fixture() {
  const root = join(tmpdir(), `nenu-library-${crypto.randomUUID()}`);
  roots.push(root);
  const project = join(root, "demo");
  const thread = join(project, "library", "t-0002");
  mkdirSync(thread, { recursive: true });
  mkdirSync(join(project, "threads"), { recursive: true });
  mkdirSync(join(root, "other", "library"), { recursive: true });
  writeFileSync(join(thread, "checkout.png"), PNG);
  writeFileSync(join(thread, "summary.pdf"), PDF);
  writeFileSync(join(thread, "report.html"), `<!doctype html><title>Report</title><img src="checkout.png"><script src="https://example.com/x.js"></script>`);
  writeFileSync(join(thread, "notes.md"), "# Notes");
  writeFileSync(join(thread, "data.json"), "{}");
  writeFileSync(join(thread, "fake.png"), "not a picture");
  writeFileSync(join(project, "threads", "t-0002.toml"), `id = "t-0002"`);
  writeFileSync(join(project, "secret.png"), PNG);
  writeFileSync(join(root, "other", "library", "theirs.png"), PNG);
  const outside = join(root, "outside.png");
  writeFileSync(outside, PNG);
  return { root, library: join(project, "library"), thread, outside };
}

const serve = (library: string | undefined, path: string | null) => libraryFileResponse(library, path, { stateDir: join(tmpdir(), "nenu-library-state"), inlineAssets: true });

describe("a project's library", () => {
  test("serves a picture inside it by its bytes", async () => {
    const { library, thread } = fixture();
    const response = await serve(library, join(thread, "checkout.png"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true);
  });

  test("serves HTML as an opaque, offline document, its sibling pictures inlined", async () => {
    const { library, thread } = fixture();
    const response = await serve(library, join(thread, "report.html"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const csp = response.headers.get("content-security-policy")!;
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain("allow-same-origin");
    const body = await response.text();
    expect(body).toContain("data:image/png;base64,");
    expect(body).toContain("https://example.com/x.js");
  });

  test("serves a PDF for the browser's own viewer, which a sandbox header would block", async () => {
    const { library, thread } = fixture();
    const response = await serve(library, join(thread, "summary.pdf"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("refuses every other kind of file in it", async () => {
    const { library, thread } = fixture();
    for (const name of ["notes.md", "data.json"]) expect((await serve(library, join(thread, name))).status).toBe(404);
    expect((await serve(library, join(thread, "fake.png"))).status).toBe(415);
  });

  test("refuses anything outside it, however the path gets there", async () => {
    const { root, library, thread, outside } = fixture();
    const demo = join(root, "demo");
    for (const path of [
      outside,
      join(demo, "secret.png"),
      join(library, "..", "secret.png"),
      join(thread, "..", "..", "threads", "t-0002.toml"),
      join(root, "other", "library", "theirs.png"),
      "/etc/passwd",
      "checkout.png",
      "t-0002/checkout.png",
    ]) expect((await serve(library, path)).status, path).toBe(404);
  });

  test("refuses a link inside it that leads out, or to a file of another kind", async () => {
    const { library, thread, outside } = fixture();
    symlinkSync(outside, join(thread, "linked.png"));
    symlinkSync(join(thread, "notes.md"), join(thread, "notes.png"));
    symlinkSync(join(thread, "checkout.png"), join(thread, "same.png"));
    expect((await serve(library, join(thread, "linked.png"))).status).toBe(404);
    expect((await serve(library, join(thread, "notes.png"))).status).toBe(404);
    expect((await serve(library, join(thread, "same.png"))).status).toBe(200);
  });

  test("serves nothing when the library itself is a link, as Organizations copies none into one", async () => {
    const { root, thread } = fixture();
    const linked = join(root, "linked");
    mkdirSync(linked);
    symlinkSync(join(root, "demo", "library"), join(linked, "library"));
    expect((await serve(join(linked, "library"), join(linked, "library", "t-0002", "checkout.png"))).status).toBe(404);
    expect((await serve(join(linked, "library"), join(thread, "checkout.png"))).status).toBe(404);
  });

  test("serves nothing for a project it does not know, a missing library or no path", async () => {
    const { root, thread } = fixture();
    expect((await serve(undefined, join(thread, "checkout.png"))).status).toBe(404);
    expect((await serve(join(root, "missing", "library"), join(root, "missing", "library", "a.png"))).status).toBe(404);
    expect((await serve(join(root, "demo", "library"), null)).status).toBe(400);
    expect((await serve(join(root, "demo", "library"), `${thread}/checkout.png\u0000`)).status).toBe(404);
  });
});
