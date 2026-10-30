import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HcJournalMirror, hcJournalRoot, type HcExec } from "./hc-journal.ts";

const ID = "19e6b462-17df-4bca-8bcb-c7e62c46ff4c";
const made: string[] = [];
const dirs = async () => { const d = await mkdtemp(join(tmpdir(), "hc-journal-")); made.push(d); return d; };
afterEach(async () => { for (const d of made.splice(0)) await rm(d, { recursive: true, force: true }); });

/** A machine's log as `READ_NEW` would answer it. */
function machineLog(start: string) {
  const log = { text: start };
  const calls: string[][] = [];
  const exec: HcExec = async (_m, argv) => {
    calls.push(argv);
    const off = Number(argv[5]);
    const from = off > log.text.length ? 0 : off;
    return new TextEncoder().encode(`${log.text.length} ${from}\n${log.text.slice(from)}`);
  };
  return { log, exec, calls };
}
const copyOf = async (root: string) => {
  const { readdir } = await import("node:fs/promises");
  const [folder] = await readdir(root);
  return readFile(join(root, folder!, `${ID}.jsonl`), "utf8");
};

describe("HcJournalMirror", () => {
  test("the first read brings the log; a later one only what was added", async () => {
    const dir = await dirs();
    const { log, exec, calls } = machineLog("one\n");
    const mirror = new HcJournalMirror(dir, exec);
    await mirror.follow("rise-l", ID);
    expect(await copyOf(join(dir, "projects"))).toBe("one\n");
    log.text += "two\n";
    await mirror.follow("rise-l", ID);
    await Bun.sleep(10);
    expect(await copyOf(join(dir, "projects"))).toBe("one\ntwo\n");
    expect(calls[1]![5]).toBe("4");
    mirror.stop();
  });

  test("a log that shrank starts the copy over", async () => {
    const dir = await dirs();
    const { log, exec } = machineLog("a long first log\n");
    const mirror = new HcJournalMirror(dir, exec);
    await mirror.follow("rise-l", ID);
    log.text = "new\n";
    await mirror.follow("rise-l", ID);
    await Bun.sleep(10);
    expect(await copyOf(join(dir, "projects"))).toBe("new\n");
    mirror.stop();
  });

  test("an id that is not a uuid never reaches the machine", async () => {
    const dir = await dirs();
    const { exec, calls } = machineLog("x");
    const mirror = new HcJournalMirror(dir, exec);
    await mirror.follow("rise-l", "../../etc/passwd");
    await mirror.follow("rise-l", "$(reboot)");
    expect(calls).toEqual([]);
    mirror.stop();
  });

  test("a machine that cannot answer leaves no copy and no throw", async () => {
    const dir = await dirs();
    const mirror = new HcJournalMirror(dir, async () => { throw new Error("exit 3"); });
    await mirror.follow("rise-l", ID);
    expect(await copyOf(join(dir, "projects")).catch(() => null)).toBeNull();
    mirror.stop();
  });

  test("its root sits under the state directory", () => {
    expect(hcJournalRoot("/state")).toBe("/state/hc-journals/projects");
  });
});
