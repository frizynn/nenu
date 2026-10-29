import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENT_NOTIFY_FORGET_MS, AgentNotifyStore, coerce, DEFAULT_SUPERVISOR_PATTERNS, isSupervisor, matchesFolder } from "./agent-notify.ts";
import { hcSnapshot, type HcTerminal } from "./hc-core.ts";
import { NotificationCoordinator, type AgentNotice, type NotifyClock } from "./notifications.ts";
import { parseAgentNotify } from "./routes/settings.ts";
import type { AgentView } from "./types.ts";

const HOME = "/home/you";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fileIn(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-notify-"));
  dirs.push(dir);
  return join(dir, "agent-notify.json");
}

function pane(paneId: string, cwd: string, extra: Partial<AgentView> = {}): AgentView {
  return { paneId, workspaceId: "w1", workspaceLabel: "demo", workspaceNumber: 1, tabId: "w1:t1", agent: "claude", status: "idle", cwd, focused: false, ...extra };
}

/** A store whose sessions were already seeded (not a first run), at a clock the test moves. */
function store(file = fileIn(), patterns = DEFAULT_SUPERVISOR_PATTERNS, clock = { now: 1_000 }) {
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({ agents: {}, seeded: ["default", "a", "b", "hc"] }));
  return { s: new AgentNotifyStore(file, patterns, () => clock.now, HOME), file, clock };
}

describe("matchesFolder", () => {
  test("a home under ~/.firstmate matches, a project inside it does not", () => {
    expect(matchesFolder("/home/you/.firstmate/awam", "~/.firstmate/*", HOME)).toBe(true);
    expect(matchesFolder("/home/you/.firstmate/awam/", "~/.firstmate/*", HOME)).toBe(true);
    expect(matchesFolder("/home/you/.firstmate/awam/projects/shop", "~/.firstmate/*", HOME)).toBe(false);
    expect(matchesFolder("/home/you/.firstmate", "~/.firstmate/*", HOME)).toBe(false);
  });

  test("a plain folder matches only itself", () => {
    expect(matchesFolder("/home/you/Developer/firstmate", "~/Developer/firstmate", HOME)).toBe(true);
    expect(matchesFolder("/home/you/Developer/firstmate/projects/x", "~/Developer/firstmate", HOME)).toBe(false);
    expect(matchesFolder("/home/you/Developer/firstmate-old", "~/Developer/firstmate", HOME)).toBe(false);
  });

  test("** spans any depth, * stays within one name, and regex characters are literal", () => {
    expect(matchesFolder("/anything/at/all", "**", HOME)).toBe(true);
    expect(matchesFolder("/srv/a/b/boss", "/srv/**/boss", HOME)).toBe(true);
    expect(matchesFolder("/srv/boss", "/srv/**/boss", HOME)).toBe(true);
    expect(matchesFolder("/srv/team-a", "/srv/team-*", HOME)).toBe(true);
    expect(matchesFolder("/srv/team-a/x", "/srv/team-*", HOME)).toBe(false);
    expect(matchesFolder("/srv/a+b", "/srv/a+b", HOME)).toBe(true);
    expect(matchesFolder("/srv/aab", "/srv/a+b", HOME)).toBe(false);
  });

  test("an agent with no folder is never a supervisor", () => {
    expect(isSupervisor({ cwd: "" }, ["**"], HOME)).toBe(false);
  });
});

