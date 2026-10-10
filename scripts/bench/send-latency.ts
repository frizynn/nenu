import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EVENT_DEBOUNCE_MS } from "../../bridge/event-poker.ts";
import { guardedSend } from "../../bridge/guarded-send.ts";
import { computeEtag } from "../../bridge/http-cache.ts";
import type { HerdrClient } from "../../bridge/herdr-client.ts";
import { QueueService } from "../../bridge/queue-service.ts";
import type { AgentView } from "../../bridge/types.ts";
import { sendGuardedReply } from "../../web/src/lib/guarded-reply.ts";

// Send latency on the two write paths, against a fake Claude input box. No Herdr socket, no real
// terminal and no operator message is touched. Herdr RPC costs default to the p50s measured on the
// operator's host (listPanes ~6ms, pane.read ~1.3ms); the TUI echo/clear delays and the phone RTT are
// assumptions, varied so the numbers are not tuned to one guess.
//
//   bun scripts/bench/send-latency.ts [runs=5]
//
// "delivered" is when the queue row is persisted as sent (or the direct send returned "sent").
// "trips" counts phone-to-bridge HTTP round trips: the browser guard makes one per read and write, the
// bridge guard (POST send) makes one.
// "visible" is when a model browser learns it: the queue hook's 3000ms poll with a random phase, or,
// with --push, a live-events invalidation followed by one GET.

const runs = Number(process.argv[2] ?? 5);
const push = process.argv.includes("--push");
const RPC = { list: 6, read: 1.3, write: 2 };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const rule = "─".repeat(60);
const screen = (draft: string) => [rule, `❯ ${draft}`, rule, "  Opus 5.5 | Context 13% used", "  ← for agents"].join("\n");

/** A Claude input box that paints typed text after `echoMs` and clears after Enter in `clearMs`. */
function fakeTerminal(echoMs: number, clearMs: number) {
  let draft = "";
  return {
    read: async () => { await sleep(RPC.read); return { pane_id: "p", text: screen(draft), revision: 1, truncated: false }; },
    write: async (text: string, submit: boolean) => {
      await sleep(RPC.write);
      if (text) setTimeout(() => { draft += text; }, echoMs);
      if (submit) setTimeout(() => { draft = ""; }, clearMs);
      return { ok: true } as const;
    },
  };
}

const pct = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!);
};
const summary = (values: number[]) => ({ p50: pct(values, 0.5), max: Math.round(Math.max(...values)) });

/** The browser guard: every read and write is its own phone-to-bridge request. */
async function direct(echoMs: number, clearMs: number, rtt: number) {
  const term = fakeTerminal(echoMs, clearMs);
  let trips = 0;
  const start = performance.now();
  const outcome = await sendGuardedReply({
    paneId: "p",
    agent: "claude",
    text: "Bench message",
    transport: {
      fetchPane: async () => { trips++; await sleep(rtt); return term.read(); },
      sendReply: async (_pane, text, submit) => { trips++; await sleep(rtt); return term.write(text, submit); },
    },
  });
  if (outcome.status !== "sent") throw new Error(`direct send ended ${outcome.status}`);
  return { ms: performance.now() - start, trips };
}

/** The bridge guard: one request; reads and writes are local socket calls priced at Herdr's p50s. */
async function oneRequest(echoMs: number, clearMs: number, rtt: number) {
  const term = fakeTerminal(echoMs, clearMs);
  const herdr = {
    getPane: async () => { await sleep(RPC.read); return { agent: "claude" }; },
    readPane: term.read,
    sendPaneText: async (_p: string, text: string) => void (await term.write(text, false)),
    sendPaneKeys: async () => { enter = performance.now(); await term.write("", true); },
    // Herdr re-reads every 100 ms while it waits; model the echo landing inside that cadence.
    waitForOutput: async () => { await sleep(Math.min(100, echoMs)); return { matched: false as const }; },
  } as unknown as HerdrClient;
  let enter = 0;
  const start = performance.now();
  await sleep(rtt / 2);
  const { outcome } = await guardedSend(
    { herdr, paneId: "p", readLines: 200, submitKeys: ["Enter"] },
    { text: "Bench message", requestId: "bench" },
  );
  if (!outcome.ok) throw new Error(`one-request send ended at ${outcome.stage}: ${outcome.error}`);
  await sleep(rtt / 2);
  // `ms` is when the phone learns Enter went out, comparable with the browser guard's (whose answer
  // follows the submit ack); `confirmedMs` adds the bridge's wait for the box to let go of the text.
  return { ms: enter - start + rtt / 2, confirmedMs: performance.now() - start, trips: 1 };
}

