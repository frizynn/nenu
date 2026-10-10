import { describe, expect, test } from "bun:test";

import { buildSubscriptions, EventPoker, type OutputMatched, sameIdSet, type Subscription } from "./event-poker.ts";
import type { HerdrClient } from "./herdr-client.ts";

// EventPoker owns the stream lifecycle (ack → healthy, events → debounced poke, down → backoff
// reconnect). The socket itself lives in HerdrClient.subscribeEvents and stays untested; here we
// fake it so tests drive ack/event/down synchronously and assert the decisions.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// The protocol probe resolves on a microtask, so the stream opens one tick after connect.
const tick = () => sleep(0);

interface FakeStream {
  subscriptions: Subscription[];
  onUp: () => void;
  onEvent: (event: string, data: unknown) => void;
  onDown: (reason: string, code?: string) => void;
  closed: boolean;
}

class FakeClient {
  readonly streams: FakeStream[] = [];
  probes = 0;
  constructor(public protocol: number | Error = 22) {}
  serverInfo() {
    this.probes++;
    const p = this.protocol;
    return p instanceof Error ? Promise.reject(p) : Promise.resolve({ version: "0.9.1", protocol: p });
  }
  subscribeEvents(opts: {
    subscriptions: Subscription[];
    onUp: () => void;
    onEvent: (event: string, data: unknown) => void;
    onDown: (reason: string, code?: string) => void;
  }): { close(): void } {
    const stream: FakeStream = { ...opts, closed: false };
    this.streams.push(stream);
    return {
      close: () => {
        if (stream.closed) return;
        stream.closed = true;
        stream.onDown("closed");
      },
    };
  }
  get last(): FakeStream {
    const s = this.streams[this.streams.length - 1];
    if (!s) throw new Error("no stream");
    return s;
  }
}

function makePoker(opts?: { debounceMs?: number; backoffMs?: number[]; protocol?: number | Error }) {
  const client = new FakeClient(opts?.protocol);
  const poker = new EventPoker(client as unknown as HerdrClient, {
    debounceMs: opts?.debounceMs ?? 10,
    backoffMs: opts?.backoffMs ?? [10, 20],
  });
  const pokes: number[] = [];
  const health: boolean[] = [];
  poker.onPoke(() => pokes.push(1));
  poker.onHealth((h) => health.push(h));
  return { client, poker, pokes, health };
}

