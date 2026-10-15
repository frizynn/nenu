import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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

  test("an invalidation during a refresh resolves only after a refresh that started after it", async () => {
    const gates: Array<() => void> = [];
    const run: OrgRun = async () => {
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
