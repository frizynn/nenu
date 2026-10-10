import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageQueue, type Verdict } from "./message-queue.ts";
const readyNow = async (): Promise<Verdict<true>> => ({ ready: true });
const working = async (): Promise<Verdict<true>> => ({ wait: "working" });
const row = {
  id: "one",
  scope: "scope",
  paneId: "w1:p1",
  session: "main",
  conversation: "claude:id",
  agent: "claude",
  text: "Next task",
  device: null,
};
test("persists, deduplicates, waits for readiness and sends once across concurrent ticks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nenu-queue-"));
  try {
    let queue = new MessageQueue(join(dir, "queue.json"));
    await queue.add(row);
    await queue.add(row);
    queue = new MessageQueue(join(dir, "queue.json"));
    expect((await queue.list("scope")).length).toBe(1);
    let calls = 0;
    const send = async () => {
      calls++;
      return { status: "sent" as const };
    };
    await queue.tick(working, send);
    expect(calls).toBe(0);
    await Promise.all([
      queue.tick(readyNow, send, { force: true }),
      queue.tick(readyNow, send, { force: true }),
    ]);
    expect(calls).toBe(1);
    expect(await queue.list("scope")).toEqual([]);
    await queue.add(row);
    expect(await queue.list("scope")).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("pauses uncertain delivery, refuses stale edits and lets an explicitly selected message send", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nenu-queue-"));
  try {
    const queue = new MessageQueue(join(dir, "queue.json"));
    await queue.add(row);
    await queue.tick(
      readyNow,
      async () => {
        throw new Error("lost ack");
      },
    );
    const item = (await queue.list("scope"))[0]!;
    expect(item.state).toBe("paused");
    await expect(queue.change("scope", "one", 0, "remove")).rejects.toThrow();
    await queue.add({ ...row, id: "two", text: "Another task" });
    const second = (await queue.list("scope"))[1]!;
    await queue.change("scope", second.id, second.revision, "send");
    const sent: string[] = [];
    // The delivery side lifts the wait for the turn for a row the operator sent now.
    await queue.tick(
      async (r): Promise<Verdict<true>> => (r.sendNow ? { ready: true } : { wait: "working" }),
      async (r) => {
        sent.push(r.id);
        return { status: "sent" };
      },
    );
    expect(sent).toEqual(["two"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an in-flight message restored after a crash is paused, never resent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nenu-queue-"));
  try {
    const path = join(dir, "queue.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      path,
      JSON.stringify([
        { ...row, state: "sending", createdAt: Date.now(), revision: 1 },
      ]),
    );
    const queue = new MessageQueue(path);
    let calls = 0;
    await queue.tick(
      readyNow,
      async () => {
        calls++;
        return { status: "sent" };
      },
    );
    expect(calls).toBe(0);
    expect((await queue.list("scope"))[0]?.state).toBe("paused");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("retention never discards old unsent messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nenu-queue-"));
  try {
    const path = join(dir, "queue.json");
    const { writeFile } = await import("node:fs/promises");
    const saved = [
      { ...row, state: "paused", createdAt: 1, revision: 0 },
      ...Array.from({ length: 500 }, (_, index) => ({
        ...row,
        id: `sent-${index}`,
        state: "sent",
        createdAt: Date.now(),
        revision: 1,
      })),
    ];
    await writeFile(path, JSON.stringify(saved));
    const queue = new MessageQueue(path);
    await queue.add({ ...row, id: "new" });
    expect((await queue.list("scope")).map((item) => item.id)).toEqual([
      "one",
      "new",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("waits through a pre-type dialog and continues once without a second Send", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nenu-wait-"));
  try {
    const queue = new MessageQueue(join(dir, "queue.json"));
    await queue.add(row);
    await queue.tick(
      readyNow,
      async () => ({ status: "blocked", error: "Answer the notice first." }),
    );
    expect((await queue.list("scope"))[0]!.state).toBe("queued");
    let calls = 0;
    const recovered = new MessageQueue(join(dir, "queue.json"));
    await recovered.tick(
      readyNow,
      async () => {
        calls++;
        return { status: "sent" };
      },
    );
    await recovered.tick(
      readyNow,
      async () => {
        calls++;
        return { status: "sent" };
      },
    );
    expect(calls).toBe(1);
    expect(await recovered.list("scope")).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("uncertain delivery cannot be edited or resent without checking the terminal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nenu-paused-"));
  try {
    const queue = new MessageQueue(join(dir, "queue.json"));
    await queue.add(row);
    await queue.tick(
      readyNow,
      async () => ({ status: "uncertain" }),
    );
    const item = (await queue.list("scope"))[0]!;
    await expect(
      queue.change("scope", item.id, item.revision, "send"),
    ).rejects.toThrow("Check Terminal");
    await expect(
      queue.change("scope", item.id, item.revision, "edit", "Again"),
    ).rejects.toThrow("Check Terminal");
    await queue.change("scope", item.id, item.revision, "remove");
    expect(await queue.list("scope")).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recent delivery receipts survive more than one hundred newer messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nenu-receipts-"));
  try {
    const path = join(dir, "queue.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      path,
      JSON.stringify(
        Array.from({ length: 110 }, (_, i) => ({
          ...row,
          id: `sent-${i}`,
          state: "sent",
          createdAt: 1,
          sentAt: Date.now(),
          revision: 1,
        })),
      ),
    );
    const queue = new MessageQueue(path);
    await queue.add({ ...row, id: "new" });
    await queue.add({ ...row, id: "sent-0" });
    expect((await queue.list("scope")).map((item) => item.id)).toEqual(["new"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("announces each committed state, after it is on disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nenu-queue-"));
  try {
    const path = join(dir, "queue.json");
    const seen: string[] = [];
    const queue = new MessageQueue(path, (changed) => {
      const stored = JSON.parse(readFileSync(path, "utf8")) as { state: string }[];
      seen.push(`${changed.session}/${changed.paneId}:${changed.state}=${stored[0]?.state}`);
    });
    await queue.add(row);
    await queue.tick(readyNow, async () => ({ status: "sent" as const }));
    expect(seen).toEqual(["main/w1:p1:queued=queued", "main/w1:p1:sending=sending", "main/w1:p1:sent=sent"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function withQueue(run: (queue: MessageQueue, path: string, events: string[]) => Promise<void>, now?: () => number) {
  const dir = await mkdtemp(join(tmpdir(), "nenu-queue-"));
  const events: string[] = [];
  try {
    const path = join(dir, "queue.json");
    await run(new MessageQueue(path, (changed) => events.push(changed.state), now), path, events);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a waiting row costs no write and no event once its reason is known", async () => {
  await withQueue(async (queue, path, events) => {
    await queue.add(row);
    const { statSync } = await import("node:fs");
    const deliveries: string[] = [];
    const dialog = async (): Promise<Verdict<true>> => ({ wait: "dialog" });
    const deliver = async (r: { id: string }) => (deliveries.push(r.id), { status: "sent" as const });
    await queue.tick(dialog, deliver, { force: true });
    expect((await queue.list("scope"))[0]).toMatchObject({ state: "queued", waitingFor: "dialog", revision: 0 });
    const before = { events: events.length, mtime: statSync(path).mtimeMs };
    for (let i = 0; i < 10; i++) await queue.tick(dialog, deliver, { force: true });
    expect(events.length - before.events).toBe(0);
    expect(statSync(path).mtimeMs).toBe(before.mtime);
    expect(deliveries).toEqual([]);
    // The reason is read, never stored: the revision did not move.
    expect((await queue.list("scope"))[0]).toMatchObject({ waitingFor: "dialog", revision: 0 });
  });
});

test("the fallback interval backs off a waiting row; an explicit kick still looks", async () => {
  let clock = 1_000_000;
  await withQueue(async (queue) => {
    await queue.add(row);
    let looks = 0;
    const draft = async (): Promise<Verdict<true>> => (looks++, { wait: "draft" });
    const deliver = async () => ({ status: "sent" as const });
    await queue.tick(draft, deliver);
    await queue.tick(draft, deliver);
    expect(looks).toBe(1);
    clock += 2_000;
    await queue.tick(draft, deliver);
    expect(looks).toBe(2);
    clock += 2_000;
    await queue.tick(draft, deliver);
    expect(looks).toBe(2); // now 4 s apart
    await queue.tick(draft, deliver, { force: true });
    expect(looks).toBe(3);
  }, () => clock);
});

test("two scopes deliver in parallel; one scope delivers in order", async () => {
  await withQueue(async (queue) => {
    await queue.add(row);
    await queue.add({ ...row, id: "two", text: "Second" });
    await queue.add({ ...row, id: "other", scope: "other", paneId: "w1:p2", text: "Elsewhere" });
    const started: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const tick = queue.tick(readyNow, async (r) => {
      started.push(r.id);
      if (r.id === "one") await gate;
      return { status: "sent" as const };
    });
    await Bun.sleep(30);
    // The slow first row of one scope does not hold the other scope back, nor let its own second row pass.
    expect(started.toSorted()).toEqual(["one", "other"]);
    release();
    await tick;
    expect(started).toEqual(["one", "other", "two"]);
  });
});

test("a busy pane is not claimed: no write until the pane is free", async () => {
  await withQueue(async (queue, _path, events) => {
    await queue.add(row);
    const busy = async () => ({ busy: true as const });
    await queue.tick(readyNow, async () => ({ status: "sent" as const }), { exclusive: busy });
    expect(events).toEqual(["queued"]);
    expect((await queue.list("scope"))[0]!.state).toBe("queued");
  });
});

test("a stranded row says why, is listed on its pane and moves to the new conversation only on Send", async () => {
  await withQueue(async (queue) => {
    await queue.add(row);
    const gone = async (): Promise<Verdict<true>> => ({ stranded: "The conversation in this pane changed." });
    const sent: string[] = [];
    const deliver = async (r: { id: string; conversation: string }) => (sent.push(`${r.id}@${r.conversation}`), { status: "sent" as const });
    await queue.tick(gone, deliver, { force: true });
    const pane = { session: "main", paneId: "w1:p1" };
    const [stranded] = await queue.list("new-scope", pane);
    expect(stranded).toMatchObject({ id: "one", stranded: { reason: "The conversation in this pane changed." } });
    expect(await queue.list("new-scope")).toEqual([]);
    expect(sent).toEqual([]);
    await queue.change("new-scope", "one", stranded!.revision, "send", undefined, { ...pane, conversation: "claude:new", agent: "claude" });
    await queue.tick(readyNow, deliver, { force: true });
    expect(sent).toEqual(["one@claude:new"]);
  });
});

test("a conversation that goes away strands every row it held, and a move takes the pane's agent", async () => {
  await withQueue(async (queue) => {
    for (const id of ["one", "two", "three"]) await queue.add({ ...row, id, deliveryMode: "asap" });
    await queue.tick(async (): Promise<Verdict<true>> => ({ stranded: "The conversation in this pane changed." }), async () => ({ status: "sent" as const }), { force: true });
    const pane = { session: "main", paneId: "w1:p1" };
    const shown = await queue.list("new-scope", pane);
    expect(shown.map((r) => [r.id, !!r.stranded])).toEqual([["one", true], ["two", true], ["three", true]]);
    await queue.change("new-scope", "two", shown[1]!.revision, "send", undefined, { ...pane, conversation: "codex:new", agent: "codex" });
    expect((await queue.list("new-scope")).map((r) => [r.id, r.agent, r.conversation, r.deliveryMode])).toEqual([["two", "codex", "codex:new", "steer"]]);
  });
});

test("the old conversation coming back un-strands all its rows", async () => {
  await withQueue(async (queue) => {
    for (const id of ["one", "two"]) await queue.add({ ...row, id });
    await queue.tick(async (): Promise<Verdict<true>> => ({ stranded: "The agent's pane closed." }), async () => ({ status: "sent" as const }), { force: true });
    await queue.tick(working, async () => ({ status: "sent" as const }), { force: true });
    expect((await queue.list("scope")).map((r) => r.stranded)).toEqual([undefined, undefined]);
  });
});

test("a forced kick that lands during a fallback pass still looks past that pass's backoff", async () => {
  let clock = 1_000_000;
  await withQueue(async (queue) => {
    await queue.add(row);
    let status = "working";
    let looks = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const assess = async (): Promise<Verdict<true>> => {
      looks++;
      const seen = status;
      if (looks === 2) await gate; // the fallback pass, still reading when the turn ends
      return seen === "working" ? { wait: "working" } : { ready: true };
    };
    const sent: string[] = [];
    const deliver = async (r: { id: string }) => (sent.push(r.id), { status: "sent" as const });
    await queue.tick(assess, deliver, { force: true });
    clock += 2_500;
    const fallback = queue.tick(assess, deliver);
    await Bun.sleep(5);
    status = "idle";
    const forced = queue.tick(assess, deliver, { force: true });
    release();
    await Promise.all([fallback, forced]);
    expect(sent).toEqual(["one"]);
  }, () => clock);
});

test("a stranded row the operator never came back for expires; the per-conversation cap holds", async () => {
  let clock = 1_000_000;
  await withQueue(async (queue) => {
    await queue.add(row);
    await queue.tick(async (): Promise<Verdict<true>> => ({ stranded: "The agent's pane closed." }), async () => ({ status: "sent" as const }), { force: true });
    clock += 25 * 3600_000;
    await queue.add({ ...row, id: "fresh", scope: "other" });
    expect(await queue.list("scope", { session: "main", paneId: "w1:p1" })).toEqual([]);
    for (let i = 0; i < 49; i++) await queue.add({ ...row, id: `r${i}`, scope: "other" });
    await expect(queue.add({ ...row, id: "over", scope: "other" })).rejects.toThrow("full for this conversation");
  }, () => clock);
});

test("the journal confirms a paused delivery and records what the CLI's queue did", async () => {
  await withQueue(async (queue) => {
    await queue.add(row);
    await queue.tick(readyNow, async () => ({ status: "uncertain" as const, error: "Check Terminal." }));
    const [paused] = await queue.unconfirmed();
    expect(paused).toMatchObject({ state: "paused" });
    await queue.confirm("one", "enqueued");
    expect(await queue.list("scope")).toEqual([]);
    expect((await queue.recent("scope"))[0]).toMatchObject({ id: "one", native: "enqueued", state: "sent" });
    await queue.confirm("one", "absorbed");
    expect(await queue.unconfirmed()).toEqual([]);
  });
});

test("until answers on the row's first move, or at the deadline", async () => {
  await withQueue(async (queue) => {
    await queue.add(row);
    const moved = queue.until("one", (r) => r.state !== "queued" || !!r.waitingFor, 1_000);
    void queue.tick(async (): Promise<Verdict<true>> => ({ wait: "working" }), async () => ({ status: "sent" as const }));
    expect(await moved).toMatchObject({ waitingFor: "working" });
    const started = Date.now();
    expect(await queue.until("one", () => false, 50)).toMatchObject({ id: "one" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });
});
