import { describe, expect, test } from "bun:test";

import type { AgentNotifyRow } from "../bridge/agent-notify.ts";
import { formatList, herdrPane, resolveTarget } from "./notify.ts";

const row = (paneId: string, extra: Partial<AgentNotifyRow> = {}): AgentNotifyRow =>
  ({ session: "default", paneId, on: false, why: "new", firstSeen: 1, ...extra });

describe("herdrPane", () => {
  test("a plugin action's focused pane wins over the shell's own pane", () => {
    expect(herdrPane({ HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: "w1:p3" }), HERDR_PANE_ID: "w1:p1" })).toBe("w1:p3");
    expect(herdrPane({ HERDR_PLUGIN_CONTEXT_JSON: "{bad", HERDR_PANE_ID: "w1:p1" })).toBe("w1:p1");
    expect(herdrPane({ HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: null }) })).toBeUndefined();
  });
});

describe("resolveTarget", () => {
  const rows = [row("w1:p1", { name: "reviewer" }), row("w2:p1", { name: "Twin" }), row("w3:p1", { name: "twin" }), row("w4:p1", { name: "old", gone: 5 })];

  test("a pane id, with or without its session", () => {
    expect(resolveTarget("w9:p2", rows, "default", {})).toEqual({ session: "default", paneId: "w9:p2" });
    expect(resolveTarget("lab/w9:p2", rows, "default", {})).toEqual({ session: "lab", paneId: "w9:p2" });
  });

  test("a name, any case; several or none is an error that says so", () => {
    expect(resolveTarget("REVIEWER", rows, "default", {})).toEqual({ session: "default", paneId: "w1:p1" });
    expect(() => resolveTarget("twin", rows, "default", {})).toThrow(/names 2 agents/);
    expect(() => resolveTarget("old", rows, "default", {})).toThrow(/no agent named/);
  });

  test("no argument takes Herdr's pane, and with none it asks for one", () => {
    expect(resolveTarget(undefined, rows, "default", { HERDR_PANE_ID: "w1:p1" })).toEqual({ session: "default", paneId: "w1:p1" });
    expect(() => resolveTarget(undefined, rows, "default", {})).toThrow(/name an agent/);
  });
});

describe("formatList", () => {
  test("shows the rule, each agent's switch and why, and closed agents apart", () => {
    const out = formatList([
      row("w1:p1", { on: true, why: "supervisor", name: "boss", cwd: "/home/you/.firstmate/awam" }),
      row("w1:p2", { cwd: "/work/shop" }),
      row("w1:p3", { gone: 9, on: true, why: "set" }),
    ], ["~/.firstmate/*"], "/home/you");
    expect(out).toContain("New agents start with notifications on in: ~/.firstmate/*");
    expect(out).toMatch(/on +default\/w1:p1 +boss +~\/\.firstmate\/awam +supervisor folder/);
    expect(out).toMatch(/off +default\/w1:p2 +\/work\/shop +new agent/);
    expect(out.split("Closed")[1]).toContain("default/w1:p3");
    expect(formatList([], [], "/home/you")).toContain("every new agent starts off");
  });
});
