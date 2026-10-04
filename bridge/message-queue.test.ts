import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageQueue } from "./message-queue.ts";
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
    await queue.tick(async () => "working", send);
    expect(calls).toBe(0);
    await Promise.all([
      queue.tick(async () => "ready", send),
      queue.tick(async () => "ready", send),
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
      async () => "ready",
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
    await queue.tick(
      async () => "working",
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
      async () => "ready",
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
      async () => "ready",
      async () => ({ status: "blocked", error: "Answer the notice first." }),
    );
    expect((await queue.list("scope"))[0]!.state).toBe("queued");
    let calls = 0;
    const recovered = new MessageQueue(join(dir, "queue.json"));
    await recovered.tick(
      async () => "ready",
      async () => {
        calls++;
        return { status: "sent" };
      },
    );
    await recovered.tick(
      async () => "ready",
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
      async () => "ready",
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
