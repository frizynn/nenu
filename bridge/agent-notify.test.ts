import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENT_NOTIFY_FORGET_MS, AgentNotifyStore, coerce, isSupervisor, matchesFolder } from "./agent-notify.ts";
import type { AlertDetail } from "./alert-detail.ts";
import type { Config } from "./config.ts";
import { hcSnapshot, type HcTerminal } from "./hc-core.ts";
import { NotificationCoordinator, type NoticeDecision, type NotifyClock, type NotifyPolicy } from "./notifications.ts";
import { NotifyPrefsStore } from "./notify-prefs.ts";
import { parseAgentNotify } from "./routes/settings.ts";
import type { AgentStatus, AgentView } from "./types.ts";

const HOME = "/home/you";
const FIRSTMATE = ["~/.firstmate/*", "~/Developer/firstmate"];
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function dirIn(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-notify-"));
  dirs.push(dir);
  return dir;
}
const fileIn = () => join(dirIn(), "agent-notify.json");

function pane(paneId: string, cwd: string, extra: Partial<AgentView> = {}): AgentView {
  return { paneId, workspaceId: "w1", workspaceLabel: "demo", workspaceNumber: 1, tabId: "w1:t1", agent: "claude", status: "idle", cwd, focused: false, ...extra };
}

/** A store past its first run (its sessions already seeded), with these supervisor folders set. */
function store(supervisors: string[] = [], file = fileIn(), clock = { now: 1_000 }) {
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({ agents: {}, seeded: ["default", "a", "b", "hc"], supervisors }));
  return { s: new AgentNotifyStore(file, () => clock.now, HOME), file, clock };
}

// herdr-core panes as hcSnapshot builds them from `hc connect`'s shapes.
const terminal = (address: string, cwd: string): HcTerminal =>
  ({ address, state: "live", cwd, status: { app: "claude-code", state: "idle" }, foreground: null });
