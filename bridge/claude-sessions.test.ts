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

const starts = (ticks: string | null, lstart: number | null = null) => {
  const calls = { ticks: 0, lstart: 0 };
  return { calls, ticks: async () => { calls.ticks++; return ticks; }, lstart: async () => { calls.lstart++; return lstart; } };
};
const linux = process.platform === "linux";

test("session files list live sessions, oldest first, as `claude agents` does", async () => {
  const child = Bun.spawn(["sleep", "30"]);
  try {
    const dir = await sessionsDir({
      [`${child.pid}.json`]: sessionFile(child.pid, BACKGROUND, { startedAt: 1792838220000, procStart: undefined }),
      [`${process.pid}.json`]: sessionFile(process.pid, SESSION, { procStart: undefined }),
      "999999999.json": sessionFile(999999999, "22222222-2222-4333-8444-555555555555"),
      "1.json": sessionFile(process.pid, "33333333-2222-4333-8444-555555555555"),
      "notes.json": sessionFile(process.pid, "44444444-2222-4333-8444-555555555555"),
      [`${process.pid}.key`]: sessionFile(process.pid, "55555555-2222-4333-8444-555555555555"),
    });
    const files = new ClaudeSessionFiles([dir, join(dir, "missing")], 0, starts(null));
    expect(await files.list()).toEqual([
      { pid: child.pid, sessionId: BACKGROUND, cwd: "/w", startedAt: 1792838220000 },
      { pid: process.pid, sessionId: SESSION, cwd: "/w", startedAt: 1792838220862 },
    ]);
  } finally { child.kill(); }
});

test.if(linux)("on Linux the /proc start is read every time, so a pid taken by another process drops at once", async () => {
  const dir = await sessionsDir({ [`${process.pid}.json`]: sessionFile(process.pid, SESSION) });
  const proc = starts("74264174");
  const files = new ClaudeSessionFiles([dir], 0, proc);
  expect(await files.list()).toHaveLength(1);
  await files.list();
  expect(proc.calls).toEqual({ ticks: 2, lstart: 0 });
  expect(await new ClaudeSessionFiles([dir], 0, starts("1")).list()).toEqual([]);
  expect(await new ClaudeSessionFiles([dir], 0, starts(null)).list()).toHaveLength(1);
});

test("an lstart procStart is checked by ps once, and a failed read is never cached", async () => {
  const dir = await sessionsDir({ [`${process.pid}.json`]: sessionFile(process.pid, SESSION, { procStart: "Sun Oct 11 12:56:04 2026" }) });
  const failing = starts(null, null);
  const unknown = new ClaudeSessionFiles([dir], 0, failing);
  expect(await unknown.list()).toHaveLength(1);
  await unknown.list();
  expect(failing.calls.lstart).toBe(2);
  const ps = starts(null, Date.parse("Sun Oct 11 12:56:04 2026 UTC"));
  const files = new ClaudeSessionFiles([dir], 0, ps);
  expect(await files.list()).toHaveLength(1);
  await files.list();
  expect(ps.calls.lstart).toBe(1);
  expect(await new ClaudeSessionFiles([dir], 0, starts(null, 0)).list()).toEqual([]);
  await writeFile(join(dir, `${process.pid}.json`), sessionFile(process.pid, SESSION, { procStart: undefined }));
  expect(await new ClaudeSessionFiles([dir], 0, starts(null, 0)).list()).toHaveLength(1);
});

test.if(linux)("the default reader takes field 22 of /proc/<pid>/stat", async () => {
  // Bun's own command name has no spaces, so a plain split counts the fields independently.
  const ticks = (await Bun.file(`/proc/${process.pid}/stat`).text()).split(" ")[21]!;
  const dir = await sessionsDir({ [`${process.pid}.json`]: sessionFile(process.pid, SESSION, { procStart: ticks }) });
  expect((await new ClaudeSessionFiles([dir]).list()).map((s) => s.sessionId)).toEqual([SESSION]);
  await writeFile(join(dir, `${process.pid}.json`), sessionFile(process.pid, SESSION, { procStart: String(Number(ticks) + 1) }));
  expect(await new ClaudeSessionFiles([dir]).list()).toEqual([]);
});
