import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HcJournalMirror, hcJournalRoot, type HcExec } from "./hc-journal.ts";

const ID = "19e6b462-17df-4bca-8bcb-c7e62c46ff4c";
const made: string[] = [];
const dirs = async () => { const d = await mkdtemp(join(tmpdir(), "hc-journal-")); made.push(d); return d; };
afterEach(async () => { for (const d of made.splice(0)) await rm(d, { recursive: true, force: true }); });

/** Another machine: a home holding the log, where the mirror's own script runs as hc exec would run it. */
async function machine(text: string) {
  const home = await dirs();
  const log = join(home, ".claude", "projects", "-work", `${ID}.jsonl`);
  await mkdir(join(log, ".."), { recursive: true });
  await writeFile(log, text);
  const calls: string[][] = [];
  const exec: HcExec = async (_m, argv) => {
    calls.push(argv);
    const child = Bun.spawn(argv, { env: { PATH: process.env.PATH, HOME: home }, stdout: "pipe" });
    const [out, code] = await Promise.all([new Response(child.stdout).bytes(), child.exited]);
    if (code !== 0) throw new Error(`exit ${code}`);
    return out;
  };
  return { log, exec, calls };
}
const copyOf = async (root: string) => {
  const [folder] = await readdir(root);
  return readFile(join(root, folder!, `${ID}.jsonl`), "utf8");
};
/** Follow until the copy stops changing: each follow is at most one read. */
const settle = async (mirror: HcJournalMirror, root: string) => {
  for (let last = ""; ;) {
    await mirror.follow("rise-l", ID);
    await Bun.sleep(60);
    const now = await copyOf(root);
    if (now === last) return now;
    last = now;
  }
};

describe("HcJournalMirror", () => {
  test("the first read brings the log; a later one only what was added", async () => {
    const dir = await dirs();
    const { log, exec, calls } = await machine("one\n");
    const mirror = new HcJournalMirror(dir, exec);
    await mirror.follow("rise-l", ID);
    expect(await copyOf(join(dir, "projects"))).toBe("one\n");
    await appendFile(log, "two\n");
    await mirror.follow("rise-l", ID);
    await Bun.sleep(60);
    expect(await copyOf(join(dir, "projects"))).toBe("one\ntwo\n");
    expect(calls[1]!.slice(5, 7)).toEqual(["4", "0"]);
    mirror.stop();
  });

  test("a long log opens on its newest bytes and fills in its past behind them, up to the cap", async () => {
    const dir = await dirs();
    const text = Array.from({ length: 40 }, (_, i) => `row ${String(i).padStart(2, "0")}\n`).join("");
    const { log, exec } = await machine(text);
    const mirror = new HcJournalMirror(dir, exec, Date.now, { first: 35, chunk: 70, cap: 300 });
    await mirror.follow("rise-l", ID);
    expect(await copyOf(join(dir, "projects"))).toBe(text.slice(-35));
    await appendFile(log, "row 40\n");
    expect(await settle(mirror, join(dir, "projects"))).toBe((text + "row 40\n").slice(-300));
    mirror.stop();
  });

  test("a burst longer than a read starts the copy over on the newest bytes", async () => {
    const dir = await dirs();
    const { log, exec } = await machine("first\n");
    const mirror = new HcJournalMirror(dir, exec, Date.now, { first: 20, chunk: 20, cap: 20 });
    await mirror.follow("rise-l", ID);
    await appendFile(log, "a much longer burst of rows\n");
    await mirror.follow("rise-l", ID);
    await Bun.sleep(60);
    expect(await copyOf(join(dir, "projects"))).toBe("first\na much longer burst of rows\n".slice(-20));
    mirror.stop();
  });

  test("a log that shrank starts the copy over", async () => {
    const dir = await dirs();
    const { log, exec } = await machine("a long first log\n");
    const mirror = new HcJournalMirror(dir, exec);
    await mirror.follow("rise-l", ID);
    await writeFile(log, "new\n");
    await mirror.follow("rise-l", ID);
    await Bun.sleep(60);
    expect(await copyOf(join(dir, "projects"))).toBe("new\n");
    mirror.stop();
  });

  test("a read cut short leaves the copy as it was", async () => {
    const dir = await dirs();
    const { exec } = await machine("one\ntwo\n");
    const cut: HcExec = async (...a) => (await exec(...a)).subarray(0, -2);
    const mirror = new HcJournalMirror(dir, cut);
    await mirror.follow("rise-l", ID);
    expect(await readdir(join(dir, "projects")).catch(() => [])).toEqual([]);
    mirror.stop();
  });

  test("an id that is not a uuid never reaches the machine", async () => {
    const dir = await dirs();
    const { exec, calls } = await machine("x");
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
