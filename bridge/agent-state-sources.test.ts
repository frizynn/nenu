import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ClaudeTurnScan,
  claudeLimit,
  claudeSessionDirs,
  claudeTurn,
  CodexTurnScan,
  codexTurn,
  decodeClaudeSession,
  foregroundPids,
  newestRollout,
  sameProcStart,
} from "./agent-state-sources.ts";

// Real files from a disposable Herdr 0.9.3 session on 2026-10-11 (Claude Code 2.1.296 with a custom
// statusLine, Codex 0.162.1 --no-daemon), message text cut to a few words.
const FIXTURES = join(import.meta.dirname, "test-support", "agent-state");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const session = (status: string) => fixture(`claude-2.1.296-session-${status}.json`);
const lines = (name: string) => fixture(name).split("\n").filter(Boolean);
const ROLLOUT_A = "codex-0.162.1-rollout-2026-10-11T15-03-30-01a12b0f-ada4-7d12-b0d2-30807b9fe152.jsonl";
const ROLLOUT_B = "codex-0.162.1-rollout-2026-10-11T15-04-38-01a12b10-b86b-7781-9182-b55f713c7ee2.jsonl";

describe("Claude session file", () => {
  test("decodes every status Claude 2.1.296 wrote", () => {
    const pid = (status: string) => JSON.parse(session(status)).pid as number;
    expect(decodeClaudeSession(session("idle"), pid("idle"))).toMatchObject({ status: "idle", version: "2.1.296" });
    expect(decodeClaudeSession(session("busy"), pid("busy"))).toMatchObject({ status: "busy" });
    expect(decodeClaudeSession(session("shell"), pid("shell"))).toMatchObject({ status: "shell" });
    expect(decodeClaudeSession(session("waiting-permission-prompt"), pid("waiting-permission-prompt"))).toMatchObject({ status: "waiting", waitingFor: "permission prompt" });
  });

  test("refuses another pid, an unknown status, a missing timestamp or a non-interactive kind", () => {
    const row = JSON.parse(session("busy"));
    expect(decodeClaudeSession(session("busy"), row.pid + 1)).toBeNull();
    expect(decodeClaudeSession(JSON.stringify({ ...row, status: "compacting" }), row.pid)).toBeNull();
    expect(decodeClaudeSession(JSON.stringify({ ...row, statusUpdatedAt: undefined }), row.pid)).toBeNull();
    expect(decodeClaudeSession(JSON.stringify({ ...row, kind: "background" }), row.pid)).toBeNull();
    // Older files in the same folder carry no status at all (measured).
    expect(decodeClaudeSession(JSON.stringify({ procStart: row.procStart, pidDomain: "darwin" }), row.pid)).toBeNull();
    expect(decodeClaudeSession("{", row.pid)).toBeNull();
  });

  test("procStart is UTC in ps form; a local reading also matches, another start does not", () => {
    const utc = Date.parse("Sun Oct 11 12:59:42 2026 UTC");
    expect(sameProcStart("Sun Oct 11 12:59:42 2026", utc)).toBe(true);
    expect(sameProcStart("Sun Oct  11 12:59:42 2026", utc + 900)).toBe(true);
    expect(sameProcStart("Sun Oct 11 12:59:42 2026", Date.parse("Sun Oct 11 12:59:42 2026"))).toBe(true);
    expect(sameProcStart("Sun Oct 11 12:59:42 2026", utc + 60_000)).toBe(false);
  });

  test("each profile's sessions folder sits next to its projects folder", () => {
    expect(claudeSessionDirs(["/h/.claude/projects", "/h/.claude-work/projects", "/h/.claude/projects"])).toEqual(["/h/.claude/sessions", "/h/.claude-work/sessions"]);
  });
});

