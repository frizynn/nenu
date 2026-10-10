import { describe, expect, it } from "bun:test";

import {
  createProject,
  listTemplates,
  mergeThread,
  orgEnv,
  readOverview,
  resolveNode,
  setThreadFlags,
  startFromTemplate,
  type OrgRun,
} from "./org-cli.ts";

const templateRecord = {
  name: "review-worker",
  scope: "project",
  project: "nenu",
  description: "Review a change",
  role: "worker",
  can_spawn: true,
  harness: "claude",
  model: "sonnet",
  reasoning_effort: "high",
  permission_profile: "write",
  rules_chars: 40,
  memory_chars: 15,
  updated: "2026-09-30T10:00:00Z",
  dir: "/private/templates/review-worker",
};
const globalTemplateRecord = { ...templateRecord, name: "shared-review", scope: "global", project: null };

function fakeRun(result: { code: number; stdout: string; stderr: string }) {
  const calls: Array<{ argv: string[]; opts: Parameters<OrgRun>[1] }> = [];
  const run: OrgRun = async (argv, opts) => {
    calls.push({ argv, opts });
    return result;
  };
  return { run, calls };
}

describe("herdr-organizations CLI adapter", () => {
  it("lists valid templates with exact argv and drops invalid records", async () => {
    const { run, calls } = fakeRun({
      code: 0,
      stdout: JSON.stringify([templateRecord, globalTemplateRecord, { ...templateRecord, can_spawn: "yes" }]),
      stderr: "",
    });

    expect(await listTemplates(run, "nenu")).toEqual([{
      name: "review-worker",
      scope: "project",
      description: "Review a change",
      role: "worker",
      canSpawn: true,
      harness: "claude",
      model: "sonnet",
      reasoningEffort: "high",
      rulesChars: 40,
      memoryChars: 15,
      updated: "2026-09-30T10:00:00Z",
    }, {
      name: "shared-review",
      scope: "global",
      description: "Review a change",
      role: "worker",
      canSpawn: true,
      harness: "claude",
      model: "sonnet",
      reasoningEffort: "high",
      rulesChars: 40,
      memoryChars: 15,
      updated: "2026-09-30T10:00:00Z",
    }]);
    expect(calls).toEqual([{
      argv: ["template", "list", "--project", "nenu", "--json"],
      opts: { timeoutMs: 10_000 },
    }]);
  });

  it("returns an empty list when the installed CLI does not know templates", async () => {
    const { run, calls } = fakeRun({ code: 2, stdout: "", stderr: "unrecognized subcommand: template" });

    expect(await listTemplates(run, "nenu")).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("sends the task on stdin and passes the Herdr socket through the environment", async () => {
    const { run, calls } = fakeRun({
      code: 0,
      stdout: JSON.stringify({ id: "t-1234", parent_id: "root", role: "worker", template: "review-worker" }),
      stderr: "",
    });
    const task = "Review the accessibility changes.";

    expect(await startFromTemplate(run, "/tmp/herdr.sock", {
      project: "nenu",
      template: "review-worker",
      title: "Review accessibility",
      parent: "root",
      task,
    })).toEqual({ id: "t-1234", parentId: "root", role: "worker", template: "review-worker" });
    expect(calls).toEqual([{
      argv: ["node", "start", "nenu", "--template", "review-worker", "--title", "Review accessibility", "--parent", "root", "--task-file", "-"],
      opts: { stdin: task, env: { HERDR_SOCKET_PATH: "/tmp/herdr.sock" }, timeoutMs: 30_000 },
    }]);
  });

  it("rejects invalid input before running the CLI", async () => {
    const { run, calls } = fakeRun({ code: 0, stdout: "[]", stderr: "" });
    const valid = {
      project: "nenu",
      template: "review-worker",
      title: "Review accessibility",
      parent: "root",
      task: "Review the change.",
    };

    await expect(listTemplates(run, "bad..slug")).rejects.toThrow("Project must use lowercase");
    await expect(listTemplates(run, "Uppercase")).rejects.toThrow("Project must use lowercase");
    await expect(startFromTemplate(run, "/tmp/herdr.sock", { ...valid, template: "Review" })).rejects.toThrow("Template must use lowercase");
    await expect(startFromTemplate(run, "/tmp/herdr.sock", { ...valid, title: "First line\nSecond line" })).rejects.toThrow("Title cannot contain line breaks");
    await expect(startFromTemplate(run, "/tmp/herdr.sock", { ...valid, task: "  " })).rejects.toThrow("Task is required");
    await expect(resolveNode(run, "/tmp/herdr.sock", { project: "nenu", id: "t-1" })).rejects.toThrow("Node ID must look like t-1234");
    expect(calls).toEqual([]);
  });

  it("resolves a node with the close-view flag", async () => {
    const { run, calls } = fakeRun({ code: 0, stdout: "", stderr: "" });

    await resolveNode(run, "/tmp/herdr.sock", { project: "nenu", id: "t-1234" }, () => false);

    expect(calls).toEqual([{
      argv: ["node", "resolve", "nenu", "t-1234", "--close-view"],
      opts: { env: { HERDR_SOCKET_PATH: "/tmp/herdr.sock" }, timeoutMs: 30_000 },
    }]);
  });

  it("closes a thread through upstream herdr-projects, keeping its worktree", async () => {
    const { run, calls } = fakeRun({ code: 0, stdout: "", stderr: "" });

    await resolveNode(run, "/tmp/herdr.sock", { project: "awam", id: "t-0042" }, () => true);

    expect(calls.map((call) => call.argv)).toEqual([["thread", "resolve", "awam", "t-0042", "--keep-worktree"]]);
  });
});

const overviewThread = {
  id: "t-0002", title: "Fix CI", parent_id: "t-0001", role: "worker", can_spawn: false, status: "open",
  kind: "worktree", group: "ready-for-review", group_label: "Ready for review", rank: 1, note: "done",
  agent: "codex", branch: "hp/fix-ci", workspace_id: "w1", tab_id: "w1:t2", pane_id: "w1:p2",
  cwd: "/work/demo/wt", updated: "2026-10-10T00:00:00Z", has_report: true, report_unacked: true,
  auto_fix_ci: false, auto_merge: true,
  pr: {
    url: "https://github.com/acme/demo/pull/42", state: "OPEN", review: "APPROVED",
    checks: { passed: 5, pending: 0, failed: 1 }, additions: 120, deletions: 8, failing: ["lint"],
    comment_count: 2, draft: false, mergeable: "MERGEABLE", merge_blocker: "1 check(s) failed",
  },
};

describe("herdr-organizations --json contract", () => {
  it("reads overview with the bridge's projects root and keeps unknown fields out", async () => {
    const { run, calls } = fakeRun({
      code: 0,
      stdout: JSON.stringify({ schema_version: 1, projects: [{ slug: "demo", name: "Demo", goal: "", status: "active", dir: "/x", counts: {}, threads: [overviewThread] }] }),
      stderr: "",
    });

    const [project] = (await readOverview(run, "/root"))!;
    expect(calls).toEqual([{ argv: ["overview", "--json"], opts: { env: { HERDR_PROJECTS_ROOT: "/root" }, timeoutMs: 10_000 } }]);
    expect(project?.threads[0]).toMatchObject({ id: "t-0002", auto_merge: true, report_unacked: true, pr: { checks: { passed: 5, pending: 0, failed: 1 }, additions: 120, merge_blocker: "1 check(s) failed" } });
    expect(project?.threads[0]).not.toHaveProperty("kind");
  });

  it("treats a failing command, bad JSON or another schema version as no contract", async () => {
    for (const result of [
      { code: 2, stdout: "", stderr: "unexpected argument '--json'" },
      { code: 0, stdout: "not json", stderr: "" },
      { code: 0, stdout: JSON.stringify({ schema_version: 2, projects: [] }), stderr: "" },
    ]) {
      expect(await readOverview(fakeRun(result).run, "/root")).toBeUndefined();
    }
  });

  it("keeps an unread pull request's unknown numbers as null, never zero", async () => {
    const unread = { ...overviewThread, pr: { url: overviewThread.pr.url, state: "", review: "", checks: null, additions: null, deletions: null, failing: [], comment_count: null, draft: null, mergeable: null, merge_blocker: "the ticker has not read this pull request yet" } };
    const { run } = fakeRun({ code: 0, stdout: JSON.stringify({ schema_version: 1, projects: [{ slug: "demo", name: "Demo", goal: "", status: "active", threads: [unread] }] }), stderr: "" });

    const pr = (await readOverview(run, "/root"))![0]!.threads[0]!.pr!;
    expect(pr).toMatchObject({ checks: null, additions: null, deletions: null, comment_count: null });
  });
});

describe("herdr-organizations PR actions and project creation", () => {
  it("builds merge argv from validated values and checks the reply", async () => {
    const { run, calls } = fakeRun({ code: 0, stdout: JSON.stringify({ schema_version: 1, id: "t-0002", pr: "https://github.com/acme/demo/pull/42", merged: true }), stderr: "" });

    expect(await mergeThread(run, { project: "demo", id: "t-0002" })).toEqual({ id: "t-0002", pr: "https://github.com/acme/demo/pull/42" });
    expect(calls[0]!.argv).toEqual(["thread", "merge", "demo", "t-0002", "--method=squash", "--json"]);
    await expect(mergeThread(run, { project: "demo", id: "t-0002", method: "--admin" })).rejects.toThrow("Merge method must be");
    expect(calls).toHaveLength(1);
  });

  it("passes Organizations' refusal through as the error", async () => {
    const { run } = fakeRun({ code: 1, stdout: "", stderr: "error: refusing to merge: 1 check(s) failed" });

    await expect(mergeThread(run, { project: "demo", id: "t-0002" })).rejects.toThrow("refusing to merge: 1 check(s) failed");
  });

  it("sets only the named automation flags", async () => {
    const { run, calls } = fakeRun({ code: 0, stdout: JSON.stringify({ schema_version: 1, id: "t-0002", auto_fix_ci: true, auto_merge: false }), stderr: "" });

    expect(await setThreadFlags(run, { project: "demo", id: "t-0002", autoFixCi: true })).toEqual({ id: "t-0002", autoFixCi: true, autoMerge: false });
    expect(calls[0]!.argv).toEqual(["thread", "set", "demo", "t-0002", "--auto-fix-ci=on", "--json"]);
    await expect(setThreadFlags(run, { project: "demo", id: "t-0002" })).rejects.toThrow("at least one");
    await expect(setThreadFlags(run, { project: "demo", id: "t-0002", autoMerge: "on" })).rejects.toThrow("true or false");
    expect(calls).toHaveLength(1);
  });

  it("creates a project without letting the name or goal read as a flag", async () => {
    const { run, calls } = fakeRun({ code: 0, stdout: JSON.stringify({ schema_version: 1, project: { slug: "my-app", name: "--My App" }, next: "herdr-organizations open my-app" }), stderr: "" });

    expect(await createProject(run, { name: "--My App", goal: "-ship", repo: "/work/app" })).toEqual({ slug: "my-app", name: "--My App" });
    expect(calls[0]!.argv).toEqual(["new", "--goal=-ship", "--repo=/work/app", "--json", "--", "--My App"]);
    await expect(createProject(run, { name: "App", repo: "relative/path" })).rejects.toThrow("absolute local path");
    await expect(createProject(run, { name: "App", repo: "/srv/app@build-box" })).rejects.toThrow("absolute local path");
    await expect(createProject(run, { name: "" })).rejects.toThrow("Title is required");
  });

  it("never hands the CLI an agent pane's identity", () => {
    const env = orgEnv({ HOME: "/home/me", HERDR_PANE_ID: "w1:p1", HERDR_TAB_ID: "w1:t1", HERDR_WORKSPACE_ID: "w1", HERDR_SOCKET_PATH: "/s" }, "/bin", { HERDR_PROJECTS_ROOT: "/r" });
    expect(env).toEqual({ HOME: "/home/me", HERDR_SOCKET_PATH: "/s", PATH: "/bin", HERDR_PROJECTS_ROOT: "/r" });
  });
});
