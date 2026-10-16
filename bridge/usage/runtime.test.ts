import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backgroundPrefix, type ScanChild, Usage } from "./runtime.ts";

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

  test("the scan runs at background priority", () => {
    expect(backgroundPrefix("darwin", () => null, () => true)).toEqual(["/usr/sbin/taskpolicy", "-b"]);
    expect(backgroundPrefix("linux", () => "/usr/bin/nice")).toEqual(["/usr/bin/nice", "-n", "19"]);
  });
});
