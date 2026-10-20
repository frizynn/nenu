import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { OrgRun } from "./org-cli.ts";
import { looseWorkspaceIds, ProjectRegistry, type ProjectRegistryOptions } from "./projects.ts";
import type { AgentView, LiveEvent, WorkspaceView } from "./types.ts";

const roots: string[] = [];
const registries: ProjectRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Files only, no watcher: the default for tests that are not about the CLI or invalidation. */
function registryFor(root: string, options: ProjectRegistryOptions = {}): ProjectRegistry {
  const registry = new ProjectRegistry({ root, now: () => 1, run: null, watch: false, upstream: () => false, ...options });
  registries.push(registry);
  return registry;
}

function fixture(): string {
  const root = join(tmpdir(), `nenu-projects-${crypto.randomUUID()}`);
  roots.push(root);
  const project = join(root, "demo");
  mkdirSync(join(project, ".state"), { recursive: true });
  mkdirSync(join(project, "threads"), { recursive: true });
  writeFileSync(join(project, "PROJECT.md"), `+++\nname = "Demo Project"\ngoal = "Ship safely"\nrepos = [{ path = "/work/demo" }]\n+++\nprivate body`);
  writeFileSync(join(project, ".state", "project.json"), JSON.stringify({ status: "active" }));
  writeFileSync(join(project, ".state", "coordinator.json"), JSON.stringify({ session: "", workspace_id: "w1", tab_id: "t1", pane_id: "p1", cwd: "/work/demo" }));
  writeFileSync(join(project, "threads", "t-0001.toml"), `id = "t-0001"\ntitle = "Build UI"\nstatus = "open"\nworkspace_id = "w1"\ntab_id = "t2"\npane_id = "p2"\ncwd = "/work/demo/wt"\n`);
  return root;
}

function pane(overrides: Partial<AgentView>): AgentView {
  return {
    paneId: "p1", workspaceId: "w1", workspaceLabel: "Demo", workspaceNumber: 1,
    tabId: "t1", agent: "claude", status: "idle", cwd: "/work/demo", focused: false,
    ...overrides,
  };
}

describe("ProjectRegistry", () => {
  test("keeps registered projects visible without panes and isolates the primary session", () => {
    const registry = registryFor(fixture());
    const [project] = registry.list("default", true, []);
    expect(project?.slug).toBe("demo");
    expect(project?.coordinator).toBeUndefined();
    expect(project?.threads[0]?.paneId).toBeUndefined();
    expect(registry.list("named", false, [])).toEqual([]);
  });

  test("links exact live metadata and rejects a reused pane id with the wrong cwd", () => {
    const registry = registryFor(fixture());
    const live = registry.list("default", true, [pane({}), pane({ paneId: "p2", tabId: "t2", cwd: "/work/demo/wt" })])[0]!;
    expect(live.coordinator?.paneId).toBe("p1");
    expect(live.threads[0]?.paneId).toBe("p2");

    const reused = registry.list("default", true, [pane({ cwd: "/elsewhere" })])[0]!;
    expect(reused.coordinator).toBeUndefined();
  });

  test("malformed metadata fails soft", () => {
    const root = fixture();
    writeFileSync(join(root, "demo", "threads", "t-0002.toml"), "bad = [");
    expect(() => registryFor(root).list("default", true, [])).not.toThrow();
  });

  test("does not follow registry metadata symlinks", () => {
    const root = fixture();
    const outside = join(tmpdir(), `nenu-outside-${crypto.randomUUID()}.md`);
    roots.push(outside);
    writeFileSync(outside, `+++\nname = "Leaked"\n+++\n`);
    rmSync(join(root, "demo", "PROJECT.md"));
    symlinkSync(outside, join(root, "demo", "PROJECT.md"));
    expect(registryFor(root).list("default", true, [])).toEqual([]);
  });
});

const overviewThread = (overrides: Record<string, unknown>) => ({
  id: "t-0001", title: "Build UI", parent_id: "root", role: "worker", can_spawn: false, status: "open",
  kind: "worktree", group: "working", group_label: "Working", rank: 3, note: "working",
  agent: "codex", branch: "", workspace_id: "w1", tab_id: "t2", pane_id: "p2", cwd: "/work/demo/wt",
  updated: "", has_report: false, report_unacked: false, auto_fix_ci: false, auto_merge: false, pr: null,
  ...overrides,
});

function overviewRun(threads: unknown[], calls: string[][] = [], project: Record<string, unknown> = {}): OrgRun {
  return async (argv) => {
    calls.push(argv);
    return { code: 0, stdout: JSON.stringify({ schema_version: 1, projects: [{ slug: "demo", name: "Demo (json)", goal: "", status: "active", dir: "/x", counts: {}, icon: "", tone: "", threads, ...project }] }), stderr: "" };
  };
}

