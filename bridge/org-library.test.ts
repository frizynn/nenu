import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OrgRun } from "./org-cli.ts";
import { libraryFileResponse, reportResponse, type ThreadReport } from "./org-library.ts";
import { ProjectRegistry } from "./projects.ts";

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

const serve = (library: string | undefined, path: string | null) => libraryFileResponse(library, path, { nenuDirs: [join(tmpdir(), "nenu-library-state")], inlineAssets: true });

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

/**
 * A projects root with `demo`, whose records folder (Organizations' `records` setting) is elsewhere:
 * the library and the reports live there, as `overview --json` reports each thread's `library` and
 * `report`. Beside them, a picture and a report outside the library, and links that lead out.
 */
async function recordsFixture() {
  const root = join(tmpdir(), `nenu-library-${crypto.randomUUID()}`);
  const records = join(tmpdir(), `nenu-records-${crypto.randomUUID()}`);
  roots.push(root, records);
  mkdirSync(join(root, "demo"), { recursive: true });
  writeFileSync(join(root, "demo", "PROJECT.md"), `+++\nname = "Demo"\n+++\n`);
  const thread = join(records, "library", "t-0002");
  mkdirSync(thread, { recursive: true });
  mkdirSync(join(records, "threads"), { recursive: true });
  writeFileSync(join(thread, "checkout.png"), PNG);
  writeFileSync(join(records, "stray.png"), PNG);
  writeFileSync(join(records, "threads", "t-0002.md"), "Status: needs-decision\n\n## Summary\nPick one.\n\n| A | B |\n| - | - |\n| 1 | 2 |\n");
  writeFileSync(join(records, "threads", "t-0003.md"), "Status: done\n");
  writeFileSync(join(root, "outside.md"), "# Not a report");
  symlinkSync(join(records, "stray.png"), join(thread, "linked.png"));
  symlinkSync(join(records, "threads", "t-0003.md"), join(records, "threads", "t-0004.md"));
  const node = (id: string, report: string | null) => ({
    id, title: `Thread ${id}`, parent_id: "root", role: "worker", status: "resolved", group: "resolved", group_label: "Resolved", note: "", branch: "",
    workspace_id: "", tab_id: "", pane_id: "", cwd: "", updated: "", report_unacked: false, pr: null, verdict: "needs-decision", summary: "Pick one.",
    captures: [{ path: join(thread, "checkout.png"), caption: "Checkout" }], deliverables: [], library: join(records, "library", id), report,
  });
  const run: OrgRun = async (argv) => argv[0] !== "overview" ? { code: 2, stdout: "", stderr: "error: unrecognized subcommand" } : {
    code: 0, stderr: "", stdout: JSON.stringify({ schema_version: 1, projects: [{ slug: "demo", name: "Demo", goal: "", status: "active", icon: "", tone: "", threads: [
      node("t-0002", join(records, "threads", "t-0002.md")),
      node("t-0003", join(root, "outside.md")),
      node("t-0004", join(records, "threads", "t-0004.md")),
      node("t-0005", join(records, "threads", "..", "..", "outside.md")),
      node("t-0006", null),
    ] }] }),
  };
  const registry = new ProjectRegistry({ root, now: () => 1, run, watch: false, upstream: () => false });
  await registry.refresh();
  return { registry, records, thread, root };
}

const state = { nenuDirs: [join(tmpdir(), "nenu-library-state")] };

describe("a project whose records folder is outside the projects root", () => {
  test("serves a capture from the library there, by its bytes", async () => {
    const { registry, thread } = await recordsFixture();
    try {
      const response = await serve(registry.library("demo"), join(thread, "checkout.png"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
    } finally {
      registry.close();
    }
  });

  test("refuses a file outside that library, a path climbing out with `..`, or a link inside it", async () => {
    const { registry, records, thread, root } = await recordsFixture();
    try {
      const library = registry.library("demo");
      for (const path of [join(records, "stray.png"), join(thread, "..", "..", "stray.png"), join(thread, "linked.png"), join(root, "demo", "library", "t-0002", "checkout.png")]) {
        expect((await serve(library, path)).status, path).toBe(404);
      }
    } finally {
      registry.close();
    }
  });

  test("serves a thread's report by its id, as written, with what the overview read of it", async () => {
    const { registry, thread } = await recordsFixture();
    try {
      const response = await reportResponse(registry.report("demo", "t-0002"), state);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const { report } = await response.json() as { report: ThreadReport };
      expect(report).toEqual({
        title: "Thread t-0002", verdict: "needs-decision", text: "Status: needs-decision\n\n## Summary\nPick one.\n\n| A | B |\n| - | - |\n| 1 | 2 |\n",
        captures: [{ path: join(thread, "checkout.png"), caption: "Checkout" }], deliverables: [],
      });
    } finally {
      registry.close();
    }
  });

  test("refuses a report outside the records folder, climbing out with `..`, behind a link, missing or for a thread it does not know", async () => {
    const { registry } = await recordsFixture();
    try {
      for (const [slug, id] of [["demo", "t-0003"], ["demo", "t-0004"], ["demo", "t-0005"], ["demo", "t-0006"], ["demo", "t-0099"], ["demo", "../t-0002"], ["other", "t-0002"]]) {
        const response = await reportResponse(registry.report(slug!, id!), state);
        expect(response.status, `${slug} ${id}`).toBe(404);
        expect(await response.text()).not.toContain("Not a report");
      }
    } finally {
      registry.close();
    }
  });
});