describe("buildSubscriptions / sameIdSet", () => {
  test("emits the global set (no layout/worktree/scroll/output) plus one scoped status sub per pane", () => {
    const subs = buildSubscriptions(["w1:p1", "w2:p3"]);
    const types = subs.map((s) => s.type);
    expect(types).toContain("pane.created");
    expect(types).toContain("pane.agent_detected");
    expect(types).toContain("workspace.focused");
    expect(types).not.toContain("layout.updated");
    expect(types).not.toContain("pane.scroll_changed");
    expect(types).not.toContain("pane.output_matched");
    const scoped = subs.filter((s) => s.type === "pane.agent_status_changed");
    expect(scoped).toEqual([
      { type: "pane.agent_status_changed", pane_id: "w1:p1" },
      { type: "pane.agent_status_changed", pane_id: "w2:p3" },
    ]);
    // Globals are unscoped.
    expect(subs.find((s) => s.type === "pane.created")?.pane_id).toBeUndefined();
  });

  test("sameIdSet ignores order and duplicates", () => {
    expect(sameIdSet(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameIdSet(["a", "a", "b"], ["a", "b"])).toBe(true);
    expect(sameIdSet(["a"], ["a", "b"])).toBe(false);
    expect(sameIdSet([], [])).toBe(true);
  });
});

describe("EventPoker — health", () => {
  test("goes healthy on ack and unhealthy on down, notifying each transition once", async () => {
    const { client, poker, health } = makePoker();
    poker.start();
    await tick();
    expect(client.streams.length).toBe(1);
    client.last.onUp();
    client.last.onUp(); // duplicate ack — no second notify
    expect(health).toEqual([true]);
    client.last.onDown("socket error");
    expect(health).toEqual([true, false]);
    poker.stop();
  });
});

describe("EventPoker — debounced poke", () => {
  test("coalesces a burst of events into a single trailing poke", async () => {
    const { client, poker, pokes } = makePoker({ debounceMs: 10 });
    poker.start();
    await tick();
    client.last.onUp();
    client.last.onEvent("pane_created", {});
    client.last.onEvent("pane_agent_detected", {});
    client.last.onEvent("pane_agent_detected", {});
    expect(pokes.length).toBe(0); // still within the debounce window
    await sleep(25);
    expect(pokes.length).toBe(1); // burst collapsed to one poke
    poker.stop();
  });
});

describe("EventPoker — reconnect backoff", () => {
  test("reconnects after a down per the backoff schedule and resets on the next ack", async () => {
    const { client, poker, health } = makePoker({ backoffMs: [15, 40] });
    poker.start();
    await tick();
    client.last.onUp();
    client.last.onDown("boom");
    expect(client.streams.length).toBe(1); // not yet — waiting out the backoff
    await sleep(30);
    expect(client.streams.length).toBe(2); // reconnected (first backoff step)
    client.last.onUp(); // healthy again → backoff reset
    expect(health).toEqual([true, false, true]);
    poker.stop();
  });
});

describe("EventPoker — resubscribe on pane-set change", () => {
  test("reconnects with the new scoped subscriptions and skips a no-op set", async () => {
    const { client, poker } = makePoker();
    poker.start();
    await tick();
    client.last.onUp();
    expect(client.streams.length).toBe(1);

    poker.setAgentPanes(["w1:p1"]);
    await tick();
    expect(client.streams.length).toBe(2); // resubscribed
    expect(client.streams[0]!.closed).toBe(true); // old stream torn down
    expect(
      client.last.subscriptions.some((s) => s.type === "pane.agent_status_changed" && s.pane_id === "w1:p1"),
    ).toBe(true);

    poker.setAgentPanes(["w1:p1"]); // same set — no churn
    await tick();
    expect(client.streams.length).toBe(2);
    poker.stop();
  });
});

describe("EventPoker — stop()", () => {
  test("closes the stream, cancels a pending reconnect, and never reconnects afterward", async () => {
    const { client, poker } = makePoker({ backoffMs: [10] });
    poker.start();
    await tick();
    client.last.onUp();
    client.last.onDown("boom"); // schedules a reconnect
    poker.stop();
    await sleep(30);
    expect(client.streams.length).toBe(1); // the scheduled reconnect was cancelled
  });

  test("closing an up stream on stop() does not flip health or schedule work", async () => {
    const { client, poker, health } = makePoker();
    poker.start();
    await tick();
    client.last.onUp();
    poker.stop();
    expect(client.last.closed).toBe(true); // stop() closed it
    expect(health).toEqual([true]); // the deliberate close is stale — no spurious unhealthy
    await sleep(20);
    expect(client.streams.length).toBe(1);
  });
});

describe("EventPoker — protocol gate", () => {
  const types = (s: FakeStream) => s.subscriptions.map((x) => x.type);

  test("buildSubscriptions adds the protocol-22 types only when asked", () => {
    expect(buildSubscriptions([]).map((s) => s.type)).not.toContain("pane.updated");
    const ext = buildSubscriptions([], { extended: true }).map((s) => s.type);
    for (const t of ["pane.updated", "workspace.metadata_updated", "workspace.moved", "workspace.reordered", "tab.moved"]) {
      expect(ext).toContain(t);
    }
  });

  test("subscribes to the extended types on protocol 22, and only the base list on 21", async () => {
    const modern = makePoker({ protocol: 22 });
    modern.poker.start();
    await tick();
    expect(types(modern.client.last)).toContain("pane.updated");
    expect(types(modern.client.last)).toContain("tab.moved");
    modern.poker.stop();

    const old = makePoker({ protocol: 21 });
    old.poker.start();
    await tick();
    expect(types(old.client.last)).not.toContain("pane.updated");
    expect(types(old.client.last)).not.toContain("workspace.moved");
    old.poker.stop();
  });

  test("a resubscribe while the probe is out shares it", async () => {
    const { client, poker } = makePoker({ protocol: 22 });
    poker.start();
    poker.setAgentPanes(["w1:p1"]);
    await tick();
    expect(client.probes).toBe(1);
    expect(client.streams.length).toBe(1);
    expect(client.last.subscriptions.some((s) => s.pane_id === "w1:p1")).toBe(true);
    poker.stop();
  });

  test("a server that cannot answer ping gets the base list", async () => {
    const { client, poker } = makePoker({ protocol: new Error("herdr ping: invalid_request: invalid request: unknown variant `ping`") });
    poker.start();
    await tick();
    expect(client.streams.length).toBe(1);
    expect(types(client.last)).not.toContain("pane.updated");
    poker.stop();
  });

  test("a failed probe (server unreachable) reads as down and retries on the backoff", async () => {
    const { client, poker, health } = makePoker({ protocol: new Error("herdr ping: timed out after 5000ms"), backoffMs: [10] });
    poker.start();
    await tick();
    expect(client.streams.length).toBe(0);
    client.protocol = 22;
    await sleep(25);
    expect(client.streams.length).toBe(1);
    client.last.onUp();
    expect(health).toEqual([true]);
    poker.stop();
  });

  test("a server that rejects the extended types despite its protocol falls back to the base list for good", async () => {
    const { client, poker, health } = makePoker({ protocol: 22 });
    poker.start();
    await tick();
    expect(types(client.last)).toContain("pane.updated");
    client.last.onDown("invalid_request: invalid request: unknown variant `pane.updated`", "invalid_request");
    expect(client.streams.length).toBe(2); // retried at once, no backoff
    expect(types(client.last)).not.toContain("pane.updated");
    client.last.onUp();
    poker.setAgentPanes(["w1:p1"]);
    await tick();
    expect(types(client.last)).not.toContain("pane.updated"); // remembered across resubscribes
    expect(health).toEqual([true]); // the rejected stream never counted as down
    poker.stop();
  });
});

describe("EventPoker — stream errors", () => {
  test("events_lost re-reads the herd and resubscribes at once", async () => {
    const { client, poker, pokes } = makePoker({ debounceMs: 5, backoffMs: [10_000] });
    poker.start();
    await tick();
    client.last.onUp();
    client.last.onDown("events_lost: subscriber fell behind", "events_lost");
    await tick();
    expect(client.streams.length).toBe(2); // not waiting out the 10 s backoff
    await sleep(15);
    expect(pokes.length).toBe(1);
    poker.stop();
  });

  test("pane_not_found pokes a fresh poll, whose pane set resubscribes", async () => {
    const { client, poker, pokes } = makePoker({ debounceMs: 5, backoffMs: [10_000] });
    poker.setAgentPanes(["w1:p1", "w1:gone"]);
    poker.start();
    await tick();
    client.last.onDown("pane_not_found: pane w1:gone not found", "pane_not_found");
    await sleep(15);
    expect(pokes.length).toBe(1);
    expect(client.streams.length).toBe(1); // waiting for the poll, not hammering
    poker.setAgentPanes(["w1:p1"]); // what the poke's snapshot reports
    await tick();
    expect(client.streams.length).toBe(2);
    expect(client.last.subscriptions.some((s) => s.pane_id === "w1:gone")).toBe(false);
    poker.stop();
  });
});

describe("EventPoker — output watches", () => {
  const watch = { paneId: "w1:p1", source: "visible" as const, match: { type: "regex" as const, value: "Enter to select" } };

  test("subscribes output_matched only for watches on known agent panes", () => {
    const subs = buildSubscriptions(["w1:p1"], { outputWatches: [watch, { ...watch, paneId: "w1:other" }] });
    expect(subs.filter((s) => s.type === "pane.output_matched")).toEqual([
      { type: "pane.output_matched", pane_id: "w1:p1", source: "visible", match: { type: "regex", value: "Enter to select" } },
    ]);
  });

  test("delivers a match to listeners at once and does not poke a re-poll", async () => {
    const { client, poker, pokes } = makePoker({ debounceMs: 5 });
    const seen: OutputMatched[] = [];
    poker.onOutputMatched((e) => seen.push(e));
    poker.setAgentPanes(["w1:p1"]);
    poker.setOutputWatches([watch]);
    poker.start();
    await tick();
    expect(client.last.subscriptions.some((s) => s.type === "pane.output_matched")).toBe(true);
    client.last.onUp();
    const read = { pane_id: "w1:p1", text: "❯ 1. Yes\nEnter to select", truncated: false, revision: 0 };
    client.last.onEvent("pane_output_matched", { pane_id: "w1:p1", matched_line: "Enter to select", read });
    expect(seen).toEqual([{ paneId: "w1:p1", matchedLine: "Enter to select", read }]);
    await sleep(15);
    expect(pokes.length).toBe(0);
    poker.stop();
  });

  test("a changed watch set resubscribes, the same set does not", async () => {
    const { client, poker } = makePoker();
    poker.setAgentPanes(["w1:p1"]);
    poker.start();
    await tick();
    poker.setOutputWatches([watch]);
    await tick();
    expect(client.streams.length).toBe(2);
    poker.setOutputWatches([{ ...watch, match: { ...watch.match } }]);
    await tick();
    expect(client.streams.length).toBe(2);
    poker.setOutputWatches([]);
    await tick();
    expect(client.streams.length).toBe(3);
    poker.stop();
  });

  test("a match named dot-form, as 0.9.3 names pane-scoped events, is delivered too", async () => {
    const { client, poker } = makePoker();
    const seen: OutputMatched[] = [];
    poker.onOutputMatched((e) => seen.push(e));
    poker.start();
    await tick();
    client.last.onUp();
    client.last.onEvent("pane.output_matched", { pane_id: "w1:p1", matched_line: "Do you want to proceed?" });
    expect(seen).toEqual([{ paneId: "w1:p1", matchedLine: "Do you want to proceed?" }]);
    poker.stop();
  });

  test("pane.updated pokes on a metadata change, not on a title-only change", async () => {
    const { client, poker, pokes } = makePoker({ debounceMs: 5 });
    poker.start();
    await tick();
    client.last.onUp();
    const record = { pane_id: "w1:p1", agent: "codex", terminal_title: "⠋ codex", agent_session: null, tokens: {} };
    client.last.onEvent("pane_updated", { pane: record });
    await sleep(15);
    expect(pokes.length).toBe(1); // first record for the pane on this stream
    for (const t of ["⠙ codex", "⠹ codex", "⠸ codex"]) {
      client.last.onEvent("pane_updated", { pane: { ...record, terminal_title: t, revision: 9 } });
    }
    client.last.onEvent("pane_updated", { pane: { ...record, tokens: { org_heartbeat: "2" } } });
    await sleep(15);
    expect(pokes.length).toBe(1); // animated title and a non-allowlisted token: no re-poll
    client.last.onEvent("pane_updated", { pane: { ...record, agent_session: { kind: "id", value: "s-2" } } });
    await sleep(15);
    expect(pokes.length).toBe(2);
    client.last.onEvent("pane_updated", { pane: { ...record, agent_session: { kind: "id", value: "s-2" }, tokens: { thread: "t1" } } });
    await sleep(15);
    expect(pokes.length).toBe(3);
    poker.stop();
  });
});