describe("ProjectRegistry: Organizations fields", () => {
  test("the file fallback reads PR, group, branch, tree and report fields but never numbers", () => {
    const root = fixture();
    writeFileSync(join(root, "demo", "threads", "t-0002.toml"), [
      `id = "t-0002"`, `title = "Fix CI"`, `status = "open"`, `parent_id = "t-0003"`, `role = "worker"`,
      `branch = "hp/fix-ci"`, `last_group = "ready-for-review"`, `report_hash = "abc"`, `acked_report_hash = ""`,
      `pr = "https://github.com/acme/demo/pull/42"`, `pr_state = "OPEN"`, `pr_review = "APPROVED"`,
    ].join("\n"));
    writeFileSync(join(root, "demo", "threads", "t-0003.toml"), `id = "t-0003"\ntitle = "Lead"\nstatus = "open"\nrole = "coordinator"\n`);

    const project = registryFor(root).list("default", true, [])[0]!;
    expect(project).toMatchObject({ source: "files", prActions: false });
    const thread = project.threads.find((candidate) => candidate.id === "t-0002")!;
    expect(thread).toMatchObject({
      parentId: "t-0003", role: "worker", branch: "hp/fix-ci", group: "ready-for-review", depth: 2, reportUnacked: true,
      pr: { url: "https://github.com/acme/demo/pull/42", number: 42, state: "open", review: "approved" },
    });
    expect(thread.pr).not.toHaveProperty("checks");
    expect(thread.pr).not.toHaveProperty("diff");
    expect(thread).not.toHaveProperty("autoMerge");
    expect(project.threads.find((candidate) => candidate.id === "t-0003")).toMatchObject({ role: "coordinator", depth: 1, reportUnacked: false });
  });

  test("a coordinator still running open nodes is refused a close, with the count, before the CLI runs", () => {
    const root = fixture();
    writeFileSync(join(root, "demo", "threads", "t-0003.toml"), `id = "t-0003"\ntitle = "Lead"\nstatus = "open"\nrole = "coordinator"\n`);
    writeFileSync(join(root, "demo", "threads", "t-0004.toml"), `id = "t-0004"\ntitle = "Step"\nstatus = "open"\nparent_id = "t-0003"\n`);
    writeFileSync(join(root, "demo", "threads", "t-0005.toml"), `id = "t-0005"\ntitle = "Done step"\nstatus = "resolved"\nparent_id = "t-0003"\n`);
    const registry = registryFor(root);
    registry.list("default", true, []);
    expect(registry.closeRefusal("demo", "t-0003")).toBe("Lead still has 1 open under it; close those first.");
    expect(registry.closeRefusal("demo", "t-0004")).toBeUndefined();
    // What the registry does not know, Organizations decides.
    expect(registry.closeRefusal("demo", "t-9999")).toBeUndefined();
    expect(registry.closeRefusal("other", "t-0003")).toBeUndefined();
  });

  test("a resolved thread's never-read PR is left out instead of labelled open", () => {
    const root = fixture();
    writeFileSync(join(root, "demo", "threads", "t-0002.toml"), `id = "t-0002"\ntitle = "Old"\nstatus = "resolved"\npr = "https://github.com/acme/demo/pull/7"\n`);
    const thread = registryFor(root).list("default", true, [])[0]!.threads.find((candidate) => candidate.id === "t-0002")!;
    expect(thread.group).toBe("resolved");
    expect(thread.pr).toBeUndefined();
  });

  test("with the --json contract, numbers, blocker and automation flags come from Organizations", async () => {
    const live: LiveEvent[] = [];
    const registry = registryFor(fixture(), {
      run: overviewRun([
        overviewThread({}),
        overviewThread({
          id: "t-0002", parent_id: "t-0001", group: "ready-for-review", group_label: "Ready for review", note: "done",
          branch: "hp/fix-ci", pane_id: "", report_unacked: true, auto_merge: true,
          pr: { url: "https://github.com/acme/demo/pull/42", state: "OPEN", review: "APPROVED", checks: { passed: 5, pending: 0, failed: 1 }, additions: 120, deletions: 8, failing: ["lint"], comment_count: 2, draft: false, mergeable: "MERGEABLE", merge_blocker: "1 check(s) failed" },
        }),
      ]),
      live: { publish: (event) => live.push(event) },
    });
    expect(registry.list("default", true, [])[0]?.source).toBe("files");

    await registry.refresh();
    expect(live).toEqual([{ session: "default", topic: "org" }]);
    const project = registry.list("default", true, [pane({}), pane({ paneId: "p2", tabId: "t2", cwd: "/work/demo/wt" })])[0]!;
    expect(project).toMatchObject({ name: "Demo (json)", source: "json", prActions: true, coordinator: { paneId: "p1" }, workspaceIds: ["w1"] });
    expect(project.threads[0]).toMatchObject({ paneId: "p2", group: "working", note: "working", autoMerge: false, autoFixCi: false, depth: 1 });
    expect(project.threads[1]).toMatchObject({
      depth: 2, reportUnacked: true, groupLabel: "Ready for review", autoMerge: true,
      pr: { number: 42, state: "open", review: "approved", checks: { passed: 5, pending: 0, failed: 1, failing: ["lint"] }, diff: { additions: 120, deletions: 8 }, commentCount: 2, mergeBlocker: "1 check(s) failed" },
    });

    await registry.refresh();
    expect(live).toHaveLength(1);
  });

  test("a thread's one PR action is the first Nenu knows of the PR's actions, or of the thread's own without a PR", async () => {
    const pr = (number: number, actions?: string[]) => ({
      url: `https://github.com/acme/demo/pull/${number}`, state: "OPEN", review: "", checks: { passed: 1, pending: 0, failed: 0 }, additions: 1, deletions: 1,
      failing: [], comment_count: 0, draft: false, mergeable: "MERGEABLE", merge_blocker: null, ...(actions ? { actions } : {}),
    });
    const registry = registryFor(fixture(), { run: overviewRun([
      overviewThread({ id: "t-0001", pr: pr(1, ["resolve-conflicts", "fix-ci", "address-comments"]) }),
      // A value from a newer Organizations is skipped, not shown.
      overviewThread({ id: "t-0002", pr: pr(2, ["rebase-later", "merge"]) }),
      overviewThread({ id: "t-0003", actions: ["create-pr"] }),
      // A PR that calls for nothing offers nothing, whatever the thread's own list says.
      overviewThread({ id: "t-0004", pr: pr(4, []), actions: ["create-pr"] }),
      // An Organizations that predates actions: no field, so the client keeps today's Merge.
      overviewThread({ id: "t-0005", pr: pr(5) }),
      overviewThread({ id: "t-0006", actions: ["merge", 7] }),
      // Organizations orders them; Nenu never reorders, so Merge leads only where Organizations puts it.
      overviewThread({ id: "t-0007", pr: pr(7, ["merge", "address-comments"]) }),
      overviewThread({ id: "t-0008", pr: pr(8, ["address-comments", "merge"]) }),
    ]) });
    await registry.refresh();
    const threads = registry.list("default", true, [])[0]!.threads;
    expect(threads.map((thread) => [thread.id, thread.prAction ?? null])).toEqual([
      ["t-0001", "resolve-conflicts"], ["t-0002", "merge"], ["t-0003", "create-pr"], ["t-0004", null], ["t-0005", null], ["t-0006", null], ["t-0007", "merge"], ["t-0008", "address-comments"],
    ]);
    expect(threads[4]).not.toHaveProperty("prAction");
  });

  test("an agent's own Waiting for you report reaches the client as selfWaiting, from --json and from the files", async () => {
    const root = fixture();
    writeFileSync(join(root, "demo", "threads", "t-0002.toml"), `id = "t-0002"\ntitle = "Copy"\nstatus = "open"\nlast_group = "waiting-on-you"\nactivity = "Waiting for you"\n`);
    const registry = registryFor(root, { run: overviewRun([
      overviewThread({ group: "waiting-on-you", note: "idle", activity: "Waiting for you" }),
      overviewThread({ id: "t-0002", group: "waiting-on-you", note: "blocked", activity: "Fixing the build" }),
    ]) });
    const files = registry.list("default", true, [])[0]!.threads;
    expect(files.find((thread) => thread.id === "t-0002")).toMatchObject({ group: "waiting-on-you", selfWaiting: true });
    expect(files.find((thread) => thread.id === "t-0001")).not.toHaveProperty("selfWaiting");

    await registry.refresh();
    const [waiting, dialog] = registry.list("default", true, [])[0]!.threads;
    expect(waiting).toMatchObject({ group: "waiting-on-you", note: "idle", selfWaiting: true });
    // Any other activity is the agent's own progress text, not a reason to wait.
    expect(dialog).not.toHaveProperty("selfWaiting");
  });

  test("a thread kept open as a conversation reaches the client as one, from --json and from the files", async () => {
    const root = fixture();
    writeFileSync(join(root, "demo", "threads", "t-0002.toml"), `id = "t-0002"\ntitle = "Charla"\nstatus = "open"\nkeep_open = true\n`);
    const registry = registryFor(root, { run: overviewRun([
      overviewThread({ keep_open: true }),
      overviewThread({ id: "t-0002", keep_open: false }),
    ]) });
    const files = registry.list("default", true, [])[0]!.threads;
    expect(files.find((thread) => thread.id === "t-0002")).toMatchObject({ conversation: true });
    expect(files.find((thread) => thread.id === "t-0001")).not.toHaveProperty("conversation");

    await registry.refresh();
    const [talk, worker] = registry.list("default", true, [])[0]!.threads;
    expect(talk).toMatchObject({ conversation: true });
    expect(worker).not.toHaveProperty("conversation");
  });

  test("an unread PR under --json shows no numbers, and a contract without PR actions hides them", async () => {
    const { auto_fix_ci: _fix, auto_merge: _merge, ...withoutFlags } = overviewThread({
      pr: { url: "https://github.com/acme/demo/pull/9", state: "", review: "", checks: null, additions: null, deletions: null, failing: [], comment_count: null, draft: null, mergeable: null, merge_blocker: "the ticker has not read this pull request yet" },
    });
    const registry = registryFor(fixture(), { run: overviewRun([withoutFlags]) });
    await registry.refresh();
    const project = registry.list("default", true, [])[0]!;
    expect(project.prActions).toBe(false);
    expect(project.threads[0]).not.toHaveProperty("autoMerge");
    expect(project.threads[0]!.pr).toEqual({ url: "https://github.com/acme/demo/pull/9", number: 9, state: "open", mergeBlocker: "the ticker has not read this pull request yet" });
  });

  test("a diff Organizations counts as no lines is not carried, as its own popup draws none", async () => {
    // Measured 2026-10-13: a summary the ticker stored before it counted lines reads back as 0/0;
    // GitHub has #1618 at +755 −629.
    const registry = registryFor(fixture(), {
      run: overviewRun([overviewThread({
        status: "resolved", group: "resolved",
        pr: { url: "https://github.com/acme/demo/pull/1618", state: "OPEN", review: "", checks: { passed: 0, pending: 0, failed: 0 }, additions: 0, deletions: 0, failing: [], comment_count: 0, draft: false, mergeable: "", merge_blocker: "the thread is not open" },
      })]),
    });
    await registry.refresh();
    expect(registry.list("default", true, [])[0]!.threads[0]!.pr).not.toHaveProperty("diff");
  });

  test("a project's picked glyph and tone reach the client from the files at once, then from --json", async () => {
    const root = fixture();
    writeFileSync(join(root, "demo", "PROJECT.md"), `+++\nname = "Demo Project"\nicon = "flag"\ntone = "red"\nrepos = [{ path = "/work/demo" }]\n+++\n`);
    // The two sources disagree here only to tell them apart; Organizations prints what PROJECT.md holds.
    const registry = registryFor(root, { run: overviewRun([overviewThread({})], [], { icon: "bolt", tone: "teal" }) });
    expect(registry.list("default", true, [])[0]).toMatchObject({ source: "files", icon: "flag", tone: "red" });

    await registry.refresh();
    expect(registry.list("default", true, [])[0]).toMatchObject({ source: "json", icon: "bolt", tone: "teal" });
  });

  test("a project that picked nothing carries neither field, from the files or from --json", async () => {
    const registry = registryFor(fixture(), { run: overviewRun([overviewThread({})]) });
    for (const source of ["files", "json"] as const) {
      if (source === "json") await registry.refresh();
      const project = registry.list("default", true, [])[0]!;
      expect(project.source).toBe(source);
      expect(project).not.toHaveProperty("icon");
      expect(project).not.toHaveProperty("tone");
    }
  });

  test("a thread's verdict reaches the snapshot; its summary, captures and deliverables are read apart, from --json only", async () => {
    const root = fixture();
    const library = join(root, "demo", "library", "t-0002");
    const registry = registryFor(root, { run: overviewRun([
      overviewThread({}),
      overviewThread({
        id: "t-0002", verdict: "done", summary: "Checkout works at 390 px.",
        captures: [{ path: join(library, "checkout.png"), caption: "Checkout" }], deliverables: [{ path: join(library, "report.html"), kind: "html" }],
      }),
      overviewThread({ id: "t-0003", verdict: "blocked" }),
    ]) });
    // The files carry none of it.
    expect(registry.list("default", true, [])[0]!.threads.some((thread) => "verdict" in thread)).toBe(false);
    expect(registry.summaries("demo")).toBeNull();

    await registry.refresh();
    const threads = registry.list("default", true, [])[0]!.threads;
    expect(threads.map((thread) => thread.verdict ?? null)).toEqual([null, "done", "blocked"]);
    expect(threads[0]).not.toHaveProperty("verdict");
    expect(JSON.stringify(threads)).not.toContain("Checkout");
    expect(registry.summaries("demo")).toEqual({ status: null, usage: null, coordinator: null, threads: [{
      id: "t-0002", summary: "Checkout works at 390 px.",
      captures: [{ path: join(library, "checkout.png"), caption: "Checkout" }], deliverables: [{ path: join(library, "report.html"), kind: "html" }],
    }] });
    expect(registry.summaries("other")).toBeNull();
  });

  test("a report in plain words, and whether Organizations would write one, come with the summaries and never the snapshot", async () => {
    const root = fixture();
    const registry = registryFor(root, { run: overviewRun([
      overviewThread({ summary: "PR #7 green.", plain_summary: { text: "Checkout is done.", current: true, error: "", at: "2026-10-19T10:00:00Z" }, actions: ["explain"] }),
      // Only the action: the thread has a report nobody asked about yet.
      overviewThread({ id: "t-0002", actions: ["explain"] }),
    ]) });
    await registry.refresh();
    expect(JSON.stringify(registry.list("default", true, [])[0]!.threads)).not.toContain("Checkout is done.");
    expect(registry.summaries("demo")!.threads).toEqual([
      { id: "t-0001", summary: "PR #7 green.", plain: { text: "Checkout is done.", current: true }, explainable: true, captures: [], deliverables: [] },
      { id: "t-0002", explainable: true, captures: [], deliverables: [] },
    ]);
  });

  test("a coordinator's STATUS.md reaches the snapshot only as its stamp; its text is read apart, with the summaries", async () => {
    const root = fixture();
    const file = (text: string, updated = "2026-10-16T12:00:00Z") => ({ path: join(root, "STATUS.md"), text, updated });
    const registry = registryFor(root, { run: overviewRun([
      overviewThread({}),
      overviewThread({ id: "t-0002", role: "coordinator", status_file: file("# Status\n- [working] t-0003 Envíos", "2026-10-16T11:00:00Z") }),
    ], [], { status_file: file("# Status\nObjective: ship the checkout") }) });
    expect(registry.list("default", true, [])[0]).not.toHaveProperty("statusUpdated");

    await registry.refresh();
    const project = registry.list("default", true, [])[0]!;
    expect(project.statusUpdated).toBe("2026-10-16T12:00:00Z");
    expect(project.threads.map((thread) => thread.statusUpdated ?? null)).toEqual([null, "2026-10-16T11:00:00Z"]);
    expect(JSON.stringify(project)).not.toContain("Objective");
    expect(JSON.stringify(project)).not.toContain("Envíos");
    expect(registry.summaries("demo")).toEqual({
      status: { text: "# Status\nObjective: ship the checkout", updated: "2026-10-16T12:00:00Z" },
      threads: [{ id: "t-0002", captures: [], deliverables: [], status: { text: "# Status\n- [working] t-0003 Envíos", updated: "2026-10-16T11:00:00Z" } }],
      usage: null, coordinator: null,
    });
  });

  test("an edit to a coordinator's STATUS.md re-reads the overview, as an edit to Organizations' own files does", async () => {
    const root = fixture();
    const path = join(root, "STATUS.md");
    writeFileSync(path, "# Status\n");
    let now = 1;
    const calls: string[][] = [];
    const registry = registryFor(root, { now: () => now, run: overviewRun([overviewThread({})], calls, { status_file: { path, text: "# Status", updated: "2026-10-16T12:00:00Z" } }) });
    // Each refresh also asks for the asks; this counts the overviews.
    const overviews = () => calls.filter((argv) => argv[0] === "overview").length;
    await registry.refresh();
    // The path is known only once the overview names it; the next read settles on it.
    now += 10_000;
    registry.list("default", true, []);
    await Bun.sleep(0);
    const before = overviews();

    now += 10_000;
    registry.list("default", true, []);
    await Bun.sleep(0);
    expect(overviews()).toBe(before);

    utimesSync(path, new Date(), new Date(Date.now() + 5_000));
    now += 10_000;
    registry.list("default", true, []);
    await Bun.sleep(0);
    expect(overviews()).toBe(before + 1);
  });

  test("a new token reading (Organizations' .state/usage.json) re-reads the overview", async () => {
    const root = fixture();
    const usage = join(root, "demo", ".state", "usage.json");
    writeFileSync(usage, "{}");
    let now = 1;
    const calls: string[][] = [];
    const registry = registryFor(root, { now: () => now, run: overviewRun([overviewThread({})], calls) });
    const overviews = () => calls.filter((argv) => argv[0] === "overview").length;
    await registry.refresh();
    const before = overviews();
    now += 10_000;
    registry.list("default", true, []);
    await Bun.sleep(0);
    expect(overviews()).toBe(before);

    writeFileSync(usage, '{"nodes":{}}');
    now += 10_000;
    registry.list("default", true, []);
    await Bun.sleep(0);
    expect(overviews()).toBe(before + 1);
  });

  test("a project's library is its own folder's, and only for a project the registry lists", async () => {
    const root = fixture();
    const registry = registryFor(root);
    registry.list("default", true, []);
    expect(registry.library("demo")).toBe(join(realpathSync(root), "demo", "library"));
    for (const slug of ["other", "../demo", "", "Demo"]) expect(registry.library(slug)).toBeUndefined();
  });

  test("a project's records folder comes from Organizations: its library and reports are read there, even outside the projects root", async () => {
    const root = fixture();
    const records = join(tmpdir(), `nenu-records-${crypto.randomUUID()}`);
    const report = join(records, "threads", "t-0002.md");
    const registry = registryFor(root, { run: overviewRun([
      overviewThread({ library: join(records, "library", "t-0001") }),
      overviewThread({ id: "t-0002", title: "Checkout", verdict: "needs-decision", report, library: join(records, "library", "t-0002") }),
    ]) });
    // The files name no records folder: the project's own, and no report.
    registry.list("default", true, []);
    expect(registry.library("demo")).toBe(join(realpathSync(root), "demo", "library"));
    expect(registry.report("demo", "t-0002")).toBeUndefined();

    await registry.refresh();
    expect(registry.library("demo")).toBe(join(records, "library"));
    expect(registry.report("demo", "t-0002")).toMatchObject({ path: report, records, title: "Checkout", verdict: "needs-decision" });
    for (const [slug, id] of [["demo", "t-0001"], ["demo", "t-0099"], ["demo", "../t-0002"], ["demo", "root"], ["other", "t-0002"]]) {
      expect(registry.report(slug!, id!), `${slug} ${id}`).toBeUndefined();
    }
    // The paths stay out of the snapshot.
    expect(JSON.stringify(registry.list("default", true, []))).not.toContain(records);
  });

  test("a records folder Organizations prints wins, and one that predates `library` keeps the project's own folder", async () => {
    const root = fixture();
    const printed = registryFor(root, { run: overviewRun([overviewThread({ library: "/elsewhere/library/t-0001" })], [], { records: "/records/demo" }) });
    await printed.refresh();
    expect(printed.library("demo")).toBe("/records/demo/library");
    const old = registryFor(root, { run: overviewRun([overviewThread({})]) });
    await old.refresh();
    expect(old.library("demo")).toBe(join(realpathSync(root), "demo", "library"));
  });

  test("falls back to the files when the installed Organizations has no --json", async () => {
    const run: OrgRun = async () => ({ code: 2, stdout: "", stderr: "error: unexpected argument '--json'" });
    const registry = registryFor(fixture(), { run });
    await registry.refresh();
    expect(registry.list("default", true, [])[0]).toMatchObject({ name: "Demo Project", source: "files", prActions: false });
  });

  test("hides node actions while only upstream herdr-projects is installed, and announces the change", async () => {
    let upstream = true;
    const live: LiveEvent[] = [];
    const registry = registryFor(fixture(), { upstream: () => upstream, live: { publish: (event) => live.push(event) } });
    expect(registry.list("default", true, [])[0]!.nodeActions).toBe(false);
    upstream = false;
    await registry.refresh();
    expect(registry.list("default", true, [])[0]!.nodeActions).toBe(true);
    expect(live).toEqual([{ session: "default", topic: "org" }]);
  });

  test("offers Move once node move's help exits 0, and asks an Organizations without it again only after a while", async () => {
    let now = 1;
    let help = 2;
    const asked: string[][] = [];
    const run: OrgRun = async (argv) => {
      if (argv[1] === "move") {
        asked.push(argv);
        return { code: help, stdout: "", stderr: help ? "error: unrecognized subcommand 'move'" : "" };
      }
      return overviewRun([])(argv, { timeoutMs: 1 });
    };
    const registry = registryFor(fixture(), { run, now: () => now });
    await registry.refresh();
    expect(registry.list("default", true, [])[0]!.nodeMoves).toBe(false);
    help = 0;
    now += 60_000;
    await registry.refresh();
    expect(asked).toHaveLength(1);
    now += 10 * 60_000;
    await registry.refresh();
    expect(registry.list("default", true, [])[0]!.nodeMoves).toBe(true);
    await registry.refresh();
    expect(asked).toEqual([["node", "move", "--help"], ["node", "move", "--help"]]);
  });

  test("a node is movable only where Organizations' actions list `move`", async () => {
    const registry = registryFor(fixture(), { run: overviewRun([
      overviewThread({ id: "t-0002", actions: ["move"] }),
      overviewThread({ id: "t-0003", title: "Fixed", actions: ["create-pr"] }),
    ]) });
    await registry.refresh();
    const [movable, fixed] = registry.list("default", true, [])[0]!.threads;
    expect(movable).toMatchObject({ id: "t-0002", movable: true });
    expect(fixed).not.toHaveProperty("movable");
  });

  test("never asks upstream herdr-projects for node move", async () => {
    const calls: string[][] = [];
    const registry = registryFor(fixture(), { run: overviewRun([], calls), upstream: () => true });
    await registry.refresh();
    expect(registry.list("default", true, [])[0]!.nodeMoves).toBe(false);
    expect(calls.some((argv) => argv[1] === "move")).toBe(false);
  });

  test("a changed record is noticed by stat on the next read after the interval", async () => {
    const root = fixture();
    let now = 1;
    const calls: string[][] = [];
    const registry = registryFor(root, { now: () => now, run: overviewRun([overviewThread({})], calls) });
    registry.list("default", true, []);
    await registry.invalidate();
    const before = calls.length;

    now += 1_000;
    registry.list("default", true, []);
    expect(calls.length).toBe(before);

    utimesSync(join(root, "demo", "threads", "t-0001.toml"), new Date(), new Date(Date.now() + 5_000));
    now += 10_000;
    registry.list("default", true, []);
    await registry.invalidate();
    expect(calls.length).toBeGreaterThan(before);
  });

  test("a read of Organizations that failed is tried again on a later read, with no file changed", async () => {
    // Measured on 2026-10-17: a restart whose first `overview` failed served no asks until a file changed.
    const root = fixture();
    let now = 1;
    let down = true;
    const reads: string[] = [];
    const overview = overviewRun([overviewThread({})]);
    const run: OrgRun = async (argv, opts) => {
      if (argv.includes("--help")) return { code: 0, stdout: "", stderr: "" };
      reads.push(argv[0]!);
      // A timeout, as the runner reports one: Organizations did not answer in time.
      if (down) return { code: 124, stdout: "", stderr: "" };
      if (argv[0] === "asks") return { code: 0, stdout: JSON.stringify({ schema_version: 1, asks: [] }), stderr: "" };
      return overview(argv, opts);
    };
    const registry = registryFor(root, { now: () => now, run });
    registry.list("default", true, []);
    await registry.invalidate();
    expect(registry.asks()).toBeNull();
    expect(registry.list("default", true, [])[0]!.source).toBe("files");

    down = false;
    now += 60_000;
    registry.list("default", true, []);
    for (let i = 0; i < 50 && registry.asks() === null; i++) await Bun.sleep(2);
    expect(registry.asks()).toEqual({ asks: [], decisions: [], answers: true });
    expect(registry.list("default", true, [])[0]!.source).toBe("json");
  });

  test("a read that fails after a good one keeps what the good one showed", async () => {
    const root = fixture();
    let down = false;
    const overview = overviewRun([overviewThread({})]);
    const run: OrgRun = async (argv, opts) => {
      if (argv.includes("--help")) return { code: 0, stdout: "", stderr: "" };
      if (down) return { code: 124, stdout: "", stderr: "" };
      if (argv[0] === "asks") return { code: 0, stdout: JSON.stringify({ schema_version: 1, asks: [] }), stderr: "" };
      return overview(argv, opts);
    };
    const registry = registryFor(root, { run });
    await registry.refresh();
    down = true;
    await registry.refresh();
    expect(registry.list("default", true, [])[0]).toMatchObject({ source: "json", name: "Demo (json)" });
    expect(registry.asks()).toEqual({ asks: [], decisions: [], answers: true });
  });

  test("an Organizations without the contract is not asked again on every read", async () => {
    const root = fixture();
    let now = 1;
    const calls: string[][] = [];
    const run: OrgRun = async (argv) => {
      calls.push(argv);
      return { code: 2, stdout: "", stderr: "error: unexpected argument '--json' found" };
    };
    const registry = registryFor(root, { now: () => now, run });
    registry.list("default", true, []);
    await registry.invalidate();
    const before = calls.filter((argv) => argv[0] === "overview").length;
    now += 60_000;
    registry.list("default", true, []);
    await Bun.sleep(10);
    expect(calls.filter((argv) => argv[0] === "overview").length).toBe(before);
  });

  test("an invalidation during a refresh resolves only after a refresh that started after it", async () => {
    const gates: Array<() => void> = [];
    const run: OrgRun = async (argv) => {
      // The asks and the move probe a refresh reads beside the overview answer at once; the overview is what this holds.
      if (argv[0] === "asks" || argv[1] === "move") return { code: 2, stdout: "", stderr: "error: unrecognized subcommand 'asks'" };
      await new Promise<void>((resolve) => gates.push(resolve));
      return { code: 0, stdout: JSON.stringify({ schema_version: 1, projects: [] }), stderr: "" };
    };
    const registry = registryFor(fixture(), { run });
    const first = registry.invalidate();
    await Bun.sleep(0);
    let settled = false;
    const second = registry.invalidate().then(() => { settled = true; });
    gates[0]!();
    await first;
    await Bun.sleep(0);
    // The read that was running when the write landed may predate it; the caller waits for the next.
    expect(settled).toBe(false);
    expect(gates).toHaveLength(2);
    gates[1]!();
    await second;
    expect(settled).toBe(true);
  });

  test("while a write the person waits on runs, the record it writes is read at once, past the spawn throttle", async () => {
    const root = fixture();
    const live: LiveEvent[] = [];
    const registry = registryFor(root, { now: () => Date.now(), watch: true, run: overviewRun([overviewThread({})]), live: { publish: (event) => live.push(event) } });
    registry.list("default", true, []);
    await registry.invalidate();
    live.length = 0;
    // The watcher misses a change made the instant it is set up (FSEvents on macOS).
    await Bun.sleep(200);
    // `open` records the coordinator's new pane before its agent is up; the person is on the page.
    await registry.urgently(async () => {
      writeFileSync(join(root, "demo", ".state", "coordinator.json"), JSON.stringify({ session: "", workspace_id: "w1", tab_id: "t9", pane_id: "p9", cwd: "/work/demo" }));
      for (let i = 0; i < 40 && live.length === 0; i++) await Bun.sleep(50);
    });
    expect(live).toEqual([{ session: "default", topic: "org" }]);
    expect(registry.list("default", true, [pane({ paneId: "p9", tabId: "t9" })])[0]?.coordinator?.paneId).toBe("p9");
  });

  test("outside such a write, a watched change waits out the spawn throttle", async () => {
    const root = fixture();
    const live: LiveEvent[] = [];
    const registry = registryFor(root, { now: () => Date.now(), watch: true, run: overviewRun([overviewThread({})]), live: { publish: (event) => live.push(event) } });
    registry.list("default", true, []);
    await registry.invalidate();
    live.length = 0;
    writeFileSync(join(root, "demo", ".state", "coordinator.json"), JSON.stringify({ session: "", workspace_id: "w1", tab_id: "t9", pane_id: "p9", cwd: "/work/demo" }));
    await Bun.sleep(800);
    expect(live).toEqual([]);
  });

  test("fs.watch announces an org change without a snapshot read", async () => {
    const root = fixture();
    const live: LiveEvent[] = [];
    let skew = 0;
    const registry = registryFor(root, { now: () => Date.now() + skew, watch: true, live: { publish: (event) => live.push(event) } });
    registry.list("default", true, []);
    await registry.invalidate();
    // Past the spawn throttle so the watcher's refresh runs at once.
    skew = 60_000;
    writeFileSync(join(root, "demo", "threads", "t-0002.toml"), `id = "t-0002"\ntitle = "New"\nstatus = "open"\n`);
    for (let i = 0; i < 40 && live.length === 0; i++) await Bun.sleep(50);
    expect(live).toEqual([{ session: "default", topic: "org" }]);
  });
});

