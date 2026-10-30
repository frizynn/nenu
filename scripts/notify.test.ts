import { describe, expect, test } from "bun:test";

import type { AgentNotifyRow } from "../bridge/agent-notify.ts";
import { formatList, herdrPane, parsePatterns, resolveTarget } from "./notify.ts";

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

  test("a herdr-core pane id is found in its own session; one in two sessions asks which", () => {
    const both = [...rows, row("t6", { session: "hc", name: "desk claude" }), row("box:t2", { session: "hc" })];
    expect(resolveTarget("t6", both, "default", {})).toEqual({ session: "hc", paneId: "t6" });
    expect(resolveTarget("box:t2", both, "default", {})).toEqual({ session: "hc", paneId: "box:t2" });
    expect(resolveTarget("desk claude", both, "default", {})).toEqual({ session: "hc", paneId: "t6" });
    expect(resolveTarget("hc/t6", both, "default", {})).toEqual({ session: "hc", paneId: "t6" });
    expect(() => resolveTarget("w1:p1", [...both, row("w1:p1", { session: "hc" })], "default", {})).toThrow(/several sessions/);
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
      row("w1:p2", { cwd: "/work/shop", why: "outside" }),
      row("w1:p3", { gone: 9, on: true, why: "set" }),
    ], ["~/.firstmate/*"], "/home/you");
    expect(out).toContain("New agents start with notifications on only in: ~/.firstmate/*");
    expect(out).toMatch(/on +default\/w1:p1 +boss +~\/\.firstmate\/awam +supervisor folder/);
    expect(out).toMatch(/off +default\/w1:p2 +\/work\/shop +new agent outside the supervisor folders/);
    expect(out.split("Closed")[1]).toContain("default/w1:p3");
  });

  test("with no supervisor folders it says every new agent starts on", () => {
    const out = formatList([row("w1:p1", { on: true, cwd: "/work/shop" })], [], "/home/you");
    expect(out).toContain("Every new agent starts with notifications on");
    expect(out).toMatch(/on +default\/w1:p1 +\/work\/shop +new agent$/m);
  });
});

describe("parsePatterns", () => {
  test("takes comma-separated whole paths, and refuses nothing or a relative one", () => {
    expect(parsePatterns(" ~/.firstmate/* , ~/Developer/firstmate ")).toEqual(["~/.firstmate/*", "~/Developer/firstmate"]);
    expect(parsePatterns("/srv/**/boss,**")).toEqual(["/srv/**/boss", "**"]);
    expect(() => parsePatterns("")).toThrow(/use `clear`/);
    expect(() => parsePatterns(undefined)).toThrow(/use `clear`/);
    expect(() => parsePatterns("projects/*")).toThrow(/not a whole path/);
    expect(() => parsePatterns("**foo")).toThrow(/not a whole path/);
  });
});