/** POST a queued message while the pane is `working` until `idleAfterMs` (0 = idle already). */
async function queued(echoMs: number, clearMs: number, idleAfterMs: number, rtt: number) {
  const dir = await mkdtemp(join(tmpdir(), "nenu-send-bench-"));
  const term = fakeTerminal(echoMs, clearMs);
  let status: AgentView["status"] = idleAfterMs ? "working" : "idle";
  const pane: AgentView = {
    paneId: "p", workspaceId: "w", workspaceLabel: "bench", workspaceNumber: 1, tabId: "t", agent: "claude",
    status, cwd: "/tmp", focused: true, agentSession: { kind: "id", value: "bench" },
  };
  const herdr = { readPane: term.read } as unknown as HerdrClient;
  const changes: (() => void)[] = [];
  const service = new QueueService(
    dir,
    async () => { await sleep(RPC.list); return { pane: { ...pane, status }, herdr, connected: true }; },
    async (_row, text, submit) => term.write(text, submit),
    undefined,
    () => { for (const fn of changes) fn(); },
  );
  const scope = computeEtag(JSON.stringify(["s", "p", "claude:bench"]));
  const list = async () => (await (await service.handle(new Request("http://localhost/q"), "s", "p", null)).json()) as { messages: unknown[] };
  try {
    let delivered = 0;
    let visible = 0;
    const start = performance.now();
    // Browser model. Poll: the hook re-reads every 3000ms from a random phase. Push: an invalidation
    // triggers one GET after a network hop, and the poll keeps running as the fallback.
    const browserSaw = async () => { await sleep(rtt); const page = await list(); if (!page.messages.length && delivered && !visible) visible = performance.now(); };
    const phase = Math.random() * 3000;
    const poller = setTimeout(function tick() { void browserSaw(); (poller as { t?: Timer }).t = setTimeout(tick, 3000); }, phase);
    // The stream coalesces for 25ms before a frame leaves the bridge (bridge/live-events.ts).
    if (push) changes.push(() => void sleep(25).then(browserSaw));
    if (idleAfterMs) setTimeout(() => {
      status = "idle";
      // The engine learns of the flip through Herdr's status event and the poker's debounce; a bridge
      // that kicks the queue on herd changes delivers then, an older one on its fallback tick.
      setTimeout(() => service.kick?.(), EVENT_DEBOUNCE_MS + RPC.list);
    }, idleAfterMs);
    await service.handle(new Request("http://localhost/q", { method: "POST", body: JSON.stringify({ action: "add", id: "bench", scope, text: "Bench message" }) }), "s", "p", null);
    while (!delivered || !visible) {
      if (!delivered && !(await list()).messages.length) delivered = performance.now();
      if (performance.now() - start > 20_000) throw new Error("queue bench did not converge");
      await sleep(5);
    }
    clearTimeout(poller);
    clearTimeout((poller as { t?: Timer }).t);
    const from = start + idleAfterMs;
    return { delivered: delivered - from, visible: visible - from };
  } finally {
    service.dispose?.();
    await rm(dir, { recursive: true, force: true });
  }
}

const rows: Record<string, unknown>[] = [];
for (const [echoMs, clearMs] of [[30, 50], [120, 200]] as const) {
  for (const rtt of [5, 40]) {
    for (const [path, send] of [["direct reply → Enter sent", direct], ["one-request send → Enter sent", oneRequest]] as const) {
      const times: number[] = [];
      const confirmed: number[] = [];
      const trips: number[] = [];
      for (let i = 0; i < runs; i++) {
        const r: { ms: number; trips: number; confirmedMs?: number } = await send(echoMs, clearMs, rtt);
        times.push(r.ms);
        trips.push(r.trips);
        if (r.confirmedMs !== undefined) confirmed.push(r.confirmedMs);
      }
      rows.push({ path, echoMs, clearMs, rttMs: rtt, ms: summary(times), ...(confirmed.length ? { confirmedMs: summary(confirmed) } : {}), trips: summary(trips) });
    }
  }
  for (const busy of [false, true]) {
    const delivered: number[] = [];
    const visible: number[] = [];
    for (let i = 0; i < runs; i++) {
      // A busy agent turns idle at a random point of the queue's fallback tick, as it would live.
      const r = await queued(echoMs, clearMs, busy ? 200 + Math.random() * 2000 : 0, 40);
      delivered.push(r.delivered);
      visible.push(r.visible);
    }
    rows.push({
      path: busy ? "queue, agent turns idle → sent" : "queue POST → sent",
      echoMs, clearMs, rttMs: 40, browser: push ? "push" : "poll",
      delivered: summary(delivered), visible: summary(visible),
    });
  }
}
console.log(JSON.stringify({ runs, rpcMs: RPC, rows }, null, 1));
process.exit(0);
