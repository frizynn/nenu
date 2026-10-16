import { describe, expect, test } from "bun:test";

import type { AlertDetail } from "./alert-detail.ts";
import {
  decisionLine,
  interactionAlert,
  NotificationCoordinator,
  makeNotifySink,
  type AgentNotice,
  type NoticeDecision,
  type NotifyClock,
  type NotifySink,
} from "./notifications.ts";
import type { PushMessage } from "./push.ts";
import type { AgentStatus, AgentView, Interaction } from "./types.ts";

// The coordinator decides whether/when a blocked/done transition becomes a push, and collapses the
// herd into a single summary. We drive it with a fake clock (fire timers on demand) and a recording
// sink, so every debounce / coalesce / retract path is exercised purely — no Bun.serve, no web-push.

class FakeClock implements NotifyClock<number> {
  private readonly timers = new Map<number, () => void>();
  private next = 1;
  schedule(fn: () => void, _delayMs: number): number {
    const id = this.next++;
    this.timers.set(id, fn);
    return id;
  }
  cancel(handle: number): void {
    this.timers.delete(handle);
  }
  /** Fire every still-armed timer (a cancelled one was already removed). */
  fireAll(): void {
    const fns = [...this.timers.values()];
    this.timers.clear();
    for (const fn of fns) fn();
  }
  get armed(): number {
    return this.timers.size;
  }
}

class RecordingSink implements NotifySink {
  readonly renders: AgentNotice[] = [];
  render(notice: AgentNotice) {
    this.renders.push(notice);
    return "sent" as const;
  }
  get last(): AgentNotice | undefined {
    return this.renders.at(-1);
  }
}

function agentNamed(paneId: string, name: string, status: AgentStatus): AgentView {
  return {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "demo",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    paneLabel: name,
    status,
    cwd: "/home/you/demo",
    focused: false,
    kind: "agent",
  };
}
const agent = (paneId: string, status: AgentStatus) => agentNamed(paneId, "api", status);

// `prefs` is a live, mutable object the injected policy reads on every call — so a test can flip a
// preference and call `coord.applyPrefs()` to exercise the runtime-change path. A test can pass
// `describe` to stand in for the bridge's project + journal lookup, and `seen` for Nenu's ledger.
function setup(
  prefs: { blocked: boolean; done: boolean; subagents?: boolean } = { blocked: true, done: true },
  describe?: (agent: AgentView, status: "blocked" | "done") => AlertDetail | Promise<AlertDetail>,
  seen: Record<string, number> = {},
) {
  const clock = new FakeClock();
  const sink = new RecordingSink();
  const live = { subagents: false, ...prefs };
  const policy = {
    maybe: (s: AgentStatus): boolean => (s === "blocked" ? live.blocked : s === "done" ? live.done || live.subagents : false),
    wants: (d: AlertDetail): boolean => (d.status === "blocked" ? live.blocked : d.startedBy === "subagent" ? live.subagents : live.done),
  };
  let now = 1_000;
  const coord = new NotificationCoordinator(clock, sink, 30_000, policy, describe, (paneId) => seen[paneId], () => now);
  return { clock, sink, coord, prefs: live, seen, tick: (ms: number) => (now += ms) };
}