describe("Claude turn", () => {
  const file = (status: "idle" | "busy" | "waiting" | "shell", extra: object = {}) => ({ pid: 1, sessionId: "s", status, statusUpdatedAt: 1_000, ...extra });
  const scan = (lastMove: number, lastEnd: number, queued = 0) => ({ lastMove, lastEnd, queued });

  test("idle, shell and a dialog are not a turn Escape should reach", () => {
    expect(claudeTurn(file("idle"), null)).toEqual({ running: false, source: "claude-session" });
    expect(claudeTurn(file("shell"), null)).toEqual({ running: false, background: true, source: "claude-session" });
    expect(claudeTurn(file("waiting", { waitingFor: "permission prompt" }), null)).toEqual({ running: false, waiting: "permission prompt", source: "claude-session" });
  });

  test("the usage limit holds only a Claude at rest", () => {
    const limit = { resetsAt: 5_000 };
    expect(claudeTurn(file("idle"), null, undefined, limit)).toEqual({ running: false, limit, source: "claude-session" });
    expect(claudeTurn(file("shell"), null, undefined, limit)).toEqual({ running: false, background: true, limit, source: "claude-session" });
    expect(claudeTurn(file("waiting", { waitingFor: "permission prompt" }), null, undefined, limit)).not.toHaveProperty("limit");
    expect(claudeTurn(file("busy"), null, undefined, limit)).not.toHaveProperty("limit");
  });

  test("busy is a running turn until this busy spell's transcript ends one", () => {
    expect(claudeTurn(file("busy"), null)).toEqual({ running: true, source: "claude-session" });
    expect(claudeTurn(file("busy"), scan(1_200, 900))).toEqual({ running: true, queued: null, source: "claude-session" });
    // The main turn ended at 1500 and nothing moved since: what keeps it busy is delegated work.
    expect(claudeTurn(file("busy"), scan(1_400, 1_500))).toEqual({ running: false, background: true, source: "claude-session" });
    // A background agent handed back and a new turn is under way.
    expect(claudeTurn(file("busy"), scan(1_600, 1_500))).toMatchObject({ running: true });
    expect(claudeTurn(file("busy"), scan(1_200, 900, 1))).toMatchObject({ running: true, queued: "sends" });
  });

  test("the real transcript: interruptions end turns, its queue replays, sidechains are skipped", () => {
    const rows = lines("claude-2.1.296-transcript.jsonl");
    const s = new ClaudeTurnScan();
    let ends = 0;
    let queuedAtBanana = -1;
    for (const row of rows) {
      const before = s.lastEnd;
      s.line(row);
      if (s.lastEnd !== before) ends++;
      if (row.includes('"enqueue"') && row.includes("BANANA")) queuedAtBanana = s.queued;
    }
    expect(ends).toBeGreaterThanOrEqual(9);
    expect(queuedAtBanana).toBe(1);
    expect(s.queued).toBe(0);
    // The last rows: a turn ended, then a task notification arrived without starting another.
    expect(s.lastEnd).toBeGreaterThanOrEqual(s.lastMove);
  });

  test("a dialog answered inside the spell does not restart it: background stays background", () => {
    // Busy since 1000, the main turn ended at 1500, a background agent's permission prompt flipped the
    // file waiting and back to busy at 2000. The spell still began at 1000.
    expect(claudeTurn(file("busy", { statusUpdatedAt: 2_000 }), scan(1_400, 1_500), 1_000)).toEqual({ running: false, background: true, source: "claude-session" });
    // Without the spell's start the file's own timestamp is all there is, and it reads as a turn.
    expect(claudeTurn(file("busy", { statusUpdatedAt: 2_000 }), scan(1_400, 1_500))).toMatchObject({ running: true });
  });

  test("the main chain's end_turn row ends the turn even when turn_duration is held back", () => {
    // Claude defers turn_duration while teammates or detached tool calls run; the last assistant row
    // of the main chain still says end_turn.
    const s = new ClaudeTurnScan();
    const assistant = (at: string, stop_reason: string | null, extra: object = {}) => JSON.stringify({ type: "assistant", timestamp: at, message: { stop_reason, content: [] }, ...extra });
    s.line(JSON.stringify({ type: "user", timestamp: "2026-10-11T13:00:00.000Z", message: { content: "spawn a team" } }));
    s.line(assistant("2026-10-11T13:00:01.000Z", "tool_use"));
    s.line(assistant("2026-10-11T13:00:02.000Z", "end_turn", { isSidechain: true }));
    expect(s.lastEnd).toBe(-Infinity);
    s.line(assistant("2026-10-11T13:00:03.000Z", "end_turn"));
    expect(s.lastEnd).toBe(Date.parse("2026-10-11T13:00:03.000Z"));
    expect(s.lastEnd).toBeGreaterThanOrEqual(s.lastMove);
    // A Stop hook that blocks continues the turn: the next assistant row moves it again.
    s.line(assistant("2026-10-11T13:00:05.000Z", "tool_use"));
    expect(s.lastMove).toBeGreaterThan(s.lastEnd);
  });

  test("an interruption row ends the turn; a notification row does not move it", () => {
    const s = new ClaudeTurnScan();
    const user = (text: string, at: string, extra: object = {}) => JSON.stringify({ type: "user", timestamp: at, message: { role: "user", content: [{ type: "text", text }] }, ...extra });
    s.line(user("write an essay", "2026-10-11T13:00:00.000Z"));
    s.line(JSON.stringify({ type: "assistant", timestamp: "2026-10-11T13:00:01.000Z", message: { content: [] } }));
    s.line(user("[Request interrupted by user]", "2026-10-11T13:00:02.000Z"));
    s.line(user("<task-notification>\n<task-id>x</task-id>", "2026-10-11T13:00:03.000Z"));
    s.line(user("Another Claude session sent a message", "2026-10-11T13:00:04.000Z", { isMeta: true }));
    s.line(user("subagent prompt", "2026-10-11T13:00:05.000Z", { isSidechain: true }));
    expect(s.lastEnd).toBe(Date.parse("2026-10-11T13:00:02.000Z"));
    expect(s.lastMove).toBe(Date.parse("2026-10-11T13:00:01.000Z"));
  });
});

