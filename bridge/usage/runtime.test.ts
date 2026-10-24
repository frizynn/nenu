import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backgroundPrefix, type ScanChild, sessionWeekly, Usage } from "./runtime.ts";

let stateDir = "";
beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), "nenu-usage-rt-")); });
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

/** A scan that finishes when told to, counting how often one was started. */
function fakeScans() {
  const started: Array<() => void> = [];
  const firstPass: boolean[] = [];
  const spawn = (_dir: string, _args: unknown, first: boolean): ScanChild => {
    firstPass.push(first);
    let finish!: () => void;
    const exited = new Promise<number>((resolve) => { finish = () => resolve(0); });
    started.push(finish);
    async function* lines() { await exited; yield JSON.stringify({ done: {} }); }
    return { lines: lines(), exited, kill: finish };
  };
  return { started, firstPass, spawn };
}

describe("usage runtime", () => {
  test("off: reading starts nothing and says so", async () => {
    const scans = fakeScans();
    const usage = new Usage({ stateDir, roots: { claude: [], codex: [] }, onScanned: () => {}, spawn: scans.spawn });
    await usage.load();
    expect(await usage.read()).toEqual({ on: false, splitByAccount: false });
    usage.turnEnded();
    expect(scans.started).toHaveLength(0);
  });

  test("turning it on starts one scan; reads while it runs share it", async () => {
    const scans = fakeScans();
    let scanned = 0;
    const usage = new Usage({ stateDir, roots: { claude: [], codex: [] }, onScanned: () => scanned++, spawn: scans.spawn });
    await usage.load();
    const first = await usage.set({ on: true });
    expect(first).toMatchObject({ on: true, scan: { state: "scanning", firstPass: true } });
    await usage.read();
    expect(scans.started).toHaveLength(1);
    scans.started[0]!();
    await Bun.sleep(5);
    expect(scanned).toBe(1);
  });

  test("a long scan announces its progress at most once a second, then its end", async () => {
    let now = 0;
    let announced = 0;
    let finish!: () => void;
    const exited = new Promise<number>((resolve) => { finish = () => resolve(0); });
    const progress = (bytes: number) => JSON.stringify({ progress: { files: 1, totalFiles: 9, bytes, totalBytes: 900 } });
    async function* lines() {
      for (const [at, bytes] of [[100, 100], [600, 200], [1200, 300], [1500, 400], [2300, 500]] as const) { now = at; yield progress(bytes); }
      await exited;
      yield JSON.stringify({ done: {} });
    }
    const usage = new Usage({ stateDir, roots: { claude: [], codex: [] }, onScanned: () => announced++, spawn: () => ({ lines: lines(), exited, kill: finish }), now: () => now });
    await usage.load();
    const first = await usage.set({ on: true });
    expect(first).toMatchObject({ scan: { state: "scanning", bytes: 500, totalBytes: 900 } });
    expect(announced).toBe(2);
    finish();
    await Bun.sleep(5);
    expect(announced).toBe(3);
  });

  test("a finished turn catches up only when the last scan is hours old", async () => {
    let now = 1_000_000_000_000;
    const scans = fakeScans();
    const usage = new Usage({ stateDir, roots: { claude: [], codex: [] }, onScanned: () => {}, spawn: scans.spawn, now: () => now });
    await usage.load();
    await usage.set({ on: true });
    scans.started[0]!();
    await Bun.sleep(5);
    usage.turnEnded();
    expect(scans.started).toHaveLength(1);
    now += 7 * 3_600_000;
    usage.turnEnded();
    expect(scans.started).toHaveLength(2);
    // Only the first pass, watched on screen, runs at normal priority.
    expect(scans.firstPass).toEqual([true, false]);
  });

  test("turning Split by account on rescans at once, so inactive accounts' limits appear", async () => {
    const scans = fakeScans();
    const usage = new Usage({ stateDir, roots: { claude: [], codex: [] }, onScanned: () => {}, spawn: scans.spawn });
    await usage.load();
    await usage.set({ on: true });
    scans.started[0]!();
    await Bun.sleep(5);
    await usage.set({ splitByAccount: true });
    expect(scans.started).toHaveLength(2);
  });

  test("a scan that fails is not started again by the reads its end sets off", async () => {
    let spawned = 0;
    const failing = (): ScanChild => {
      spawned++;
      return { lines: (async function* () {})(), exited: Bun.sleep(1).then(() => 1), kill() {} };
    };
    // The page and the Settings row read again on every `usage` event (web/src/routes/usage.tsx).
    const usage: Usage = new Usage({ stateDir, roots: { claude: [], codex: [] }, onScanned: () => void usage.read(), spawn: failing });
    await usage.load();
    try {
      await usage.set({ on: true });
      await Bun.sleep(50);
      expect(spawned).toBe(1);
      expect(await usage.read()).toMatchObject({ scan: { state: "idle", error: "scan stopped (exit 1)" } });
      expect(spawned).toBe(1);
    } finally {
      await usage.set({ on: false });
    }
  });

  test("a scan that goes quiet is stopped, so usage does not stay scanning for good", async () => {
    let killed = 0;
    let finish!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { finish = resolve; });
    async function* lines() { await exited; }
    const usage = new Usage({
      stateDir, roots: { claude: [], codex: [] }, onScanned: () => {}, quietMs: 20,
      spawn: () => ({ lines: lines(), exited, kill: () => { killed++; finish(143); } }),
    });
    await usage.load();
    await usage.set({ on: true });
    await Bun.sleep(60);
    expect(killed).toBe(1);
    expect(await usage.read()).toMatchObject({ scan: { state: "idle", error: "scan stopped (exit 143)" } });
  });

  test("the scan runs at background priority", () => {
    expect(backgroundPrefix("darwin", () => null, () => true)).toEqual(["/usr/sbin/taskpolicy", "-b"]);
    expect(backgroundPrefix("linux", () => "/usr/bin/nice")).toEqual(["/usr/bin/nice", "-n", "19"]);
  });

  test("a session's weekly window from the scan, only while tracking is on, re-read when the scan rewrites it", async () => {
    const now = Date.UTC(2026, 9, 24, 10);
    const usage = new Usage({ stateDir, roots: { claude: [], codex: [] }, onScanned: () => {}, spawn: fakeScans().spawn, now: () => now });
    await usage.load();
    const write = (usedPercent: number, mtime: number) => {
      mkdirSync(join(stateDir, "usage"), { recursive: true });
      const path = join(stateDir, "usage", "accounts.json");
      writeFileSync(path, JSON.stringify({ v: 1, at: now, accounts: [], limits: [], sessions: { s1: "claude:aaaa" },
        weekly: { "claude:aaaa": { usedPercent, resetsAt: now / 1000 + 3600, observedAt: now - 5000 } } }));
      utimesSync(path, mtime, mtime);
    };
    write(40, 1000);
    expect(usage.claudeWeekly("s1")).toBeUndefined();
    await usage.set({ on: true });
    expect(usage.claudeWeekly("s1")).toEqual({ name: "secondary", usedPercent: 40, windowMinutes: 10080, resetsAt: now / 1000 + 3600, observedAt: now - 5000 });
    expect(usage.claudeWeekly("s2")).toBeUndefined();
    write(41, 2000);
    expect(usage.claudeWeekly("s1")).toMatchObject({ usedPercent: 41 });
    rmSync(join(stateDir, "usage"), { recursive: true });
    expect(usage.claudeWeekly("s1")).toBeUndefined();
  });
});

describe("sessionWeekly", () => {
  const now = Date.UTC(2026, 9, 24, 10);
  const file = (over: Record<string, unknown>) => ({ v: 1 as const, at: now, accounts: [], limits: [], ...over });
  test("nothing for a reset window, an unknown session, an old file or a malformed one", () => {
    const weekly = { "claude:aaaa": { usedPercent: 99, resetsAt: now / 1000 - 1, observedAt: now } };
    expect(sessionWeekly(file({ sessions: { s1: "claude:aaaa" }, weekly }), "s1", now)).toBeUndefined();
    expect(sessionWeekly(file({}), "s1", now)).toBeUndefined();
    expect(sessionWeekly(undefined, "s1", now)).toBeUndefined();
    expect(sessionWeekly(file({ sessions: { s1: 5 }, weekly: [] }), "s1", now)).toBeUndefined();
    expect(sessionWeekly(file({ sessions: { s1: "claude:aaaa" }, weekly: { "claude:aaaa": { usedPercent: "99" } } }), "s1", now)).toBeUndefined();
    expect(sessionWeekly(file({ sessions: "x", weekly: null }), "toString", now)).toBeUndefined();
  });
});