describe("looseWorkspaceIds", () => {
  test("lists the session's workspaces no project holds a live pane in", () => {
    const registry = registryFor(fixture());
    const projects = registry.list("default", true, [pane({})]);
    const workspace = (workspaceId: string): WorkspaceView => ({ workspaceId, number: 1, label: workspaceId, focused: false, activeTabId: "", tabCount: 1, paneCount: 1 });
    expect(looseWorkspaceIds([workspace("w1"), workspace("w9")], projects)).toEqual(["w9"]);
  });
});

describe("ProjectRegistry: asks", () => {
  /** An ask row as `asks --json` prints it (Organizations docs/json.md, Asks). */
  const askRow = (coordinator: { id: string; title: string }, state: string, text: string, extra: Record<string, unknown> = {}) => ({
    project: "demo", coordinator, line: 4, state, text, answer: "", links: [], confirmed: "", mismatch: "", ...extra,
  });
  const ROOT = { id: "root", title: "" };
  const CHECKOUT = { id: "t-0002", title: "Checkout" };
  const OLD = { id: "t-0003", title: "Old lead" };
  const status = (root: string, extra: Record<string, unknown>) => ({ path: join(root, "STATUS.md"), text: "# Status", updated: "2026-10-16T12:00:00Z", ...extra });

  /** Organizations with `asks`: the overview and the asks each answer their own command. */
  function asksRun(root: string, rows: unknown[] | null, calls: string[][] = []): OrgRun {
    const overview = overviewRun([
      overviewThread({}),
      overviewThread({ id: "t-0002", title: "Checkout", role: "coordinator", status_file: status(root, { needs_decision: ["Stock : list or cards"] }) }),
      overviewThread({ id: "t-0003", title: "Old lead", role: "coordinator", status: "resolved", group: "resolved", status_file: status(root, { needs_decision: ["Stale"] }) }),
    ], [], { status_file: status(root, { objective: "Ship it", needs_decision: ["Pilot : yes or no"] }) });
    return async (argv, opts) => {
      calls.push(argv);
      if (argv[0] !== "asks") return overview(argv, opts);
      return rows ? { code: 0, stdout: JSON.stringify({ schema_version: 1, asks: rows }), stderr: "" } : { code: 2, stdout: "", stderr: "error: unrecognized subcommand 'asks'" };
    };
  }

  test("each ask is placed as Organizations orders it, the decisions join it, and the snapshot carries only how many wait", async () => {
    const root = fixture();
    const calls: string[][] = [];
    const registry = registryFor(root, { run: asksRun(root, [
      askRow(ROOT, "needs-decision", "Pilot with batch 2"),
      askRow(ROOT, "done", "Ship the checkout", { confirmed: "in-progress", mismatch: "a linked PR is still open",
        links: [{ kind: "thread", text: "t-0002", target: "t-0002", thread: "t-0002", title: "Checkout", state: "ready-for-review", pr: "https://github.com/acme/demo/pull/12", pr_state: "open" }] }),
      askRow(OLD, "needs-decision", "Which bank"),
      askRow(CHECKOUT, "working", "Copy fix", { answer: "landing it" }),
      askRow(ROOT, "answered", "Is it fast?", { answer: "yes, measured" }),
      askRow(ROOT, "unknown", "a line with no bullet"),
    ], calls) });
    expect(registry.asks()).toBeNull();
    expect(registry.list("default", true, [])[0]).not.toHaveProperty("waitingAsks");

    await registry.refresh();
    expect(calls).toContainEqual(["asks", "--json"]);
    const asks = registry.asks()!;
    expect(asks.asks.map((ask) => [ask.coordinator.id, ask.group, ask.text])).toEqual([
      ["root", "waiting", "Pilot with batch 2"],
      ["root", "unclosed", "Ship the checkout"],
      // A resolved coordinator takes no answer: its decision waits on no one.
      ["t-0003", "progress", "Which bank"],
      ["t-0002", "progress", "Copy fix"],
      ["root", "done", "Is it fast?"],
      ["root", "other", "a line with no bullet"],
    ]);
    expect(asks.asks[1]!.links[0]).toEqual({ kind: "thread", text: "t-0002", target: "t-0002", thread: "t-0002", title: "Checkout", state: "ready-for-review", pr: "https://github.com/acme/demo/pull/12", prState: "open" });
    // An Organizations without decision rows: the status files' lines, as text with no line to answer on.
    expect(asks.decisions).toEqual([
      { project: "demo", coordinator: ROOT, text: "Pilot : yes or no", line: 0, links: [], group: "waiting" },
      { project: "demo", coordinator: CHECKOUT, text: "Stock : list or cards", line: 0, links: [], group: "waiting" },
    ]);
    const project = registry.list("default", true, [])[0]!;
    expect(project.waitingAsks).toBe(3);
    expect(JSON.stringify(project)).not.toContain("Pilot");
  });

  test("takes the decision rows where Organizations prints them: an answered one waits on no one, nor does a resolved coordinator's", async () => {
    const root = fixture();
    const overview = overviewRun([
      overviewThread({ id: "t-0002", title: "Checkout", role: "coordinator", status_file: status(root, { needs_decision: ["Stock : list or cards"] }) }),
      overviewThread({ id: "t-0003", title: "Old lead", role: "coordinator", status: "resolved", group: "resolved" }),
    ]);
    const decision = (coordinator: { id: string; title: string }, line: number, text: string, extra: Record<string, unknown> = {}) =>
      ({ project: "demo", coordinator, actions: ["answer"], line, text, links: [], ...extra });
    const run: OrgRun = async (argv, opts) => argv[0] !== "asks" ? overview(argv, opts) : { code: 0, stderr: "", stdout: JSON.stringify({ schema_version: 1, asks: [],
      decisions: [decision(CHECKOUT, 7, "Stock : list or cards"), decision(CHECKOUT, 8, "Coupons : now or later", { answered_at: "2026-10-17T10:00:00Z" }), decision(OLD, 3, "Stale")] }) };
    const registry = registryFor(root, { run });
    await registry.refresh();
    expect(registry.asks()!.decisions.map((row) => [row.text, row.line, row.group])).toEqual([
      ["Stock : list or cards", 7, "waiting"],
      ["Coupons : now or later", 8, "progress"],
    ]);
    expect(registry.list("default", true, [])[0]!.waitingAsks).toBe(1);
  });

  test("an answered ask waits on no one: it is in progress and leaves the count", async () => {
    const root = fixture();
    const overview = overviewRun([overviewThread({})]);
    const run: OrgRun = async (argv, opts) => argv[0] !== "asks" ? overview(argv, opts) : { code: 0, stderr: "", stdout: JSON.stringify({ schema_version: 1, asks: [
      askRow(ROOT, "needs-decision", "Pilot with batch 2", { actions: ["answer"], answered_at: "2026-10-17T10:00:00Z" }),
      askRow(ROOT, "needs-decision", "Which bank", { actions: ["answer"] }),
    ] }) };
    const registry = registryFor(root, { run });
    await registry.refresh();
    expect(registry.asks()!.asks.map((ask) => [ask.text, ask.group, ask.answeredAt ?? ""])).toEqual([
      ["Pilot with batch 2", "progress", "2026-10-17T10:00:00Z"],
      ["Which bank", "waiting", ""],
    ]);
    expect(registry.list("default", true, [])[0]!.waitingAsks).toBe(1);
  });

  test("a line that is only a parenthesis is neither an ask nor a decision, and waits on no one", async () => {
    const root = fixture();
    const overview = overviewRun([overviewThread({})], [], { status_file: status(root, { needs_decision: ["(nada por ahora; nada para confirmar)", "Pilot : yes or no"] }) });
    const run: OrgRun = async (argv, opts) => argv[0] !== "asks" ? overview(argv, opts) : {
      code: 0, stderr: "", stdout: JSON.stringify({ schema_version: 1, asks: [askRow(ROOT, "unknown", "(nothing for now)"), askRow(ROOT, "needs-decision", "Pilot with batch 2")] }),
    };
    const registry = registryFor(root, { run });
    await registry.refresh();
    const asks = registry.asks()!;
    expect(asks.asks.map((ask) => ask.text)).toEqual(["Pilot with batch 2"]);
    expect(asks.decisions.map((decision) => decision.text)).toEqual(["Pilot : yes or no"]);
    expect(registry.list("default", true, [])[0]!.waitingAsks).toBe(2);
  });

  test("says whether this Organizations can answer an ask, by `asks answer --help`", async () => {
    const root = fixture();
    let help = 2;
    const overview = overviewRun([]);
    const run: OrgRun = async (argv, opts) => {
      if (argv[0] === "asks" && argv[1] === "answer") return { code: help, stdout: "", stderr: "" };
      if (argv[0] === "asks") return { code: 0, stdout: JSON.stringify({ schema_version: 1, asks: [] }), stderr: "" };
      return overview(argv, opts);
    };
    let now = 1;
    const registry = registryFor(root, { run, now: () => now });
    await registry.refresh();
    expect(registry.asks()!.answers).toBe(false);
    help = 0;
    now += 11 * 60_000;
    await registry.refresh();
    expect(registry.asks()!.answers).toBe(true);
  });

  test("an Organizations without `asks` lists none, and the snapshot is as it was", async () => {
    const root = fixture();
    const registry = registryFor(root, { run: asksRun(root, null) });
    await registry.refresh();
    expect(registry.asks()).toBeNull();
    expect(registry.list("default", true, [])[0]).not.toHaveProperty("waitingAsks");
  });

  test("a failed read of the asks keeps the last one, so the list does not vanish for a refresh", async () => {
    const root = fixture();
    let fail = false;
    const working = asksRun(root, [askRow(ROOT, "needs-decision", "Pilot with batch 2")]);
    const registry = registryFor(root, { run: async (argv, opts) => argv[0] === "asks" && fail ? { code: 124, stdout: "", stderr: "" } : working(argv, opts) });
    await registry.refresh();
    fail = true;
    await registry.refresh();
    expect(registry.asks()?.asks.map((ask) => ask.text)).toEqual(["Pilot with batch 2"]);
    expect(registry.list("default", true, [])[0]!.waitingAsks).toBe(3);
  });

  test("asks are read only with the overview: a binary that fails it falls back to the files, asks and all", async () => {
    const root = fixture();
    const registry = registryFor(root, { run: async (argv) => argv[0] === "asks"
      ? { code: 0, stdout: JSON.stringify({ schema_version: 1, asks: [askRow(ROOT, "open", "Docs")] }), stderr: "" }
      : { code: 1, stdout: "", stderr: "boom" } });
    await registry.refresh();
    expect(registry.list("default", true, [])[0]!.source).toBe("files");
    expect(registry.asks()).toBeNull();
  });

  test("a STATUS.md's objective and decisions, the coordinators' token use and the project coordinator's agent come with the summaries", async () => {
    const root = fixture();
    const usage = { input: 10, output: 20, cache_read: 30, cache_write: 40, context: 412_000, peak_context: 967_000, compactions: 3, updated: "2026-10-16T11:00:00Z", over_cap: ["context_warn"] };
    const registry = registryFor(root, { run: overviewRun([
      overviewThread({}),
      overviewThread({ id: "t-0002", role: "coordinator", usage: { ...usage, over_cap: [] }, status_file: status(root, {
        objective: "Checkout", asks: [{ line: 4, state: "working", text: "Copy fix" }], needs_decision: ["Stock"],
      }) }),
      overviewThread({ id: "t-0003", usage: { ...usage, context: "full" } }),
    ], [], { usage, coordinator: { pane_id: "w1:p1", agent: "claude", model: "opus", state: "idle" }, status_file: status(root, { objective: "  Ship it  " }) }) });
    await registry.refresh();
    const summaries = registry.summaries("demo")!;
    expect(summaries.status).toEqual({ text: "# Status", updated: "2026-10-16T12:00:00Z", objective: "Ship it" });
    // The snapshot carries only a stamp of each reading, so a page showing the numbers reads them again when it moves.
    const project = registry.list("default", true, [])[0]!;
    expect(project.usageStamp).toBe("2026-10-16T11:00:00Z|context_warn");
    expect(project.threads.map((thread) => thread.usageStamp ?? null)).toEqual([null, "2026-10-16T11:00:00Z|", null]);
    expect(JSON.stringify(project)).not.toContain("967000");
    expect(summaries.usage).toEqual({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40, context: 412_000, peakContext: 967_000, compactions: 3, updated: "2026-10-16T11:00:00Z", overCap: ["context_warn"] });
    expect(summaries.coordinator).toEqual({ agent: "claude", model: "opus", state: "idle" });
    // A state this Nenu does not know reads as none.
    const odd = registryFor(fixture(), { run: overviewRun([], [], { coordinator: { pane_id: "", agent: "codex", model: "", state: "dreaming" } }) });
    await odd.refresh();
    expect(odd.summaries("demo")!.coordinator).toEqual({ agent: "codex", model: "", state: "" });
    const checkout = summaries.threads.find((thread) => thread.id === "t-0002")!;
    // Its asks come from `asks --json`, with every other coordinator's.
    expect(checkout.status).toEqual({ text: "# Status", updated: "2026-10-16T12:00:00Z", objective: "Checkout", needsDecision: ["Stock"] });
    expect(checkout.usage?.overCap).toEqual([]);
    // A count that is not one drops the whole reading rather than showing half of it.
    expect(summaries.threads.find((thread) => thread.id === "t-0003")).toBeUndefined();
  });
});