describe("Codex turn", () => {
  test("follows task_started to turn_aborted in a real rollout, and a late command does not reopen it", () => {
    const s = new CodexTurnScan();
    expect(codexTurn(s)).toBeNull();
    const seen: boolean[] = [];
    for (const row of lines(ROLLOUT_A)) {
      s.line(row);
      if (/"task_started"|"turn_aborted"|"task_complete"/.test(row)) seen.push(codexTurn(s)!.running);
    }
    expect(seen).toEqual([true, false, true, false, true, false, true, false]);
    // The last row is the aborted `sleep 20` finishing in the background under its old turn id.
    expect(lines(ROLLOUT_A).at(-1)).toContain("CommandExecution");
    expect(codexTurn(s)).toEqual({ running: false, source: "codex-rollout" });
  });

  test("a tail that starts mid-turn knows nothing until a turn row", () => {
    const s = new CodexTurnScan();
    s.line(JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant" } }));
    expect(codexTurn(s)).toBeNull();
  });

  test("after /new the newest thread's rollout wins", () => {
    const real = (name: string) => `/x/sessions/2026/10/11/${name.replace("codex-0.162.1-", "")}`;
    expect(newestRollout([real(ROLLOUT_B), real(ROLLOUT_A), "/x/thread-writer-locks/01a12b10.lock"])).toBe(real(ROLLOUT_B));
    expect(newestRollout(["/x/other.jsonl"])).toBeNull();
  });

  test("foreground pids come from Herdr's process_info", () => {
    // Herdr 0.9.3, measured: the native Claude binary is named after its version.
    const info = { foreground_process_group_id: 19413, foreground_processes: [{ argv: ["claude"], name: "2.1.296", pid: 19413 }, { pid: 77 }, { pid: -1 }], pane_id: "w1:p1", shell_pid: 19343 };
    expect(foregroundPids(info).sort()).toEqual([19413, 77].sort());
    expect(foregroundPids(null)).toEqual([]);
  });
});

// Claude 2.1.306's own rows around a usage limit, from the operator's coordinator on 2026-10-21 (the
// account hit its five-hour limit at 21:35, was switched, and the message at 22:00 went through).
describe("Claude usage limit", () => {
  const rows = lines("claude-2.1.306-transcript-usage-limit.jsonl");
  const RESETS = 1792632000 * 1000;
  const refusedAt = Date.parse("2026-10-21T21:40:08.786Z");

  test("the limit row names when it resets; a refused retry moves it, a reply clears it", () => {
    const scan = new ClaudeTurnScan();
    for (const row of rows.slice(0, 4)) scan.line(row);
    expect(scan.limit).toEqual({ at: Date.parse("2026-10-21T21:35:05.821Z"), resetsAt: RESETS });
    for (const row of rows.slice(4, 8)) scan.line(row);
    // The prompt at 21:40 was logged, and the limit refused it again.
    expect(scan.limit).toEqual({ at: refusedAt, resetsAt: RESETS });
    expect(scan.lastReply).toBe(-Infinity);
    for (const row of rows.slice(8)) scan.line(row);
    expect(scan.limit).toBeUndefined();
    expect(scan.lastReply).toBe(Date.parse("2026-10-21T22:00:15.612Z"));
  });

  test("it holds until the reset, or until a reply on the same account after it", () => {
    const scan = { limit: { at: refusedAt, resetsAt: RESETS } };
    expect(claudeLimit(scan, -Infinity, refusedAt + 1)).toEqual({ resetsAt: RESETS });
    expect(claudeLimit(scan, refusedAt - 1, refusedAt + 1)).toEqual({ resetsAt: RESETS });
    expect(claudeLimit(scan, refusedAt + 5, refusedAt + 10)).toBeUndefined();
    expect(claudeLimit(scan, -Infinity, RESETS)).toBeUndefined();
    expect(claudeLimit(null, -Infinity, 0)).toBeUndefined();
  });

  test("a limit row without a reset time, or another API error, holds nothing and clears nothing", () => {
    const scan = new ClaudeTurnScan();
    const refused = JSON.parse(rows[1]!);
    scan.line(JSON.stringify({ ...refused, quotaLimits: undefined, apiErrorParams: undefined }));
    expect(scan.limit).toBeUndefined();
    scan.line(rows[1]!);
    scan.line(JSON.stringify({ ...refused, apiError: "overloaded", timestamp: "2026-10-21T21:36:00.000Z" }));
    expect(scan.limit?.resetsAt).toBe(RESETS);
    expect(scan.lastReply).toBe(-Infinity);
    // Claude's own "No response requested." around a resume is no reply from the account (measured).
    scan.line(JSON.stringify({ type: "assistant", timestamp: "2026-10-21T21:37:00.000Z", isApiErrorMessage: false, message: { model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] } }));
    expect(scan.limit?.resetsAt).toBe(RESETS);
    expect(scan.lastReply).toBe(-Infinity);
  });
});