/** Let an asynchronous describe answer. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("NotificationCoordinator — debounce", () => {
  test("does not render until the debounce window elapses, then renders once", () => {
    const { clock, sink, coord } = setup();
    coord.onTransition(agent("p1", "blocked"), "working", "blocked");
    expect(sink.renders).toEqual([]);
    clock.fireAll();
    expect(sink.last).toEqual({ title: "api needs you", body: "demo", paneId: "p1", renotify: true });
  });

  test("cancels an alert that resolves before the window elapses (handled at the desk)", () => {
    const { clock, sink, coord } = setup();
    coord.onTransition(agent("p1", "blocked"), "working", "blocked");
    coord.onTransition(agent("p1", "working"), "blocked", "working");
    clock.fireAll();
    expect(sink.renders).toEqual([]);
    expect(clock.armed).toBe(0);
  });

  test("'done' uses the 'finished' verb", () => {
    const { clock, sink, coord } = setup();
    coord.onTransition(agent("p1", "done"), "working", "done");
    clock.fireAll();
    expect(sink.last?.title).toBe("api finished");
  });
});

describe("NotificationCoordinator — one notification per agent, sent once", () => {
  test("two agents get two notifications, each naming its own agent", () => {
    const { clock, sink, coord } = setup();
    coord.onTransition(agentNamed("p1", "api", "blocked"), "working", "blocked");
    coord.onTransition(agentNamed("p2", "web", "done"), "working", "done");
    clock.fireAll();
    expect(sink.renders.map((n) => n.title)).toEqual(["api needs you", "web finished"]);
  });

  test("handling an agent sends nothing: iOS revokes a subscription after a few pushes that show nothing", () => {
    const { clock, sink, coord } = setup();
    coord.onTransition(agent("p1", "blocked"), "working", "blocked");
    clock.fireAll();
    coord.onTransition(agent("p1", "idle"), "blocked", "idle");
    coord.onRemove("p1");
    coord.clearAll();
    expect(sink.renders).toHaveLength(1);
  });

  test("an agent that finishes again before you looked in Nenu does not notify again", () => {
    const { clock, sink, coord, seen, tick } = setup();
    coord.onTransition(agent("p1", "done"), "working", "done");
    clock.fireAll();
    tick(60_000);
    coord.onTransition(agent("p1", "working"), "done", "working");
    coord.onTransition(agent("p1", "done"), "working", "done");
    clock.fireAll();
    expect(sink.renders).toHaveLength(1);
    // Once you have looked at it, its next finish notifies again.
    seen.p1 = 2_000_000;
    tick(60_000);
    coord.onTransition(agent("p1", "working"), "done", "working");
    tick(10_000_000);
    coord.onTransition(agent("p1", "done"), "working", "done");
    clock.fireAll();
    expect(sink.renders).toHaveLength(2);
  });

  test("an alert held back while Nenu was open told nobody: the agent's next finish still notifies", () => {
    // The sink sends nothing while a screen has Nenu open (ADR 0072), so that first finish never
    // reached the phone, and "once until you look" has nothing to count yet.
    class OpenScreenSink implements NotifySink {
      open = true;
      readonly sent: AgentNotice[] = [];
      render(notice: AgentNotice) {
        if (this.open) return "open" as const;
        this.sent.push(notice);
        return "sent" as const;
      }
    }
    const clock = new FakeClock();
    const sink = new OpenScreenSink();
    const policy = { maybe: () => true, wants: () => true };
    let now = 1_000;
    const coord = new NotificationCoordinator(clock, sink, 30_000, policy, undefined, () => undefined, () => now);
    coord.onTransition(agent("p1", "done"), "working", "done");
    clock.fireAll();
    sink.open = false;
    now += 60_000;
    coord.onTransition(agent("p1", "working"), "done", "working");
    coord.onTransition(agent("p1", "done"), "working", "done");
    clock.fireAll();
    expect(sink.sent.map((n) => n.title)).toEqual(["api finished"]);
  });

  test("a finished agent that then waits on you still says so", () => {
    const { clock, sink, coord } = setup();
    coord.onTransition(agent("p1", "done"), "working", "done");
    clock.fireAll();
    coord.onTransition(agent("p1", "blocked"), "done", "blocked");
    clock.fireAll();
    expect(sink.renders.map((n) => n.title)).toEqual(["api finished", "api needs you"]);
  });
});

describe("NotificationCoordinator — type preferences", () => {
  test("with done off, a done transition never pushes — even after the window", () => {
    const { clock, sink, coord } = setup({ blocked: true, done: false });
    coord.onTransition(agent("p1", "done"), "working", "done");
    expect(clock.armed).toBe(0);
    clock.fireAll();
    expect(sink.renders).toEqual([]);
  });

  test("with blocked disabled, a blocked transition doesn't push", () => {
    const { clock, sink, coord } = setup({ blocked: false, done: true });
    coord.onTransition(agent("p1", "blocked"), "working", "blocked");
    expect(clock.armed).toBe(0);
    clock.fireAll();
    expect(sink.renders).toEqual([]);
  });

  test("disabling a kind at runtime cancels a still-pending alert of that kind", () => {
    const { clock, sink, coord, prefs } = setup({ blocked: true, done: true });
    coord.onTransition(agent("p1", "done"), "working", "done");
    prefs.done = false;
    coord.applyPrefs();
    expect(clock.armed).toBe(0);
    clock.fireAll();
    expect(sink.renders).toEqual([]);
  });
});

describe("NotificationCoordinator — who, what and where", () => {
  const thread = (status: "blocked" | "done", over: Partial<AlertDetail> = {}): AlertDetail => ({
    status, kind: "thread", startedBy: "person", requested: false, launched: false, name: "t-0093 Wholesale orders", where: "Acme Shop", ...over,
  });

  test("a finished thread is named by its title and says what it answered, then where", async () => {
    const { clock, sink, coord } = setup(undefined, async (_a, status) => thread(status, { summary: "El HTML de avance ya está abierto." }));
    coord.onTransition(agent("p1", "done"), "working", "done");
    clock.fireAll();
    await settle();
    expect(sink.last).toEqual({ title: "t-0093 Wholesale orders finished", body: "El HTML de avance ya está abierto.\nAcme Shop", paneId: "p1", renotify: true });
  });

  test("a turn a subagent's result started stays quiet while Subagents is off", async () => {
    const { clock, sink, coord, prefs } = setup(undefined, (_a, status) => thread(status, { startedBy: "subagent" }));
    coord.onTransition(agent("p1", "done"), "working", "done");
    clock.fireAll();
    await settle();
    expect(sink.renders).toEqual([]);
    prefs.subagents = true;
    coord.onTransition(agent("p2", "done"), "working", "done");
    clock.fireAll();
    await settle();
    expect(sink.last?.title).toBe("t-0093 Wholesale orders got a subagent's result");
  });

  test("an alert resolved while it was being described never shows", async () => {
    let answer: (d: AlertDetail) => void = () => {};
    const { clock, sink, coord } = setup(undefined, () => new Promise<AlertDetail>((resolve) => (answer = resolve)));
    coord.onTransition(agent("p1", "done"), "working", "done");
    clock.fireAll();
    coord.onTransition(agent("p1", "working"), "done", "working");
    answer(thread("done"));
    await settle();
    expect(sink.renders).toEqual([]);
  });
});

describe("NotificationCoordinator — every decision is logged", () => {
  test("says what it did with each alert and why, naming no one's words", () => {
    const clock = new FakeClock();
    const decisions: NoticeDecision[] = [];
    let open = true;
    const sink: NotifySink = { render: () => (open ? "open" : "sent") };
    // Settings as shipped: an agent another agent launched does not push.
    const policy = { maybe: () => true, wants: (d: AlertDetail) => !d.launched };
    const describe = (view: AgentView, status: "blocked" | "done"): AlertDetail =>
      ({ status, kind: "agent", name: view.paneLabel ?? "", where: "", startedBy: "person", requested: false, launched: view.paneId === "p2", summary: "secret words" });
    let now = 1_000;
    const coord = new NotificationCoordinator(clock, sink, 30_000, policy, describe, () => undefined, () => now, (d) => decisions.push(d));
    coord.onTransition(agent("p1", "done"), "working", "done");
    coord.onTransition(agent("p2", "done"), "working", "done");
    clock.fireAll();
    open = false;
    now += 60_000;
    coord.onTransition(agent("p1", "working"), "done", "working");
    coord.onTransition(agent("p1", "done"), "working", "done");
    clock.fireAll();
    coord.onTransition(agent("p1", "working"), "done", "working");
    coord.onTransition(agent("p1", "done"), "working", "done");
    clock.fireAll();
    expect(decisions.map((d) => decisionLine("main", d))).toEqual([
      "notify main/p1 done (agent, started by person): not sent, Nenu is open on a screen",
      "notify main/p2 done (agent, started by person, launched by an agent): not sent, no switch on in Settings pushes this turn",
      "notify main/p1 done (agent, started by person): sent",
      "notify main/p1 done (agent, started by person): not sent, it already notified and nobody has opened it since",
    ]);
  });
});

describe("makeNotifySink", () => {
  const notice: AgentNotice = { title: "api needs you", body: "demo", paneId: "w1:p1", renotify: true };
  class RecordingPush {
    readonly sent: PushMessage[] = [];
    send(msg: PushMessage): void {
      this.sent.push(msg);
    }
  }

  test("each agent's notice is its own push, tagged by its pane", () => {
    const push = new RecordingPush();
    expect(makeNotifySink(push, { muted: () => null }, "collie:herd").render(notice)).toBe("sent");
    expect(push.sent).toEqual([{ title: "api needs you", body: "demo", tag: "collie:herd:w1:p1", paneId: "w1:p1", renotify: true }]);
  });

  test("a snooze, or Nenu open on a screen, sends nothing at all, and says which held it back", () => {
    const push = new RecordingPush();
    expect(makeNotifySink(push, { muted: () => "snoozed" }, "collie:herd").render(notice)).toBe("snoozed");
    expect(makeNotifySink(push, { muted: () => "open" }, "collie:herd").render(notice)).toBe("open");
    expect(push.sent).toEqual([]);
  });
});

describe("interactionAlert", () => {
  const card = (over: Partial<Interaction> = {}): Interaction => ({
    paneId: "p1", agent: "claude", kind: "permission", family: "permission", question: "Do you want to proceed?",
    context: "mkfifo fixture-fifo", signature: "sig", revision: 0, detectedAt: 0, detailComplete: true,
    options: [
      { index: 0, label: "Yes", role: "primary" },
      { index: 1, label: "Yes, and always allow access", role: "persistent" },
      { index: 2, label: "No", role: "deny" },
    ],
    ...over,
  });
  const alert: PushMessage = { title: "claude needs you", body: "demo · /tmp", tag: "collie:herd", paneId: "p1", renotify: true };

  test("the question and the full command become the body, with the one-tap answers", () => {
    expect(interactionAlert(alert, card())).toEqual({
      ...alert,
      body: "Do you want to proceed?\nmkfifo fixture-fifo",
      interaction: { signature: "sig", actions: [{ optionIndex: 0, title: "Yes" }, { optionIndex: 2, title: "No" }] },
    });
  });

  test("a command that does not fit is cut, and then nothing can be approved from the notification", () => {
    const long = interactionAlert(alert, card({ context: "x".repeat(400) }));
    expect(long.body!.length).toBe(300);
    expect(long.interaction?.actions).toEqual([]);
  });

  test("an incomplete permission shows its question but offers no actions", () => {
    expect(interactionAlert(alert, card({ detailComplete: false })).interaction?.actions).toEqual([]);
  });
});
