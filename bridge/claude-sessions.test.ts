import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeSessionFiles, decodeClaudeSessions, matchClaudeSession } from "./claude-sessions.ts";

const SESSION = "0b6b2a52-5d5c-4c0e-9d5e-4f3f3c1a2b3c";
const BACKGROUND = "11111111-2222-4333-8444-555555555555";

// The row shapes `claude agents --json` printed on 2.1.296: interactive rows have a pid and no id,
// background rows an attach id and no pid.
const rows = [
  { pid: 100, cwd: "/w", kind: "interactive", startedAt: 1, sessionId: SESSION, name: "a", status: "busy" },
  { id: "bg1", cwd: "/w", kind: "background", startedAt: 2, sessionId: BACKGROUND, name: "b", state: "running" },
  { cwd: "/w", sessionId: "x" },
];

test("interactive rows without an id decode and match by pid", () => {
  const sessions = decodeClaudeSessions(rows);
  expect(sessions).toEqual([
    { pid: 100, sessionId: SESSION, cwd: "/w", startedAt: 1 },
    { id: "bg1", sessionId: BACKGROUND, cwd: "/w", startedAt: 2 },
  ]);
  expect(matchClaudeSession({ foreground_processes: [{ pid: 100, argv: ["claude"] }] }, sessions)).toBe(SESSION);
  expect(matchClaudeSession({ foreground_processes: [{ pid: 7, argv: ["claude", "attach", "bg1"] }] }, sessions)).toBe(BACKGROUND);
  expect(matchClaudeSession({ foreground_processes: [{ pid: 7, argv: ["claude", "attach", "nope"] }] }, sessions)).toBeNull();
});

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

// Shape of ~/.claude/sessions/<pid>.json on Claude Code 2.1.310 (Linux), trimmed.
const sessionFile = (pid: number, sessionId: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ pid, sessionId, cwd: "/w", startedAt: 1792838220862, procStart: "74264174", version: "2.1.310", kind: "interactive", status: "busy", ...extra });

async function sessionsDir(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "nenu-claude-sessions-")); dirs.push(dir);
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}

test("session files list live sessions whose process start matches, as `claude agents` does", async () => {
  const dir = await sessionsDir({
    [`${process.pid}.json`]: sessionFile(process.pid, SESSION),
    "999999999.json": sessionFile(999999999, BACKGROUND),
    "1.json": sessionFile(process.pid, BACKGROUND),
    "notes.json": sessionFile(process.pid, BACKGROUND),
    [`${process.pid}.key`]: "secret",
  });
  const checked: string[] = [];
  const files = new ClaudeSessionFiles([dir, join(dir, "missing")], async (pid, procStart) => { checked.push(`${pid}:${procStart}`); return true; });
  expect(await files.list()).toEqual([{ pid: process.pid, sessionId: SESSION, cwd: "/w", startedAt: 1792838220862 }]);
  expect(checked).toEqual([`${process.pid}:74264174`]);
  expect(await new ClaudeSessionFiles([dir], async () => false).list()).toEqual([]);
});

test("a file without procStart is kept on liveness alone, and a process start is checked once", async () => {
  const dir = await sessionsDir({ [`${process.pid}.json`]: sessionFile(process.pid, SESSION, { procStart: undefined }) });
  let checks = 0;
  const files = new ClaudeSessionFiles([dir], async () => { checks++; return true; });
  expect((await files.list()).map((s) => s.sessionId)).toEqual([SESSION]);
  expect(checks).toBe(0);
  await writeFile(join(dir, `${process.pid}.json`), sessionFile(process.pid, SESSION));
  const again = new ClaudeSessionFiles([dir], async () => { checks++; return true; });
  await again.list();
  (again as unknown as { cache: null }).cache = null;
  await again.list();
  expect(checks).toBe(1);
});

test.if(process.platform === "linux")("on Linux, procStart is the /proc start tick of the process", async () => {
  const stat = await Bun.file(`/proc/${process.pid}/stat`).text();
  const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!;
  const dir = await sessionsDir({ [`${process.pid}.json`]: sessionFile(process.pid, SESSION, { procStart: ticks }) });
  expect((await new ClaudeSessionFiles([dir]).list()).map((s) => s.sessionId)).toEqual([SESSION]);
  await writeFile(join(dir, `${process.pid}.json`), sessionFile(process.pid, SESSION, { procStart: String(Number(ticks) + 1) }));
  expect(await new ClaudeSessionFiles([dir]).list()).toEqual([]);
});
