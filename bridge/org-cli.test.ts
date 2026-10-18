import { describe, expect, it } from "bun:test";

import {
  answerAsk,
  coordinatorChoices,
  createProject,
  listProfiles,
  listRoutines,
  listTemplates,
  explainThread,
  mergeThread,
  moveNode,
  openProject,
  offers,
  OrgCliError,
  orgEnv,
  OrgValidationError,
  prAction,
  prCreate,
  readOverview,
  readProjectDetail,
  readRoutines,
  readStatus,
  readTasks,
  replaceCoordinator,
  resolveNode,
  setThreadFlags,
  startNode,
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

/** Organizations' `profile list --project <slug> --json` (docs/json.md, Profile choices). */
const CHOICES = {
  schema_version: 1,
  project: "acme",
  coordinator: {
    default_profile: "codex",
    last: { profile: "claude", harness: "claude", model: "claude-opus-5-5[1m]", reasoning_effort: "xhigh" },
    harnesses: [
      { harness: "claude", profile: "claude", default_model: "", efforts: ["low", "medium", "high", "xhigh", "max"] },
      { harness: "codex", profile: "codex", default_model: "gpt-5.5", efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] },
      { harness: "--yolo", profile: "x", default_model: "", efforts: [] },
    ],
    profiles: [
      { name: "claude", harness: "claude", model: "", reasoning_effort: "", description: "", builtin: true },
      { name: "codex", harness: "codex", model: "", reasoning_effort: "", description: "", builtin: true },
      { name: "deep", harness: "codex", model: "gpt-5.5", reasoning_effort: "high", description: "Hard debugging", builtin: false },
      { name: "-bad", harness: "codex", model: "", reasoning_effort: "", description: "", builtin: false },
    ],
  },
  thread: { default_profile: "claude", last: null, harnesses: [], profiles: [] },
};

/** Organizations that answers the choices document first and then `result` for the write. */
function choicesRun(result: { code: number; stdout: string; stderr: string } = { code: 0, stdout: "started claude as hp-acme\n", stderr: "" }) {
  const calls: Array<{ argv: string[]; opts: Parameters<OrgRun>[1] }> = [];
  const run: OrgRun = async (argv, opts) => {
    calls.push({ argv, opts });
    if (argv[0] === "profile") return { code: 0, stdout: JSON.stringify(CHOICES), stderr: "" };
    return result;
  };
  return { run, calls };
}

