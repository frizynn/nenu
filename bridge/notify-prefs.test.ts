import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_NOTIFY_PREFS, NotifyPrefsStore, coerceNotifyPrefs } from "./notify-prefs.ts";
import { loadConfig } from "./config.ts";

// Notify-type prefs own which agent statuses push. The coercion is pure; the merge + disk round-trip
// is verified through a throwaway temp state dir (mirrors snooze.test.ts / push.test.ts).

const dirs: string[] = [];
async function tempCfg() {
  const stateDir = await mkdtemp(join(tmpdir(), "collie-notify-prefs-"));
  dirs.push(stateDir);
  return { ...loadConfig(), stateDir };
}

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("coerceNotifyPrefs", () => {
  const fresh = { blocked: true, replies: true, launched: false, subagents: false, updates: true };
  test("fills missing / non-boolean keys from defaults", () => {
    expect(coerceNotifyPrefs(undefined)).toEqual(fresh);
    expect(coerceNotifyPrefs({ blocked: false, updates: 0 })).toEqual({ ...fresh, blocked: false });
  });

  test("a file from before keeps its finished choice as Replies to you", () => {
    expect(coerceNotifyPrefs({ done: true, threads: true, coordinators: true })).toEqual({ ...fresh, replies: true });
    expect(coerceNotifyPrefs({ done: false, threads: false, coordinators: false })).toEqual({ ...fresh, replies: false });
    expect(coerceNotifyPrefs({ done: false, replies: true })).toEqual({ ...fresh, replies: true });
  });
});

describe("NotifyPrefsStore.wants", () => {
  const done = { status: "done" as const, startedBy: "person" as const, requested: false, launched: false, name: "x", where: "y" };
  test("a finished turn notifies when it answers a person, and a subagent's only when switched on", async () => {
    const store = new NotifyPrefsStore(await tempCfg());
    expect(store.wants(done)).toBe(true);
    expect(store.wants({ ...done, requested: true })).toBe(true);
    expect(store.wants({ ...done, startedBy: "subagent" })).toBe(false);
    await store.set({ subagents: true, replies: false });
    expect(store.wants({ ...done, startedBy: "subagent" })).toBe(true);
    expect(store.wants(done)).toBe(false);
    expect(store.wants({ ...done, status: "blocked" })).toBe(true);
  });

  test("an agent another agent started stays quiet unless you asked it from Nenu or switch it on", async () => {
    const store = new NotifyPrefsStore(await tempCfg());
    expect(store.wants({ ...done, launched: true })).toBe(false);
    expect(store.wants({ ...done, launched: true, requested: true })).toBe(true);
    expect(store.wants({ ...done, launched: true, status: "blocked" })).toBe(true);
    await store.set({ launched: true });
    expect(store.wants({ ...done, launched: true })).toBe(true);
  });

  test("a finished turn may notify while Replies or Subagent results is on", async () => {
    const store = new NotifyPrefsStore(await tempCfg());
    expect(store.maybe("done")).toBe(true);
    await store.set({ replies: false });
    expect(store.maybe("done")).toBe(false);
    expect(store.maybe("working")).toBe(false);
  });
});

describe("NotifyPrefsStore", () => {
  test("defaults to blocked-on / done-off when nothing is saved", async () => {
    const store = new NotifyPrefsStore(await tempCfg());
    await store.load();
    expect(store.current()).toEqual(DEFAULT_NOTIFY_PREFS);
  });

  test("set merges a partial patch, persists, and returns the updated prefs", async () => {
    const cfg = await tempCfg();
    const store = new NotifyPrefsStore(cfg);
    const updated = await store.set({ replies: true, updates: false });
    expect(updated).toEqual({ blocked: true, replies: true, launched: false, subagents: false, updates: false });

    // Round-trips through disk: a fresh store reloads the same values (survives a restart).
    const reloaded = new NotifyPrefsStore(cfg);
    await reloaded.load();
    expect(reloaded.current()).toEqual({ blocked: true, replies: true, launched: false, subagents: false, updates: false });
  });

  test("current() returns a copy — callers can't mutate the store's state", async () => {
    const store = new NotifyPrefsStore(await tempCfg());
    await store.load();
    const snap = store.current();
    snap.blocked = false;
    expect(store.current()).toEqual(DEFAULT_NOTIFY_PREFS);
  });

  test("persists with owner-only (0600) permissions", async () => {
    const cfg = await tempCfg();
    const store = new NotifyPrefsStore(cfg);
    await store.set({ blocked: false });
    const mode = (await stat(join(cfg.stateDir, "notify-prefs.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("a partial saved file fills the missing key from defaults", async () => {
    const cfg = await tempCfg();
    await writeFile(join(cfg.stateDir, "notify-prefs.json"), JSON.stringify({ blocked: false }));
    const store = new NotifyPrefsStore(cfg);
    await store.load();
    expect(store.current()).toEqual({ blocked: false, replies: true, launched: false, subagents: false, updates: true });
  });

  test("load tolerates a missing file (keeps defaults)", async () => {
    const store = new NotifyPrefsStore(await tempCfg());
    await store.load();
    expect(store.current()).toEqual(DEFAULT_NOTIFY_PREFS);
  });
});