const hcHerd = hcSnapshot([terminal("t6", "/home/you/.firstmate/awam"), terminal("box:t2", "/home/you/.firstmate/awam/projects/shop")], new Map())
  .panes.map((p) => pane(p.pane_id, p.cwd!, { workspaceId: p.workspace_id, agent: p.agent ?? "claude" }));

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
  test("with no supervisor folders set, every new agent starts on", () => {
    const { s } = store();
    s.reconcile("default", [pane("w1:p1", "/home/you/.firstmate/awam"), pane("w1:p2", "/home/you/.firstmate/awam/projects/shop"), pane("w1:p3", "/tmp")]);
    expect(s.supervisors()).toEqual([]);
    expect(s.list().map((r) => [r.paneId, r.on, r.why])).toEqual([["w1:p1", true, "new"], ["w1:p2", true, "new"], ["w1:p3", true, "new"]]);
  });

  test("with supervisor folders set, a new agent starts on only in one", () => {
    const { s } = store(FIRSTMATE);
    s.reconcile("default", [
      pane("w1:p1", "/home/you/.firstmate/awam"),
      pane("w1:p2", "/home/you/.firstmate/awam/projects/shop"),
      pane("w1:p3", "/home/you/Developer/firstmate"),
    ]);
    expect(s.list().map((r) => [r.paneId, r.on, r.why])).toEqual([["w1:p1", true, "supervisor"], ["w1:p2", false, "new"], ["w1:p3", true, "supervisor"]]);
  });

  test("setting or clearing the folders changes no switch already decided, only agents seen afterwards", () => {
    const { s } = store();
    s.reconcile("default", [pane("w1:p1", "/work/shop")]);
    expect(s.setSupervisors([" ~/.firstmate/* ", "", "~/.firstmate/*"])).toEqual(["~/.firstmate/*"]);
    s.reconcile("default", [pane("w1:p1", "/work/shop"), pane("w1:p2", "/work/shop")]);
    expect(s.on("default", "w1:p1")).toBe(true);
    expect(s.on("default", "w1:p2")).toBe(false);
    s.setSupervisors([]);
    s.reconcile("default", [pane("w1:p1", "/work/shop"), pane("w1:p2", "/work/shop"), pane("w1:p3", "/work/shop")]);
    expect(s.on("default", "w1:p2")).toBe(false);
    expect(s.on("default", "w1:p3")).toBe(true);
  });

  test("folders set from the terminal reach the running bridge on its next look", () => {
    const { s, file } = store();
    new AgentNotifyStore(file, () => 5, HOME).setSupervisors(FIRSTMATE);
    expect(s.supervisors()).toEqual(FIRSTMATE);
    s.reconcile("default", [pane("w1:p1", "/work/shop")]);
    expect(s.on("default", "w1:p1")).toBe(false);
  });

  test("on a session's first herd every agent keeps pushing, even with folders set", () => {
    const file = fileIn();
    const s = new AgentNotifyStore(file, () => 1, HOME);
    s.setSupervisors(FIRSTMATE);
    s.reconcile("default", [pane("w1:p1", "/work/shop")]);
    expect(s.on("default", "w1:p1")).toBe(true);
    expect(s.list()[0]?.why).toBe("existing");
    s.reconcile("default", [pane("w1:p1", "/work/shop"), pane("w1:p2", "/work/shop")]);
    expect(s.on("default", "w1:p2")).toBe(false);
    expect(s.sessions()).toEqual(["default"]);
  });

  test("a terminal command run before the bridge's first start does not cost the upgrade its seeding", () => {
    const file = fileIn();
    const terminal = new AgentNotifyStore(file, () => 1, HOME);
    terminal.setSupervisors(FIRSTMATE);
    terminal.set("default", "w1:p9", false);
    const bridge = new AgentNotifyStore(file, () => 2, HOME);
    bridge.reconcile("default", [pane("w1:p1", "/work/shop"), pane("w1:p9", "/work/shop")]);
    expect(bridge.on("default", "w1:p1")).toBe(true);
    expect(bridge.on("default", "w1:p9")).toBe(false);
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
    const { s, file } = store(FIRSTMATE);
    s.reconcile("default", [pane("w1:p1", "/home/you/.firstmate/awam"), pane("w1:p2", "/work/shop")]);
    s.set("default", "w1:p1", false);
    s.set("default", "w1:p2", true);
    const again = new AgentNotifyStore(file, () => 5, HOME);
    again.reconcile("default", [pane("w1:p1", "/home/you/.firstmate/awam"), pane("w1:p2", "/work/shop")]);
    expect(again.on("default", "w1:p1")).toBe(false);
    expect(again.on("default", "w1:p2")).toBe(true);
    expect(again.list().every((r) => r.why === "set")).toBe(true);
  });

  test("an agent never seen may push until the herd decides it", () => {
    const { s } = store(FIRSTMATE);
    expect(s.on("default", "w1:p9")).toBe(true);
  });

  test("an agent that leaves is kept a week, so a restored pane keeps its switch, then forgotten", () => {
    const { s, clock } = store();
    s.reconcile("default", [pane("w1:p1", "/work/shop")]);
    s.set("default", "w1:p1", false);
    clock.now += 1_000;
    s.reconcile("default", []);
    expect(s.list()[0]?.gone).toBe(clock.now);
    s.reconcile("default", [pane("w1:p1", "/work/shop")]);
    expect(s.list()[0]).toMatchObject({ on: false, why: "set" });
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

  test("a switch written by the terminal command is read on the bridge's next look", () => {
    const { s, file } = store();
    s.reconcile("default", [pane("w1:p1", "/work/shop")]);
    new AgentNotifyStore(file, () => 9, HOME).set("default", "w1:p1", false);
    expect(s.on("default", "w1:p1")).toBe(false);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("a file it cannot read keeps what it had; junk is dropped", () => {
    const { s, file } = store();
    s.reconcile("default", [pane("w1:p1", "/work/shop")]);
    s.set("default", "w1:p1", false);
    writeFileSync(file, "{not json");
    expect(s.on("default", "w1:p1")).toBe(false);
    expect(coerce({ supervisors: ["~/a", 3, ""], agents: { "nokey": { on: true, why: "set" }, "s/p": { on: "yes", why: "set" }, "s/q": { on: false, why: "set", firstSeen: 3 } } }))
      .toEqual({ agents: { "s/q": { on: false, why: "set", firstSeen: 3 } }, seeded: [], supervisors: ["~/a"] });
  });
});

describe("herdr-core agents", () => {
  test("the folder rule decides a new herdr-core agent, keyed apart from a Herdr pane with the same id", () => {
    const { s } = store(FIRSTMATE);
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
    writeFileSync(file, JSON.stringify({ agents: {}, seeded: ["default"], supervisors: FIRSTMATE }));
    const s = new AgentNotifyStore(file, () => 1, HOME);
    s.reconcile("hc", hcHerd);
    expect(s.on("hc", "box:t2")).toBe(true);
    expect(s.list().every((r) => r.why === "existing")).toBe(true);
  });

  test("a muted herdr-core agent never reaches the sink, unmuted it does, and Herdr 1's pane is untouched", () => {
    const { s } = store();
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
    hc.onTransition({ ...hcHerd[0]!, status: "done" }, "working", "done");
    herdr.onTransition({ ...pane("t6", "/work/shop"), status: "done" }, "working", "done");
    for (const fire of timers.splice(0)) fire();
    expect(sent).toEqual(["default/t6"]);
    s.set("hc", "t6", true);
    hc.onTransition({ ...hcHerd[0]!, status: "blocked" }, "working", "blocked");
    for (const fire of timers.splice(0)) fire();
    expect(sent).toEqual(["default/t6", "hc/t6"]);
  });
});

describe("a muted agent produces no push", () => {
  test("off from the ⋯ menu or the terminal, its finish never reaches the sink; switched back on, it does", () => {
    const { s } = store();
    const herd = [pane("w1:p1", "/work/a"), pane("w1:p2", "/work/b")];
    s.reconcile("default", herd);
    s.set("default", "w1:p2", false);
    const timers: Array<() => void> = [];
    const clock: NotifyClock<number> = { schedule: (fn) => timers.push(fn), cancel: () => {} };
    const sent: string[] = [];
    const coord = new NotificationCoordinator(clock, { render: (n) => (sent.push(n.paneId), "sent") }, 0,
      { maybe: () => true, wants: () => true, agentOn: (paneId) => s.on("default", paneId) });
    for (const agent of herd) coord.onTransition({ ...agent, status: "done" }, "working", "done");
    for (const fire of timers.splice(0)) fire();
    expect(sent).toEqual(["w1:p1"]);
    s.set("default", "w1:p2", true);
    coord.onTransition({ ...herd[1]!, status: "blocked" }, "working", "blocked");
    for (const fire of timers.splice(0)) fire();
    expect(sent).toEqual(["w1:p1", "w1:p2"]);
  });
});

// With nothing configured, nothing changes from 2.12.0: no agent is muted, and every push decision is
// the one 2.12.0's coordinator made with the same kind switches (its policy had no agent switch at all).
describe("no regressions with no configuration", () => {
  test("an install upgrading from 2.12.0 mutes nobody: Herdr 1 and herdr-core, there before and new after", () => {
    const s = new AgentNotifyStore(fileIn(), () => 1, HOME);
    s.reconcile("default", [pane("w1:p1", "/home/you/.firstmate/awam/projects/shop"), pane("w1:p2", "/tmp")]);
    s.reconcile("hc", hcHerd);
    s.reconcile("default", [pane("w1:p1", "/home/you/.firstmate/awam/projects/shop"), pane("w1:p2", "/tmp"), pane("w1:p3", "/srv/x")]);
    s.reconcile("hc", [...hcHerd, pane("t7", "/srv/y")]);
    expect(s.list()).toHaveLength(6);
    expect(s.list().every((r) => r.on)).toBe(true);
    for (const [session, paneId] of [["default", "w1:p1"], ["default", "w1:p3"], ["hc", "box:t2"], ["hc", "t7"], ["hc", "never-seen"]] as const) {
      expect(s.on(session, paneId)).toBe(true);
    }
  });

  test("push decisions under every kind switch are 2.12.0's, for Herdr 1 and herdr-core alike", async () => {
    const prefs = new NotifyPrefsStore({ stateDir: dirIn() } as Config);
    const s = new AgentNotifyStore(fileIn(), () => 1, HOME);
    const herd = { default: [pane("w1:p1", "/work/a"), pane("w1:p2", "/work/b", { agentName: "helper" })], hc: hcHerd };
    for (const [session, agents] of Object.entries(herd)) s.reconcile(session, agents);
    // Each alert's turn, as the journal would describe it: a person, a subagent's result, a launched agent.
    const describeAs = (agent: AgentView, status: "blocked" | "done"): AlertDetail => ({
      status, name: agent.paneId, where: "demo", requested: false,
      startedBy: agent.paneId === "box:t2" ? "subagent" : "person", launched: agent.agentName !== undefined,
    });
    const run = (policyFor: (session: string) => NotifyPolicy) => {
      const timers: Array<() => void> = [];
      const clock: NotifyClock<number> = { schedule: (fn) => timers.push(fn), cancel: () => {} };
      const decisions: string[] = [];
      for (const [session, agents] of Object.entries(herd)) {
        const coord = new NotificationCoordinator(clock, { render: () => "sent" }, 0, policyFor(session), describeAs,
          () => undefined, () => 1, (d: NoticeDecision) => decisions.push(`${session}/${d.paneId} ${d.alert.status} ${d.outcome}`));
        for (const agent of agents) for (const to of ["done", "blocked"] as AgentStatus[]) coord.onTransition({ ...agent, status: to }, "working", to);
      }
      for (const fire of timers.splice(0)) fire();
      return decisions;
    };
    const v2_12 = () => ({ maybe: (st: AgentStatus) => prefs.maybe(st), wants: (a: AlertDetail) => prefs.wants(a), agentOn: () => true });
    const now = (session: string) => ({ ...v2_12(), agentOn: (paneId: string) => s.on(session, paneId) });
    for (const kinds of [{}, { blocked: false }, { replies: false }, { launched: true, subagents: true }, { blocked: false, replies: false, launched: false, subagents: false }]) {
      await prefs.set({ blocked: true, replies: true, launched: false, subagents: false, ...kinds });
      const before = run(v2_12);
      expect(run(now)).toEqual(before);
      // With the shipped kinds, every agent's finish and block reaches a decision worth comparing.
      if (Object.keys(kinds).length === 0) expect(before.filter((d) => d.endsWith(" sent")).length).toBeGreaterThan(0);
    }
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
