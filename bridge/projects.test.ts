import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ProjectRegistry } from "./projects.ts";
import type { AgentView } from "./types.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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
    const registry = new ProjectRegistry({ root: fixture(), now: () => 1 });
    const [project] = registry.list("default", true, []);
    expect(project?.slug).toBe("demo");
    expect(project?.coordinator).toBeUndefined();
    expect(project?.threads[0]?.paneId).toBeUndefined();
    expect(registry.list("named", false, [])).toEqual([]);
  });

  test("links exact live metadata and rejects a reused pane id with the wrong cwd", () => {
    const registry = new ProjectRegistry({ root: fixture(), now: () => 1 });
    const live = registry.list("default", true, [pane({}), pane({ paneId: "p2", tabId: "t2", cwd: "/work/demo/wt" })])[0]!;
    expect(live.coordinator?.paneId).toBe("p1");
    expect(live.threads[0]?.paneId).toBe("p2");

    const reused = registry.list("default", true, [pane({ cwd: "/elsewhere" })])[0]!;
    expect(reused.coordinator).toBeUndefined();
  });

  test("malformed metadata fails soft", () => {
    const root = fixture();
    writeFileSync(join(root, "demo", "threads", "t-0002.toml"), "bad = [");
    expect(() => new ProjectRegistry({ root, now: () => 1 }).list("default", true, [])).not.toThrow();
  });

  test("does not follow registry metadata symlinks", () => {
    const root = fixture();
    const outside = join(tmpdir(), `nenu-outside-${crypto.randomUUID()}.md`);
    roots.push(outside);
    writeFileSync(outside, `+++\nname = "Leaked"\n+++\n`);
    rmSync(join(root, "demo", "PROJECT.md"));
    symlinkSync(outside, join(root, "demo", "PROJECT.md"));
    expect(new ProjectRegistry({ root, now: () => 1 }).list("default", true, [])).toEqual([]);
  });
});
