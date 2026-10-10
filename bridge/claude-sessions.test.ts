import { expect, test } from "bun:test";
import { decodeClaudeSessions, matchClaudeSession } from "./claude-sessions.ts";

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