/** An Organizations that predates the choices document: `--json` is refused, the names still list. */
function olderRun() {
  const calls: string[][] = [];
  const run: OrgRun = async (argv) => {
    calls.push(argv);
    if (argv.includes("--json")) return { code: 2, stdout: "", stderr: "error: unexpected argument '--json' found" };
    if (argv[0] === "profile") return { code: 0, stdout: "claude\ncodex\n", stderr: "" };
    return { code: 0, stdout: "started codex as hp-acme\n", stderr: "" };
  };
  return { run, calls };
}

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

  it("starts a template with the task on stdin and the Herdr socket in the environment", async () => {
    const { run, calls } = fakeRun({ code: 0, stdout: JSON.stringify({ id: "t-1234", parent_id: "root", role: "worker" }), stderr: "" });
    const task = "Review the accessibility changes.";

    expect(await startNode(run, "/tmp/herdr.sock", {
      project: "nenu", template: "review-worker", title: "Review accessibility", parent: "root", task,
    }, () => false)).toEqual({ id: "t-1234", project: "nenu", title: "Review accessibility", parent: "root", role: "worker", profile: "", template: "review-worker" });
    expect(calls).toEqual([{
      argv: ["node", "start", "nenu", "--template=review-worker", "--parent=root", "--title=Review accessibility", "--task-file", "-"],
      opts: { stdin: task, env: { HERDR_SOCKET_PATH: "/tmp/herdr.sock" }, timeoutMs: 30_000 },
    }]);
  });

  it("starts a coordinator under another coordinator with the profile it names", async () => {
    const { run, calls } = fakeRun({ code: 0, stdout: JSON.stringify({ id: "t-0042", parent_id: "t-0010", role: "coordinator", profile: "codex" }), stderr: "" });

    expect(await startNode(run, "/tmp/herdr.sock", {
      project: "acme", title: "-Billing", parent: "t-0010", task: "Coordinate billing.", role: "coordinator", profile: "codex",
    }, () => false)).toMatchObject({ id: "t-0042", role: "coordinator", parent: "t-0010", profile: "codex" });
    expect(calls[0]!.argv).toEqual(["node", "start", "acme", "--role=coordinator", "--can-spawn", "--kind=tab", "--parent=t-0010", "--title=-Billing", "--profile=codex", "--task-file", "-"]);
  });

  it("moves a node under another parent and checks what Organizations says it did", async () => {
    const { run, calls } = fakeRun({ code: 0, stdout: JSON.stringify({ schema_version: 1, id: "t-0012", parent_id: "t-0010" }), stderr: "" });

    expect(await moveNode(run, "/tmp/herdr.sock", { project: "acme", id: "t-0012", parent: "t-0010" })).toEqual({ id: "t-0012", project: "acme", parent: "t-0010" });
    expect(calls).toEqual([{
      argv: ["node", "move", "acme", "t-0012", "--parent=t-0010", "--json"],
      opts: { env: { HERDR_SOCKET_PATH: "/tmp/herdr.sock" }, timeoutMs: 30_000 },
    }]);
    await expect(moveNode(fakeRun({ code: 0, stdout: JSON.stringify({ schema_version: 1, id: "t-0012", parent_id: "root" }), stderr: "" }).run, "/s", { project: "acme", id: "t-0012", parent: "t-0010" }))
      .rejects.toThrow("invalid move response");
    await expect(moveNode(fakeRun({ code: 1, stdout: "", stderr: "error: node `t-0012` is a worker and cannot spawn" }).run, "/s", { project: "acme", id: "t-0013", parent: "t-0012" }))
      .rejects.toThrow("cannot spawn");
  });

  it("refuses a move it can tell is wrong before running the CLI", async () => {
    const { run, calls } = fakeRun({ code: 0, stdout: "", stderr: "" });
    await expect(moveNode(run, "/s", { project: "acme", id: "t-0012", parent: "t-0012" })).rejects.toThrow("its own parent");
    await expect(moveNode(run, "/s", { project: "acme", id: "t-0012", parent: "--parent=root" })).rejects.toThrow("Node ID must look like t-1234");
    await expect(moveNode(run, "/s", { project: "../acme", id: "t-0012", parent: "root" })).rejects.toThrow("Project must use lowercase");
    await expect(moveNode(run, "/s", { project: "acme", id: "root", parent: "t-0010" })).rejects.toThrow("Node ID must look like t-1234");
    expect(calls).toEqual([]);
  });

  it("knows a command is there only when its help exits 0", async () => {
    const help = fakeRun({ code: 0, stdout: "Usage: herdr-organizations node move", stderr: "" });
    expect(await offers(help.run, ["node", "move"])).toBe(true);
    expect(help.calls[0]!.argv).toEqual(["node", "move", "--help"]);
    expect(await offers(fakeRun({ code: 2, stdout: "", stderr: "error: unrecognized subcommand 'answer'" }).run, ["asks", "answer"])).toBe(false);
    expect(await offers(async () => { throw new Error("spawn failed"); }, ["node", "move"])).toBe(false);
  });

  it("answers an ask with the person's words on stdin, and checks what Organizations says it did", async () => {
    const reply = { schema_version: 1, project: "awam", coordinator: "t-0002", line: 5, answered_at: "2026-10-17T10:00:00Z" };
    const { run, calls } = fakeRun({ code: 0, stdout: JSON.stringify(reply), stderr: "" });

    expect(await answerAsk(run, "/tmp/herdr.sock", { project: "awam", coordinator: "t-0002", line: 5, text: "  Prospectos primero  " }))
      .toEqual({ project: "awam", coordinator: "t-0002", line: 5, answeredAt: "2026-10-17T10:00:00Z" });
    expect(calls).toEqual([{
      argv: ["asks", "answer", "awam", "t-0002", "--line=5", "--text-file", "-", "--json"],
      opts: { stdin: "Prospectos primero", env: { HERDR_SOCKET_PATH: "/tmp/herdr.sock" }, timeoutMs: 30_000 },
    }]);
    await expect(answerAsk(fakeRun({ code: 0, stdout: JSON.stringify({ ...reply, line: 6 }), stderr: "" }).run, "/s", { project: "awam", coordinator: "t-0002", line: 5, text: "ok" }))
      .rejects.toThrow("invalid answer response");
    await expect(answerAsk(fakeRun({ code: 1, stdout: "", stderr: "error: line 5 is not an ask" }).run, "/s", { project: "awam", coordinator: "root", line: 5, text: "ok" }))
      .rejects.toThrow("line 5 is not an ask");
  });

  it("refuses an answer it can tell is wrong before running the CLI", async () => {
    const { run, calls } = fakeRun({ code: 0, stdout: "", stderr: "" });
    const valid = { project: "awam", coordinator: "root", line: 5, text: "yes" };
    await expect(answerAsk(run, "/s", { ...valid, text: "   " })).rejects.toThrow("Write an answer first");
    await expect(answerAsk(run, "/s", { ...valid, text: "one\ntwo" })).rejects.toThrow("one line");
    await expect(answerAsk(run, "/s", { ...valid, text: "x".repeat(2_001) })).rejects.toThrow("2,000 characters");
    await expect(answerAsk(run, "/s", { ...valid, line: 0 })).rejects.toThrow("line number");
    await expect(answerAsk(run, "/s", { ...valid, line: "5" })).rejects.toThrow("line number");
    await expect(answerAsk(run, "/s", { ...valid, coordinator: "--yes" })).rejects.toThrow("Node ID must look like t-1234");
    await expect(answerAsk(run, "/s", { ...valid, project: "../awam" })).rejects.toThrow("Project must use lowercase");
    expect(calls).toEqual([]);
  });

  it("starts a top-level thread through upstream herdr-projects and refuses what it cannot do", async () => {
    const { run, calls } = fakeRun({ code: 0, stdout: JSON.stringify({ id: "t-0007", kind: "tab", profile: "", agent: "claude", branch: "", pane_id: "w1:p3" }), stderr: "" });
    const thread = { project: "acme", title: "Hotfix", parent: "root", task: "Fix the login." };

    expect(await startNode(run, "/tmp/herdr.sock", thread, () => true)).toMatchObject({ id: "t-0007", role: "worker", parent: "root" });
    expect(calls[0]!.argv).toEqual(["thread", "start", "acme", "--title=Hotfix", "--task-file", "-"]);
    for (const refused of [{ role: "coordinator" }, { parent: "t-0001" }, { template: "review-worker" }]) {
      await expect(startNode(run, "/tmp/herdr.sock", { ...thread, ...refused }, () => true)).rejects.toThrow("need Herdr Organizations");
    }
    expect(calls).toHaveLength(1);
  });

  it("lists the profile names and none when the CLI cannot say", async () => {
    const { run, calls } = fakeRun({ code: 0, stdout: "claude\ncodex\n-bad\nsonnet.fast\n", stderr: "" });
    expect(await listProfiles(run)).toEqual(["claude", "codex", "sonnet.fast"]);
    expect(calls[0]).toEqual({ argv: ["profile", "list", "--names"], opts: { timeoutMs: 10_000 } });
    expect(await listProfiles(fakeRun({ code: 2, stdout: "", stderr: "unrecognized subcommand 'profile'" }).run)).toEqual([]);
  });

  it("opens a project's coordinator in the bridge's Herdr session", async () => {
    const { run, calls } = fakeRun({ code: 0, stdout: "started codex as hp-acme", stderr: "" });

    expect(await openProject(run, "/tmp/herdr.sock", { project: "acme" })).toEqual({ message: "started codex as hp-acme" });
    expect(calls).toEqual([{ argv: ["open", "acme"], opts: { env: { HERDR_SOCKET_PATH: "/tmp/herdr.sock" }, timeoutMs: 60_000 } }]);
    await expect(openProject(fakeRun({ code: 1, stdout: "", stderr: "error: `acme` is archived" }).run, "/s", { project: "acme" })).rejects.toThrow("is archived");
  });

  it("reads what a coordinator can start on, dropping what is not a name", async () => {
    const { run, calls } = choicesRun();

    expect(await coordinatorChoices(run, "acme")).toEqual({
      available: true,
      defaultProfile: "codex",
      last: { profile: "claude", harness: "claude", model: "claude-opus-5-5[1m]", reasoningEffort: "xhigh" },
      harnesses: [
        { harness: "claude", profile: "claude", defaultModel: "", efforts: ["low", "medium", "high", "xhigh", "max"] },
        { harness: "codex", profile: "codex", defaultModel: "gpt-5.5", efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] },
      ],
      profiles: [
        { name: "claude", harness: "claude", model: "", reasoningEffort: "", description: "", builtin: true },
        { name: "codex", harness: "codex", model: "", reasoningEffort: "", description: "", builtin: true },
        { name: "deep", harness: "codex", model: "gpt-5.5", reasoningEffort: "high", description: "Hard debugging", builtin: false },
      ],
    });
    expect(calls).toEqual([{ argv: ["profile", "list", "--project", "acme", "--json"], opts: { timeoutMs: 10_000 } }]);
    await expect(coordinatorChoices(run, "../acme")).rejects.toThrow("Project must use lowercase");
  });

  it("offers only the profile names when Organizations predates the choices document", async () => {
    const { run, calls } = olderRun();

    expect(await coordinatorChoices(run, "acme")).toEqual({
      available: false,
      defaultProfile: "",
      last: null,
      harnesses: [],
      profiles: ["claude", "codex"].map((name) => ({ name, harness: "", model: "", reasoningEffort: "", description: "", builtin: false })),
    });
    expect(calls).toEqual([["profile", "list", "--project", "acme", "--json"], ["profile", "list", "--names"]]);
  });

  it("opens the coordinator on the harness, model and effort the person chose", async () => {
    const { run, calls } = choicesRun();

    expect(await openProject(run, "/tmp/herdr.sock", { project: "acme", harness: "claude", model: "claude-opus-5-5[1m]", effort: "xhigh" }))
      .toEqual({ message: "started claude as hp-acme" });
    expect(calls.map((call) => call.argv)).toEqual([
      ["profile", "list", "--project", "acme", "--json"],
      ["open", "acme", "--harness=claude", "--model=claude-opus-5-5[1m]", "--reasoning-effort=xhigh"],
    ]);
    expect(calls[1]!.opts).toEqual({ env: { HERDR_SOCKET_PATH: "/tmp/herdr.sock" }, timeoutMs: 60_000 });
  });

  it("opens on a profile, with the effort the person changed", async () => {
    const { run, calls } = choicesRun();

    await openProject(run, "/s", { project: "acme", profile: "deep", model: "", effort: "max" });
    expect(calls[1]!.argv).toEqual(["open", "acme", "--profile=deep", "--reasoning-effort=max"]);
  });

  it("refuses a choice Organizations does not offer before anything starts", async () => {
    const { run, calls } = choicesRun();
    const open = (input: Record<string, unknown>) => openProject(run, "/s", { project: "acme", ...input });

    await expect(open({ harness: "gemini" })).rejects.toThrow("gemini is not a harness this project's coordinator can run.");
    await expect(open({ harness: "--yolo" })).rejects.toThrow("is not a harness this project's coordinator can run.");
    for (const model of ["a;b", "-x", "a b", "$(id)", "x".repeat(129)]) {
      await expect(open({ harness: "claude", model })).rejects.toThrow("Model must be one model name");
    }
    await expect(open({ harness: "claude", effort: "ultra" })).rejects.toThrow("Effort must be one of low, medium, high, xhigh, max for claude.");
    await expect(open({ harness: "claude", effort: 3 })).rejects.toThrow("Effort must be one of");
    await expect(open({ profile: "deep", harness: "codex" })).rejects.toThrow("Choose a profile or a harness, not both.");
    await expect(open({ profile: "nope", effort: "high" })).rejects.toThrow("nope is not a profile this project's coordinator can run.");
    await expect(open({ profile: "--yolo" })).rejects.toThrow("Profile must be a profile name");
    expect(calls.filter((call) => call.argv[0] !== "profile")).toEqual([]);
  });

  it("leaves the effort of a profile whose harness is not offered on its own to the profile", async () => {
    const calls: string[][] = [];
    const run: OrgRun = async (argv) => {
      calls.push(argv);
      const coordinator = { ...CHOICES.coordinator, harnesses: [CHOICES.coordinator.harnesses[0]] };
      return argv[0] === "profile" ? { code: 0, stdout: JSON.stringify({ ...CHOICES, coordinator }), stderr: "" } : { code: 0, stdout: "started codex as hp-acme\n", stderr: "" };
    };

    await openProject(run, "/s", { project: "acme", profile: "deep", model: "gpt-5.5-mini" });
    expect(calls.at(-1)).toEqual(["open", "acme", "--profile=deep", "--model=gpt-5.5-mini"]);
    await expect(openProject(run, "/s", { project: "acme", profile: "deep", effort: "high" }))
      .rejects.toThrow("Effort can be chosen only for a harness this project's coordinator can run.");
  });

  it("keeps the plain open when nothing was chosen, and says when Organizations cannot choose", async () => {
    const { run, calls } = olderRun();

    await openProject(run, "/s", { project: "acme" });
    await openProject(run, "/s", { project: "acme", profile: "codex" });
    expect(calls.filter((argv) => argv[0] === "open")).toEqual([["open", "acme"], ["open", "acme", "--profile=codex"]]);
    await expect(openProject(run, "/s", { project: "acme", harness: "claude" })).rejects.toThrow("This Herdr Organizations cannot choose the harness, model or effort");
    await expect(openProject(run, "/s", { project: "acme", profile: "claude", model: "opus" })).rejects.toThrow("This Herdr Organizations cannot choose the harness, model or effort");
    expect(calls.filter((argv) => argv[0] === "open")).toHaveLength(2);
  });

  it("replaces the coordinator on a harness, model and effort", async () => {
    const { run, calls } = choicesRun({ code: 0, stdout: "stopped 1 coordinator agent(s) and started a new one on claude\n", stderr: "" });

    await replaceCoordinator(run, "/s", { project: "acme", harness: "codex", model: "gpt-5.5", effort: "high" });
    expect(calls[1]!.argv).toEqual(["coordinator", "replace", "acme", "--harness=codex", "--model=gpt-5.5", "--reasoning-effort=high"]);
    await expect(replaceCoordinator(run, "/s", { project: "acme", model: "opus" })).rejects.toThrow("Choose the agent the new coordinator runs on.");
  });

  it("rejects invalid input before running the CLI", async () => {
    const { run, calls } = fakeRun({ code: 0, stdout: "[]", stderr: "" });
    const valid = { project: "nenu", title: "Review accessibility", parent: "root", task: "Review the change." };
    const start = (input: Record<string, unknown>) => startNode(run, "/tmp/herdr.sock", { ...valid, ...input }, () => false);

    await expect(listTemplates(run, "bad..slug")).rejects.toThrow("Project must use lowercase");
    await expect(listTemplates(run, "Uppercase")).rejects.toThrow("Project must use lowercase");
    await expect(start({ template: "Review" })).rejects.toThrow("Template must use lowercase");
    await expect(start({ title: "First line\nSecond line" })).rejects.toThrow("Title cannot contain line breaks");
    await expect(start({ task: "  " })).rejects.toThrow("Task is required");
    await expect(start({ role: "admin" })).rejects.toThrow("Role must be worker or coordinator");
    await expect(start({ profile: "--yolo" })).rejects.toThrow("Profile must be a profile name");
    await expect(start({ template: "review-worker", profile: "codex" })).rejects.toThrow("carries its own profile");
    await expect(start({ parent: "../t-1" })).rejects.toThrow("Node ID must look like t-1234");
    await expect(openProject(run, "/s", { project: "../acme" })).rejects.toThrow("Project must use lowercase");
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

  it("replaces the project coordinator on the chosen profile and passes on what Organizations says", async () => {
    const { run, calls } = fakeRun({ code: 0, stdout: "stopped 1 coordinator agent(s) and started a new one on codex\n", stderr: "" });

    expect(await replaceCoordinator(run, "/tmp/herdr.sock", { project: "acme", profile: "codex" }))
      .toEqual({ message: "stopped 1 coordinator agent(s) and started a new one on codex" });
    expect(calls).toEqual([{
      argv: ["coordinator", "replace", "acme", "--profile=codex"],
      opts: { env: { HERDR_SOCKET_PATH: "/tmp/herdr.sock" }, timeoutMs: 60_000 },
    }]);
    await expect(replaceCoordinator(run, "/s", { project: "acme", profile: "" })).rejects.toThrow("Choose the agent the new coordinator runs on.");
    await expect(replaceCoordinator(run, "/s", { project: "acme", profile: "--yolo" })).rejects.toThrow("Profile must be a profile name");
    await expect(replaceCoordinator(run, "/s", { project: "../acme", profile: "codex" })).rejects.toThrow("Project must use lowercase");
    expect(calls).toHaveLength(1);
    await expect(replaceCoordinator(fakeRun({ code: 1, stdout: "", stderr: "error: no Herdr session to start the coordinator in" }).run, "/s", { project: "acme", profile: "codex" }))
      .rejects.toThrow("no Herdr session");
  });

  it("closes a thread through upstream herdr-projects, keeping its worktree", async () => {
    const { run, calls } = fakeRun({ code: 0, stdout: "", stderr: "" });

    await resolveNode(run, "/tmp/herdr.sock", { project: "acme", id: "t-0042" }, () => true);

    expect(calls.map((call) => call.argv)).toEqual([["thread", "resolve", "acme", "t-0042", "--keep-worktree"]]);
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

  it("copies the glyph and tone a project picked, and reads a missing, empty or malformed pick as none", async () => {
    const project = (slug: string, pick: Record<string, unknown>) => ({ slug, name: slug, goal: "", status: "active", threads: [], ...pick });
    const projects = [
      project("picked", { icon: "flag", tone: "red" }),
      project("unpicked", { icon: "", tone: "" }),
      project("older", {}),
      project("odd", { icon: "Flag Icon", tone: 7 }),
    ];
    const { run } = fakeRun({ code: 0, stdout: JSON.stringify({ schema_version: 1, projects }), stderr: "" });

    expect((await readOverview(run, "/root"))!.map(({ slug, icon, tone }) => ({ slug, icon, tone }))).toEqual([
      { slug: "picked", icon: "flag", tone: "red" },
      { slug: "unpicked", icon: "", tone: "" },
      { slug: "older", icon: "", tone: "" },
      { slug: "odd", icon: "", tone: "" },
    ]);
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

  it("reads a thread's verdict, summary, captures and deliverables, bounded and checked, and none from an older Organizations", async () => {
    const capture = (n: number) => ({ path: `/p/demo/library/t-0002/shot-${n}.png`, caption: `Shot ${n}` });
    const reported = {
      ...overviewThread,
      verdict: "needs-decision",
      summary: "x".repeat(700),
      plain_summary: { text: ` ${"y".repeat(1000)} `, current: false, error: "", at: "2026-10-19T10:00:00Z" },
      captures: [capture(0), { path: "relative.png", caption: "dropped" }, { path: "/p/demo/library/t-0002/no-caption.png" }, "junk", ...Array.from({ length: 30 }, (_, n) => capture(n + 1))],
      deliverables: [
        { path: "/p/demo/library/t-0002/report.html", kind: "html" },
        { path: "/p/demo/library/t-0002/notes.md", kind: "md" },
        { path: "/p/demo/library/t-0002/run.sh", kind: "sh" },
        ...Array.from({ length: 12 }, (_, n) => ({ path: `/p/demo/library/t-0002/r${n}.pdf`, kind: "pdf" })),
      ],
    };
    const odd = { ...overviewThread, id: "t-0003", verdict: "shipped", summary: 7, captures: "none", deliverables: null, plain_summary: { text: 7, current: true } };
    const older = { ...overviewThread, id: "t-0004" };
    const { run } = fakeRun({ code: 0, stdout: JSON.stringify({ schema_version: 1, projects: [{ slug: "demo", name: "Demo", goal: "", status: "active", threads: [reported, odd, older] }] }), stderr: "" });

    const [thread, malformed, before] = (await readOverview(run, "/root"))![0]!.threads;
    expect(thread!.verdict).toBe("needs-decision");
    expect(thread!.summary).toBe("x".repeat(600));
    expect(thread!.plain_summary).toEqual({ text: "y".repeat(900), current: false });
    expect(thread!.captures).toHaveLength(24);
    expect(thread!.captures.slice(0, 2)).toEqual([capture(0), { path: "/p/demo/library/t-0002/no-caption.png", caption: "" }]);
    expect(thread!.deliverables).toHaveLength(10);
    // Organizations prints only html and pdf; any other kind, a Markdown file included, is dropped.
    expect(thread!.deliverables.slice(0, 2)).toEqual([{ path: "/p/demo/library/t-0002/report.html", kind: "html" }, { path: "/p/demo/library/t-0002/r0.pdf", kind: "pdf" }]);
    for (const empty of [malformed!, before!]) expect(empty).toMatchObject({ verdict: null, summary: null, plain_summary: null, captures: [], deliverables: [] });
  });

  it("reads a coordinator's STATUS.md for the project and each thread, bounded, and none from an older Organizations or a malformed one", async () => {
    const status = (text: string) => ({ path: "/work/demo/STATUS.md", text, updated: "2026-10-16T12:00:00Z" });
    const coordinator = { ...overviewThread, id: "t-0005", role: "coordinator", status_file: status("# Status\n## Asked\n- [open] Login") };
    const worker = { ...overviewThread, id: "t-0006", status_file: null };
    const malformed = [
      { ...overviewThread, id: "t-0007", status_file: { path: "relative/STATUS.md", text: "x", updated: "2026-10-16T12:00:00Z" } },
      { ...overviewThread, id: "t-0008", status_file: { path: "/w/STATUS.md", text: "   ", updated: "2026-10-16T12:00:00Z" } },
      { ...overviewThread, id: "t-0009", status_file: { path: "/w/STATUS.md", text: 7, updated: "2026-10-16T12:00:00Z" } },
      { ...overviewThread, id: "t-0010", status_file: "STATUS.md" },
    ];
    const project = { slug: "demo", name: "Demo", goal: "", status: "active", status_file: status("y".repeat(9_000)), threads: [coordinator, worker, ...malformed, overviewThread] };
    const older = { slug: "old", name: "Old", goal: "", status: "active", threads: [] };
    const { run } = fakeRun({ code: 0, stdout: JSON.stringify({ schema_version: 1, projects: [project, older] }), stderr: "" });

    const [demo, before] = (await readOverview(run, "/root"))!;
    expect(demo!.status_file).toEqual({ path: "/work/demo/STATUS.md", text: "y".repeat(8_000), updated: "2026-10-16T12:00:00Z" });
    expect(demo!.threads.map((thread) => thread.status_file)).toEqual([status("# Status\n## Asked\n- [open] Login"), null, null, null, null, null, null]);
    // The lifecycle stays where it was: the file has a field of its own.
    expect(demo!.threads[0]!.status).toBe("open");
    expect(before!.status_file).toBeNull();
  });

  it("keeps an unread pull request's unknown numbers as null, never zero", async () => {
    const unread = { ...overviewThread, pr: { url: overviewThread.pr.url, state: "", review: "", checks: null, additions: null, deletions: null, failing: [], comment_count: null, draft: null, mergeable: null, merge_blocker: "the ticker has not read this pull request yet" } };
    const { run } = fakeRun({ code: 0, stdout: JSON.stringify({ schema_version: 1, projects: [{ slug: "demo", name: "Demo", goal: "", status: "active", threads: [unread] }] }), stderr: "" });

    const pr = (await readOverview(run, "/root"))![0]!.threads[0]!.pr!;
    expect(pr).toMatchObject({ checks: null, additions: null, deletions: null, comment_count: null });
  });
});

const routineRecord = {
  name: "nightly-deps", trigger: "schedule", schedule: "daily 03:00", events: [], enabled: true,
  command: "bun outdated", command_status: "approved", prompt: "Check the dependencies.",
  last_run: "2026-10-09T03:00:00Z", next_run: "2026-10-10T03:00:00Z", skipped_unhandled: 0, skipped_no_coordinator: 0,
};
const prRoutineRecord = {
  ...routineRecord, name: "pr-follow-up", trigger: "pr", schedule: "", events: ["checks-failed", "review"],
  command: "", command_status: "none", last_run: "", next_run: "",
};

describe("herdr-organizations routine list", () => {
  it("reads a project's routines with exact argv, keeping only what a list shows", async () => {
    const { run, calls } = fakeRun({
      code: 0,
      stdout: JSON.stringify({ schema_version: 1, project: "demo", routine_commands: true, routines: [routineRecord, prRoutineRecord], broken: [{ file: "routines/x.md", error: "bad" }] }),
      stderr: "",
    });

    expect(await listRoutines(run, "demo")).toEqual({
      available: true,
      broken: 1,
      routines: [
        { name: "nightly-deps", trigger: "schedule", schedule: "daily 03:00", events: [], enabled: true, lastRun: "2026-10-09T03:00:00Z", nextRun: "2026-10-10T03:00:00Z" },
        { name: "pr-follow-up", trigger: "pr", schedule: "", events: ["checks-failed", "review"], enabled: true, lastRun: "", nextRun: "" },
      ],
    });
    expect(calls).toEqual([{ argv: ["routine", "list", "demo", "--json"], opts: { timeoutMs: 10_000 } }]);
  });

  it("drops a malformed routine rather than showing a half-read one", async () => {
    const { run } = fakeRun({
      code: 0,
      stdout: JSON.stringify({ schema_version: 1, routines: [routineRecord, { ...routineRecord, trigger: "cron" }, { ...routineRecord, name: 3 }, { ...routineRecord, enabled: "yes" }], broken: [] }),
      stderr: "",
    });

    expect((await listRoutines(run, "demo")).routines.map((routine) => routine.name)).toEqual(["nightly-deps"]);
  });

  it("says it cannot list routines when the installed CLI has no routine list --json", async () => {
    for (const result of [
      { code: 2, stdout: "", stderr: "error: unexpected argument '--json' found" },
      { code: 2, stdout: "", stderr: "error: unrecognized subcommand 'routine'" },
      { code: 0, stdout: JSON.stringify({ schema_version: 2, routines: [] }), stderr: "" },
    ]) {
      expect(await listRoutines(fakeRun(result).run, "demo")).toEqual({ available: false, routines: [], broken: 0 });
    }
  });

  it("validates the slug before running anything and reports a real failure", async () => {
    const { run, calls } = fakeRun({ code: 1, stdout: "", stderr: "error: no project demo" });

    await expect(listRoutines(run, "../etc")).rejects.toThrow("Project must use lowercase");
    expect(calls).toHaveLength(0);
    await expect(listRoutines(run, "demo")).rejects.toThrow("herdr-organizations failed (1): error: no project demo");
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

  it("asks a thread about its PR with an action from the closed list, and says whether it was sent", async () => {
    const reply = (sent: boolean, reason = "") => ({ code: 0, stdout: JSON.stringify({ schema_version: 1, ok: true, id: "t-0002", action: "fix-ci", pr: "https://github.com/acme/demo/pull/42", sent, message: sent ? "Fix the failing check." : "", reason }), stderr: "" });
    const { run, calls } = fakeRun(reply(true));

    expect(await prAction(run, { project: "demo", id: "t-0002", action: "fix-ci" })).toEqual({ id: "t-0002", action: "fix-ci", pr: "https://github.com/acme/demo/pull/42", sent: true, reason: "" });
    expect(calls).toEqual([{ argv: ["thread", "pr-action", "demo", "t-0002", "fix-ci", "--json"], opts: { timeoutMs: 90_000 } }]);
    // Merge and Create PR have their own commands; nothing else, and no flag, reaches the argv.
    for (const action of ["merge", "create-pr", "--admin", "fix-ci --force", undefined, 1]) {
      await expect(prAction(run, { project: "demo", id: "t-0002", action })).rejects.toThrow("Action must be resolve-conflicts, fix-ci or address-comments.");
    }
    await expect(prAction(run, { project: "../demo", id: "t-0002", action: "fix-ci" })).rejects.toThrow("Project must use");
    await expect(prAction(run, { project: "demo", id: "t-2", action: "fix-ci" })).rejects.toThrow("Node ID must");
    expect(calls).toHaveLength(1);

    const already = "auto-fix already asked it at 2026-10-15T10:00:00Z about this state of its pull request (commit 0123456)";
    expect(await prAction(fakeRun(reply(false, already)).run, { project: "demo", id: "t-0002", action: "fix-ci" })).toMatchObject({ sent: false, reason: already });
  });

  it("passes a PR action's refusal through word for word, and anything else as the CLI's failure", async () => {
    const reason = "no check fails on its pull request (3 passed, 0 pending)";
    const refused = { code: 1, stdout: JSON.stringify({ schema_version: 1, ok: false, id: "t-0002", action: "fix-ci", pr: "https://github.com/acme/demo/pull/42", sent: false, message: "", reason }), stderr: `error: ${reason}` };
    const error = await prAction(fakeRun(refused).run, { project: "demo", id: "t-0002", action: "fix-ci" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OrgValidationError);
    expect((error as Error).message).toBe(reason);

    const broken = await prAction(fakeRun({ code: 1, stdout: "", stderr: "error: no project `demo`" }).run, { project: "demo", id: "t-0002", action: "fix-ci" }).catch((caught: unknown) => caught);
    expect(broken).toBeInstanceOf(OrgCliError);
    expect((broken as Error).message).toBe("herdr-organizations failed (1): error: no project `demo`");
    // A reply about another thread or action is no answer to this press.
    const other = { code: 0, stdout: JSON.stringify({ schema_version: 1, ok: true, id: "t-0003", action: "fix-ci", pr: "", sent: true, message: "", reason: "" }), stderr: "" };
    await expect(prAction(fakeRun(other).run, { project: "demo", id: "t-0002", action: "fix-ci" })).rejects.toThrow("invalid pr-action response");
  });

  it("opens a thread's pull request, or says why Organizations would not", async () => {
    const { run, calls } = fakeRun({ code: 0, stdout: JSON.stringify({ schema_version: 1, ok: true, id: "t-0007", pr: "https://github.com/acme/demo/pull/43", reason: "" }), stderr: "" });

    expect(await prCreate(run, { project: "demo", id: "t-0007" })).toEqual({ id: "t-0007", pr: "https://github.com/acme/demo/pull/43" });
    expect(calls).toEqual([{ argv: ["thread", "pr-create", "demo", "t-0007", "--json"], opts: { timeoutMs: 90_000 } }]);
    await expect(prCreate(run, { project: "demo", id: "--help" })).rejects.toThrow("Node ID must");
    expect(calls).toHaveLength(1);

    const reason = "its agent is not idle (working)";
    const refused = { code: 1, stdout: JSON.stringify({ schema_version: 1, ok: false, id: "t-0007", pr: "", reason }), stderr: `error: ${reason}` };
    await expect(prCreate(fakeRun(refused).run, { project: "demo", id: "t-0007" })).rejects.toThrow(new OrgValidationError(reason));
  });

  it("asks Organizations' summary agent for a report in plain words, again only when forced, and says why it failed", async () => {
    const answer = { schema_version: 1, ok: true, id: "t-0007", text: " Two people paying at once no longer lose their place. ", reason: "", at: "2026-10-19T10:00:00Z" };
    const { run, calls } = fakeRun({ code: 0, stdout: JSON.stringify(answer), stderr: "" });

    expect(await explainThread(run, { project: "demo", id: "t-0007" })).toEqual({ id: "t-0007", text: "Two people paying at once no longer lose their place." });
    await explainThread(run, { project: "demo", id: "t-0007", force: true });
    expect(calls.map((call) => call.argv)).toEqual([
      ["thread", "explain", "demo", "t-0007", "--json"],
      ["thread", "explain", "demo", "t-0007", "--force", "--json"],
    ]);
    // A small model may take a while; the bridge waits past the agent's own 120 s timeout.
    expect(calls[0]!.opts).toEqual({ timeoutMs: 150_000 });
    await expect(explainThread(run, { project: "demo", id: "--help" })).rejects.toThrow("Node ID must");

    const failed = { code: 1, stdout: JSON.stringify({ ...answer, ok: false, text: "", reason: "rate limited" }), stderr: "error: t-0007: the summary agent failed: rate limited" };
    await expect(explainThread(fakeRun(failed).run, { project: "demo", id: "t-0007" })).rejects.toThrow(new OrgValidationError("rate limited"));
    const empty = { code: 0, stdout: JSON.stringify({ ...answer, text: "  " }), stderr: "" };
    await expect(explainThread(fakeRun(empty).run, { project: "demo", id: "t-0007" })).rejects.toThrow("invalid explain response");
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

describe("herdr-organizations project documents (task list, project show, routine list)", () => {
  const missing = { code: 2, stdout: "", stderr: "error: unrecognized subcommand 'task'" };
  const task = { list: "Backlog", title: "Fix login", owner: { kind: "agent", profile: "codex", machine: "", name: "" }, thread: "t-0007", description: "Safari logs out.\n  keep the cookie" };

  it("reads the coordinator's tasks in file order from the project's root", async () => {
    const { run, calls } = fakeRun({ code: 0, stdout: JSON.stringify({ schema_version: 1, project: "acme", tasks: [
      task,
      { list: "", title: "Write the docs", owner: { kind: "me", profile: "", machine: "", name: "" }, thread: "", description: "" },
      { ...task, owner: { kind: "robot" } },
    ] }), stderr: "" });
    expect(await readTasks(run, "/root", "acme")).toEqual([
      { list: "Backlog", title: "Fix login", owner: { kind: "agent", profile: "codex", machine: "", name: "" }, thread: "t-0007", description: "Safari logs out.\n  keep the cookie" },
      { list: "", title: "Write the docs", owner: { kind: "me", profile: "", machine: "", name: "" }, thread: "", description: "" },
    ]);
    expect(calls).toEqual([{ argv: ["task", "list", "acme", "--json"], opts: { env: { HERDR_PROJECTS_ROOT: "/root" }, timeoutMs: 10_000 } }]);
  });

  it("answers no document, never an error, when Organizations predates it or says something else", async () => {
    for (const result of [missing, { code: 0, stdout: "not json", stderr: "" }, { code: 0, stdout: JSON.stringify({ schema_version: 2, tasks: [] }), stderr: "" }, { code: 0, stdout: JSON.stringify({ schema_version: 1 }), stderr: "" }]) {
      expect(await readTasks(fakeRun(result).run, "/root", "acme")).toBeNull();
      expect(await readProjectDetail(fakeRun(result).run, "/root", "acme")).toBeNull();
      expect(await readRoutines(fakeRun(result).run, "/root", "acme")).toBeNull();
    }
  });

  it("refuses a slug that is not one before running anything", async () => {
    const { run, calls } = fakeRun(missing);
    await expect(readTasks(run, "/root", "--all")).rejects.toThrow("lowercase");
    await expect(readProjectDetail(run, "/root", "../x")).rejects.toThrow("lowercase");
    expect(calls).toEqual([]);
  });

  it("reads what every thread receives, and drops a memory file or repo that is not one", async () => {
    const project = {
      slug: "acme", name: "Acme Shop", goal: "Ship it", status: "active", dir: "/srv/projects/acme", counts: {}, icon: "", tone: "",
      instructions: "Open a pull request.\n", memory: "# Memory\n", memory_files: [{ name: "payments.md", text: "Retries.\n" }, { name: 3 }],
      repos: [{ path: "/srv/acme/shop", machine: "" }, { path: "/srv/acme/admin", machine: "build-box" }, { machine: "x" }],
      coordinator_profile: "claude", thread_profile: "codex", max_parallel_threads: 10, auto_resolve_days: 7, nudge: true, mute: false,
    };
    const { run, calls } = fakeRun({ code: 0, stdout: JSON.stringify({ schema_version: 1, project }), stderr: "" });
    expect(await readProjectDetail(run, "/root", "acme")).toEqual({
      instructions: "Open a pull request.\n", memory: "# Memory\n", memoryFiles: [{ name: "payments.md", text: "Retries.\n" }],
      repos: [{ path: "/srv/acme/shop", machine: "" }, { path: "/srv/acme/admin", machine: "build-box" }],
      coordinatorProfile: "claude", threadProfile: "codex", maxParallelThreads: 10,
    });
    expect(calls[0]!.argv).toEqual(["project", "show", "acme", "--json"]);
  });

  it("lists routines with their trigger and whether they are on", async () => {
    const routine = { name: "nightly-deps", trigger: "schedule", schedule: "daily 03:00", events: [], enabled: true, command: "", command_status: "none", prompt: "Check.", last_run: "", next_run: "2026-10-11T03:00:00Z", skipped_unhandled: 0, skipped_no_coordinator: 0 };
    const { run, calls } = fakeRun({ code: 0, stdout: JSON.stringify({ schema_version: 1, project: "acme", routine_commands: false, broken: [], routines: [
      routine, { ...routine, name: "pr-followup", trigger: "pr", schedule: "", events: ["opened", "merged"], enabled: false, next_run: "" }, { ...routine, trigger: "cron" },
    ] }), stderr: "" });
    expect(await readRoutines(run, "/root", "acme")).toEqual([
      { name: "nightly-deps", trigger: "schedule", schedule: "daily 03:00", events: [], enabled: true, nextRun: "2026-10-11T03:00:00Z" },
      { name: "pr-followup", trigger: "pr", schedule: "", events: ["opened", "merged"], enabled: false, nextRun: "" },
    ]);
    expect(calls[0]!.argv).toEqual(["routine", "list", "acme", "--json"]);
  });
});

describe("herdr-organizations project status", () => {
  const owner = { kind: "agent" as const, profile: "claude", machine: "", name: "" };
  const pr = { url: "https://github.com/acme/shop/pull/41", state: "OPEN", review: "APPROVED", checks: null, additions: 3, deletions: 1, failing: [], comment_count: 0, draft: false, mergeable: "MERGEABLE", merge_blocker: null };
  const item = (extra: Record<string, unknown>) => ({
    kind: "task", id: "task:3", title: "Cart badge", list: "Checkout", owner, state: "review", group: "ready-for-review", task: "Cart badge",
    thread: "t-0013", pr, created: "2026-10-10T13:00:00Z", updated: "2026-10-10T13:50:00Z", flags: [], ...extra,
  });
  const document = {
    schema_version: 1, project: "acme", generated_at: "2026-10-10T14:00:00Z", objective: "Ship the checkout.",
    sources: { tasks_updated: "", handoff_updated: "", handoff_chars: 9412, handoff_limit: 8000, pr_checked: "" },
    items: [
      item({}),
      item({ id: "task:9", title: "Refund flow", owner: { kind: "person", profile: "", machine: "", name: "blocked on design" }, state: "todo", group: "", thread: "", pr: null, flags: ["status-in-owner"] }),
      item({ id: "task:12", title: "Product images", owner: { kind: "robot" }, state: "done", thread: "", pr: null, flags: ["done-not-deleted"] }),
      item({ kind: "thread", id: "t-0015", title: "Order email", list: "", owner: null, state: "landing", group: "landing", task: "", thread: "t-0015" }),
      item({ kind: "thread", id: "t-0014", title: "Login hotfix", list: "", owner: null, state: "idle", group: "idle", task: "", thread: "t-0014", pr: null }),
      // Kinds and states this Nenu does not know yet are skipped, as the contract asks.
      item({ kind: "pr", id: "pr:44", title: "Bump a library" }),
      item({ id: "task:20", title: "Someday", state: "parked" }),
      item({ id: 7, title: "Not an id" }),
      "not an item",
    ],
    drift: { handoff_over_limit: 1, thread_resolved: 0, thread_missing: 0, done_not_deleted: 1, status_in_owner: 1, duplicate_title: 0, inbox_unhandled: 2 },
    problems: [
      { rule: "handoff-over-limit", line: 0, task: "", thread: "", detail: "9412 characters, this digest shows the first 8000" },
      { rule: "status-in-owner", line: 9, task: "Refund flow", thread: "", detail: "the owner \"blocked on design\" is status text" },
      { rule: "a-rule-from-later", line: 12, task: "Product images", detail: "checked done but still listed" },
      { rule: "no-detail", line: 4 },
    ],
    next: [{ thread: "t-0013", line: "Ask for review" }],
  };

  it("reads the project's work by state, and its problems, from the project's root", async () => {
    const { run, calls } = fakeRun({ code: 0, stdout: JSON.stringify(document), stderr: "" });
    expect(await readStatus(run, "/root", "acme")).toEqual({
      items: [
        { kind: "task", id: "task:3", title: "Cart badge", state: "review", owner, thread: "t-0013" },
        { kind: "task", id: "task:9", title: "Refund flow", state: "todo", owner: { kind: "person", profile: "", machine: "", name: "blocked on design" }, thread: "" },
        { kind: "task", id: "task:12", title: "Product images", state: "done", owner: null, thread: "" },
        { kind: "thread", id: "t-0015", title: "Order email", state: "landing", owner: null, thread: "t-0015" },
        { kind: "thread", id: "t-0014", title: "Login hotfix", state: "idle", owner: null, thread: "t-0014" },
      ],
      problems: [
        { rule: "handoff-over-limit", line: 0, task: "", thread: "", detail: "9412 characters, this digest shows the first 8000" },
        { rule: "status-in-owner", line: 9, task: "Refund flow", thread: "", detail: "the owner \"blocked on design\" is status text" },
        { rule: "a-rule-from-later", line: 12, task: "Product images", thread: "", detail: "checked done but still listed" },
      ],
    });
    expect(calls).toEqual([{ argv: ["project", "status", "acme", "--json"], opts: { env: { HERDR_PROJECTS_ROOT: "/root" }, timeoutMs: 10_000 } }]);
  });

  it("answers no document when this Organizations has no `project status`, or another contract", async () => {
    for (const result of [
      { code: 2, stdout: "", stderr: "error: unrecognized subcommand 'status'\n\nUsage: herdr-organizations project [OPTIONS] <COMMAND>" },
      { code: 2, stdout: "", stderr: "error: unrecognized subcommand 'project'" },
      { code: 2, stdout: "", stderr: "error: unexpected argument '--json' found" },
      { code: 0, stdout: JSON.stringify({ ...document, schema_version: 2 }), stderr: "" },
    ]) expect(await readStatus(fakeRun(result).run, "/root", "acme")).toBeNull();
  });

  it("fails, rather than answering no document, when the command ran and failed", async () => {
    await expect(readStatus(fakeRun({ code: 1, stdout: "", stderr: "herdr-organizations: no project `acme`" }).run, "/root", "acme"))
      .rejects.toThrow("herdr-organizations failed (1): herdr-organizations: no project `acme`");
    await expect(readStatus(fakeRun({ code: 124, stdout: "", stderr: "" }).run, "/root", "acme")).rejects.toThrow("herdr-organizations failed (124).");
    await expect(readStatus(fakeRun({ code: 0, stdout: "not json", stderr: "" }).run, "/root", "acme")).rejects.toThrow("invalid JSON for project status");
    await expect(readStatus(fakeRun({ code: 0, stdout: JSON.stringify({ schema_version: 1, project: "acme" }), stderr: "" }).run, "/root", "acme"))
      .rejects.toThrow("an invalid project status");
  });

  it("refuses a slug that is not one before running anything", async () => {
    const { run, calls } = fakeRun({ code: 0, stdout: "", stderr: "" });
    await expect(readStatus(run, "/root", "--all")).rejects.toThrow("lowercase");
    expect(calls).toEqual([]);
  });
});