describe("AgentNotifyStore", () => {
  test("a new agent starts on in a supervisor's folder and off anywhere else", () => {
    const { s } = store();
    s.reconcile("default", [
      pane("w1:p1", "/home/you/.firstmate/awam"),
      pane("w1:p2", "/home/you/.firstmate/awam/projects/shop"),
      pane("w1:p3", "/home/you/Developer/firstmate"),
    ]);
    expect(s.on("default", "w1:p1")).toBe(true);
    expect(s.on("default", "w1:p2")).toBe(false);
    expect(s.on("default", "w1:p3")).toBe(true);
    expect(s.list().map((r) => [r.paneId, r.why])).toEqual([["w1:p1", "supervisor"], ["w1:p2", "new"], ["w1:p3", "supervisor"]]);
  });

  test("on the first run every agent already there keeps pushing; later ones follow the rule", () => {
    const file = fileIn();
    const s = new AgentNotifyStore(file, DEFAULT_SUPERVISOR_PATTERNS, () => 1, HOME);
    s.reconcile("default", [pane("w1:p1", "/work/shop")]);
    s.reconcile("other", [pane("w9:p1", "/work/blog")]);
    expect(s.on("default", "w1:p1")).toBe(true);
    expect(s.on("other", "w9:p1")).toBe(true);
    s.reconcile("default", [pane("w1:p1", "/work/shop"), pane("w1:p2", "/work/shop")]);
    expect(s.on("default", "w1:p2")).toBe(false);
    expect(s.list().find((r) => r.paneId === "w1:p1")?.why).toBe("existing");
    // A restart with the file in place seeds nobody.
    const again = new AgentNotifyStore(file, DEFAULT_SUPERVISOR_PATTERNS, () => 2, HOME);
    again.reconcile("default", [pane("w1:p1", "/work/shop"), pane("w1:p3", "/work/shop")]);
    expect(again.on("default", "w1:p3")).toBe(false);
    expect(again.on("default", "w1:p1")).toBe(true);
  });

  test("a terminal command run before the bridge's first start does not cost the upgrade its seeding", () => {
    const file = fileIn();
    new AgentNotifyStore(file, DEFAULT_SUPERVISOR_PATTERNS, () => 1, HOME).set("default", "w1:p9", false);
    const bridge = new AgentNotifyStore(file, DEFAULT_SUPERVISOR_PATTERNS, () => 2, HOME);
    bridge.reconcile("default", [pane("w1:p1", "/work/shop"), pane("w1:p9", "/work/shop")]);
    expect(bridge.on("default", "w1:p1")).toBe(true);
    expect(bridge.on("default", "w1:p9")).toBe(false);
    expect(bridge.sessions()).toEqual(["default"]);
  });

  test("a lock left by a writer that died is taken over; a live one makes the write fail, not clobber", () => {
    const { s, file } = store();
    writeFileSync(`${file}.lock`, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${file}.lock`, old, old);
    s.set("default", "w1:p1", true);
    expect(existsSync(`${file}.lock`)).toBe(false);
    writeFileSync(`${file}.lock`, "");
    expect(() => s.set("default", "w1:p1", false)).toThrow(/held by another writer/);
    expect(s.on("default", "w1:p1")).toBe(true);
  });

  test("the operator's choice survives a restart and is never overwritten by the rule", () => {
    const { s, file } = store();
    s.reconcile("default", [pane("w1:p1", "/home/you/.firstmate/awam"), pane("w1:p2", "/work/shop")]);
    s.set("default", "w1:p1", false);
    s.set("default", "w1:p2", true);
    const again = new AgentNotifyStore(file, DEFAULT_SUPERVISOR_PATTERNS, () => 5, HOME);
    again.reconcile("default", [pane("w1:p1", "/home/you/.firstmate/awam"), pane("w1:p2", "/work/shop")]);
    expect(again.on("default", "w1:p1")).toBe(false);
    expect(again.on("default", "w1:p2")).toBe(true);
    expect(again.list().every((r) => r.why === "set")).toBe(true);
  });

  test("an agent never seen may push until the herd decides it", () => {
    const { s } = store();
    expect(s.on("default", "w1:p9")).toBe(true);
  });

  test("an agent that leaves is kept a week, so a restored pane keeps its switch, then forgotten", () => {
    const { s, clock } = store();
    s.reconcile("default", [pane("w1:p1", "/work/shop")]);
    s.set("default", "w1:p1", true);
    clock.now += 1_000;
    s.reconcile("default", []);
    expect(s.list()[0]?.gone).toBe(clock.now);
    s.reconcile("default", [pane("w1:p1", "/work/shop")]);
    expect(s.list()[0]).toMatchObject({ on: true, why: "set" });
    expect(s.list()[0]?.gone).toBeUndefined();
    s.reconcile("default", []);
    clock.now += AGENT_NOTIFY_FORGET_MS + 1;
    s.reconcile("default", []);
    expect(s.list()).toHaveLength(0);
  });

  test("another session's agents are left alone", () => {
    const { s } = store();
    s.reconcile("a", [pane("w1:p1", "/work/shop")]);
    s.reconcile("b", []);
    expect(s.list()[0]?.gone).toBeUndefined();
  });

  test("the name, workspace and folder follow the pane; a quiet herd writes nothing", () => {
    const { s, file } = store();
    s.reconcile("default", [pane("w1:p1", "/work/shop")]);
    s.reconcile("default", [pane("w1:p1", "/work/shop", { paneLabel: "reviewer" })]);
    expect(s.list()[0]).toMatchObject({ name: "reviewer", workspace: "demo", cwd: "/work/shop", agent: "claude" });
    const before = statSync(file);
    s.reconcile("default", [pane("w1:p1", "/work/shop", { paneLabel: "reviewer" })]);
    expect(statSync(file).ino).toBe(before.ino);
  });

  test("a change written by the terminal command is read on the bridge's next look", () => {
    const { s, file } = store();
    s.reconcile("default", [pane("w1:p1", "/work/shop")]);
    expect(s.on("default", "w1:p1")).toBe(false);
    const terminal = new AgentNotifyStore(file, DEFAULT_SUPERVISOR_PATTERNS, () => 9, HOME);
    terminal.set("default", "w1:p1", true);
    expect(s.on("default", "w1:p1")).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("a file it cannot read keeps what it had; junk rows are dropped", () => {
    const { s, file } = store();
    s.reconcile("default", [pane("w1:p1", "/work/shop")]);
    s.set("default", "w1:p1", true);
    writeFileSync(file, "{not json");
    expect(s.on("default", "w1:p1")).toBe(true);
    expect(coerce({ agents: { "nokey": { on: true, why: "set" }, "s/p": { on: "yes", why: "set" }, "s/q": { on: false, why: "set", firstSeen: 3 } } }))
      .toEqual({ agents: { "s/q": { on: false, why: "set", firstSeen: 3 } }, seeded: [] });
  });
});

// End to end at the push decision point: the store decides, the coordinator obeys.
describe("a muted agent produces no push", () => {
  test("a new ordinary agent is off by default and its finish never reaches the sink; a supervisor's does", () => {
    const { s } = store();
    const herd = [pane("w1:p1", "/home/you/.firstmate/awam"), pane("w1:p2", "/home/you/.firstmate/awam/projects/shop")];
    s.reconcile("default", herd);
    const timers: Array<() => void> = [];
    const clock: NotifyClock<number> = { schedule: (fn) => timers.push(fn), cancel: () => {} };
    const renders: AgentNotice[] = [];
    const policy = { maybe: () => true, wants: () => true, agentOn: (paneId: string) => s.on("default", paneId) };
    const coord = new NotificationCoordinator(clock, { render: (n) => (renders.push(n), "sent") }, 0, policy);
    for (const agent of herd) coord.onTransition({ ...agent, status: "done" }, "working", "done");
    for (const fire of timers.splice(0)) fire();
    expect(renders.map((n) => n.paneId)).toEqual(["w1:p1"]);
    // Switched on from the ⋯ menu or the terminal, it pushes like any other.
    s.set("default", "w1:p2", true);
    coord.onTransition({ ...herd[1]!, status: "blocked" }, "working", "blocked");
    for (const fire of timers.splice(0)) fire();
    expect(renders.map((n) => n.paneId)).toEqual(["w1:p1", "w1:p2"]);
  });
});

describe("parseAgentNotify", () => {
  test("takes a pane id and a boolean, nothing else", () => {
    expect(parseAgentNotify({ paneId: "w1:p2", on: false })).toEqual({ paneId: "w1:p2", on: false });
    expect(parseAgentNotify({ paneId: "w1:p2", on: "false" })).toBeNull();
    expect(parseAgentNotify({ paneId: "", on: true })).toBeNull();
    expect(parseAgentNotify({ paneId: "x".repeat(129), on: true })).toBeNull();
    expect(parseAgentNotify(null)).toBeNull();
  });
});

// herdr-core (COLLIE_HC_CORE) runs as its own session, `hc`, through the same startSession: its
// agents get the same switch, keyed by that session, so a pane id that also exists in Herdr 1 never
// shares one. The panes here come from hcSnapshot, the shapes `hc connect` returns.
describe("herdr-core agents", () => {
  const terminal = (address: string, cwd: string): HcTerminal =>
    ({ address, state: "live", cwd, status: { app: "claude-code", state: "idle" }, foreground: null });
  const hcHerd = hcSnapshot([terminal("t6", "/home/you/.firstmate/awam"), terminal("box:t2", "/home/you/.firstmate/awam/projects/shop")], new Map())
    .panes.map((p) => pane(p.pane_id, p.cwd!, { workspaceId: p.workspace_id, agent: p.agent ?? "claude" }));

  test("the folder rule decides a new herdr-core agent, keyed apart from a Herdr pane with the same id", () => {
    const { s } = store(undefined, DEFAULT_SUPERVISOR_PATTERNS, { now: 1_000 });
    s.reconcile("hc", hcHerd);
    s.reconcile("default", [pane("t6", "/work/shop")]);
    expect(hcHerd.map((a) => a.paneId)).toEqual(["t6", "box:t2"]);
    expect(s.on("hc", "t6")).toBe(true);
    expect(s.on("hc", "box:t2")).toBe(false);
    expect(s.on("default", "t6")).toBe(false);
    s.set("hc", "t6", false);
    expect(s.on("hc", "t6")).toBe(false);
    expect(s.list().find((r) => r.session === "default" && r.paneId === "t6")?.why).toBe("new");
  });

  test("turning herdr-core on later seeds its first herd on, like an upgrade", () => {
    const file = fileIn();
    writeFileSync(file, JSON.stringify({ agents: {}, seeded: ["default"] }));
    const s = new AgentNotifyStore(file, DEFAULT_SUPERVISOR_PATTERNS, () => 1, HOME);
    s.reconcile("hc", hcHerd);
    expect(s.on("hc", "box:t2")).toBe(true);
    expect(s.list().every((r) => r.why === "existing")).toBe(true);
  });

  test("a muted herdr-core agent never reaches the sink, unmuted it does, and Herdr 1's pane is untouched", () => {
    const { s } = store(undefined, ["**"]);
    s.reconcile("hc", hcHerd);
    s.reconcile("default", [pane("t6", "/work/shop")]);
    s.set("hc", "t6", false);
    const timers: Array<() => void> = [];
    const clock: NotifyClock<number> = { schedule: (fn) => timers.push(fn), cancel: () => {} };
    const sent: string[] = [];
    const coordinator = (session: string) => new NotificationCoordinator(clock, { render: (n) => (sent.push(`${session}/${n.paneId}`), "sent") }, 0,
      { maybe: () => true, wants: () => true, agentOn: (paneId) => s.on(session, paneId) });
    const hc = coordinator("hc");
    const herdr = coordinator("default");
    const done = (a: AgentView) => ({ ...a, status: "done" as const });
    hc.onTransition(done(hcHerd[0]!), "working", "done");
    herdr.onTransition(done(pane("t6", "/work/shop")), "working", "done");
    for (const fire of timers.splice(0)) fire();
    expect(sent).toEqual(["default/t6"]);
    s.set("hc", "t6", true);
    hc.onTransition({ ...hcHerd[0]!, status: "blocked" }, "working", "blocked");
    for (const fire of timers.splice(0)) fire();
    expect(sent).toEqual(["default/t6", "hc/t6"]);
  });
});
