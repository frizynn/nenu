import { describe, expect, it } from "bun:test";

import {
  listTemplates,
  resolveNode,
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

    await resolveNode(run, "/tmp/herdr.sock", { project: "nenu", id: "t-1234" });

    expect(calls).toEqual([{
      argv: ["node", "resolve", "nenu", "t-1234", "--close-view"],
      opts: { env: { HERDR_SOCKET_PATH: "/tmp/herdr.sock" }, timeoutMs: 30_000 },
    }]);
  });
});
