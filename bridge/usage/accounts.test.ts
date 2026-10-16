import { describe, expect, test } from "bun:test";
import { AccountBook, accountHash, claudeIdentity, codexAccount, formatSwitchLine, hatsStateDir, parseClaudeSwapLog, parseSwitchLog, UNASSIGNED } from "./accounts.ts";

// The switch log Nenu shares with hats, line for line as hats' own fixture writes it (fake ids).
const HATS = [
  '{"v":1,"at":"2026-01-02T03:04:05.678Z","harness":"claude","account":"9ae25bfbd05c9e76","label":"work","configDir":"/home/user/.local/share/hats/claude/work"}',
  '{"v":1,"at":"2026-01-02T03:10:00.000Z","harness":"claude","account":"9ae25bfbd05c9e76","label":"work","configDir":"/home/user/.local/share/hats/claude/work","session":"11111111-2222-4333-8444-555555555555"}',
  '{"v":1,"at":"2026-01-02T04:00:00.001Z","harness":"claude","account":"0123456789abcdef","label":"default","configDir":"/home/user/.claude","session":"11111111-2222-4333-8444-555555555555","reason":"limit"}',
  '{"v":1,"at":"2026-01-02T05:00:00.000Z","harness":"codex","account":"9a00cf1657c91b7f","label":"personal","configDir":"/home/user/.local/share/hats/codex/personal"}',
].join("\n");

const at = (iso: string) => Date.parse(iso);

describe("account ids", () => {
  test("a Claude account is sha256 of accountUuid:organizationUuid, as hats derives it", () => {
    expect(accountHash("00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-0000000000aa")).toBe("9ae25bfbd05c9e76");
  });

  test("the signed-in account is read from .claude.json without anything else in it", () => {
    const file = Buffer.from(JSON.stringify({
      numStartups: 3,
      oauthAccount: { accountUuid: "00000000-0000-4000-8000-000000000001", emailAddress: "user@host", organizationUuid: "00000000-0000-4000-8000-0000000000aa" },
    }));
    expect(claudeIdentity(file)).toBe("9ae25bfbd05c9e76");
    expect(claudeIdentity(Buffer.from('{"numStartups":3}'))).toBeUndefined();
  });

  test("a rollout without creator_account_id is unassigned", () => {
    expect(codexAccount(undefined)).toBe(UNASSIGNED.codex);
    expect(codexAccount("acct-1")).toBe(`codex:${accountHash("acct-1")}`);
  });
});

describe("switch logs", () => {
  test("hats lines parse, unknown fields are ignored and broken lines skipped", () => {
    const lines = parseSwitchLog(`${HATS}\nnot json\n{"v":2,"at":"2026-01-02T00:00:00Z"}\n`);
    expect(lines).toHaveLength(4);
    expect(lines[2]).toEqual({ at: at("2026-01-02T04:00:00.001Z"), harness: "claude", account: "claude:0123456789abcdef", label: "default", configDir: "/home/user/.claude", session: "11111111-2222-4333-8444-555555555555" });
  });

  test("Nenu writes its own lines in the same format", () => {
    const line = formatSwitchLine({ at: at("2026-01-02T03:04:05.678Z"), harness: "claude", account: "claude:9ae25bfbd05c9e76", configDir: "/home/user/.claude" });
    expect(parseSwitchLog(line)[0]).toEqual({ at: at("2026-01-02T03:04:05.678Z"), harness: "claude", account: "claude:9ae25bfbd05c9e76", configDir: "/home/user/.claude" });
  });

  test("claude-swap: an added account is the one signed in, a switch names the next", () => {
    const log = [
      "2026-01-02 10:00:00,123 - INFO - Added account 1",
      "2026-01-02 10:05:00,000 - DEBUG - Usage API something",
      "2026-01-02 11:00:00,000 - INFO - Switched from account 1 to 2",
    ].join("\n");
    const lines = parseClaudeSwapLog(log, "/home/user/.claude");
    expect(lines.map((l) => [l.account, l.label])).toEqual([["claude:swap-1", "Account 1"], ["claude:swap-2", "Account 2"]]);
    expect(lines[0]!.at).toBe(new Date("2026-01-02T10:00:00.123").getTime());
  });

  test("hats' state dir follows HATS_STATE_DIR, then XDG_STATE_HOME", () => {
    expect(hatsStateDir({ HATS_STATE_DIR: "/x" }, "/home/user")).toBe("/x");
    expect(hatsStateDir({ XDG_STATE_HOME: "/s" }, "/home/user")).toBe("/s/hats");
    expect(hatsStateDir({}, "/home/user")).toBe("/home/user/.local/state/hats");
  });
});

describe("which account a message was billed to", () => {
  const book = new AccountBook(parseSwitchLog(HATS));
  const session = "11111111-2222-4333-8444-555555555555";
  const work = "/home/user/.local/share/hats/claude/work";

  test("a session's own line wins, and a later one (a resume on another account) takes over", () => {
    expect(book.claude(work, session, at("2026-01-02T03:30:00Z"))).toBe("claude:9ae25bfbd05c9e76");
    expect(book.claude(work, session, at("2026-01-02T04:30:00Z"))).toBe("claude:0123456789abcdef");
  });

  test("without a session line, the config dir's last line before the message", () => {
    expect(book.claude(work, "other", at("2026-01-02T03:05:00Z"))).toBe("claude:9ae25bfbd05c9e76");
  });

  test("a dir that only ever showed one account owns its earlier history", () => {
    expect(book.claude(work, "other", at("2025-12-01T00:00:00Z"))).toBe("claude:9ae25bfbd05c9e76");
  });

  test("before the first switch of a dir with several accounts, nobody", () => {
    const swap = parseClaudeSwapLog("2026-01-02 10:00:00,000 - INFO - Added account 1\n2026-01-02 11:00:00,000 - INFO - Switched from account 1 to 2", "/home/user/.claude");
    const b = new AccountBook(swap, new Set(["/home/user/.claude"]));
    expect(b.claude("/home/user/.claude", "s", new Date("2026-01-02T09:00:00").getTime())).toBe(UNASSIGNED.claude);
    expect(b.claude("/home/user/.claude", "s", new Date("2026-01-02T10:30:00").getTime())).toBe("claude:swap-1");
    expect(b.claude("/home/user/.claude", "s", new Date("2026-01-02T12:00:00").getTime())).toBe("claude:swap-2");
  });

  test("with claude-swap's log, Nenu's own sightings of that dir do not add a second name", () => {
    const own = parseSwitchLog('{"v":1,"at":"2026-01-02T12:30:00.000Z","harness":"claude","account":"0123456789abcdef","configDir":"/home/user/.claude"}');
    const swap = parseClaudeSwapLog("2026-01-02 11:00:00,000 - INFO - Switched from account 1 to 2", "/home/user/.claude");
    const b = new AccountBook([...own, ...swap], new Set(["/home/user/.claude"]));
    expect(b.claude("/home/user/.claude", "s", Date.parse("2026-01-03T00:00:00Z"))).toBe("claude:swap-2");
  });

  test("one account and nothing else: all of it is that account", () => {
    const own = parseSwitchLog('{"v":1,"at":"2026-01-05T00:00:00.000Z","harness":"claude","account":"0123456789abcdef","configDir":"/home/user/.claude"}');
    expect(new AccountBook(own).claude("/home/user/.claude", "s", Date.parse("2026-01-01T00:00:00Z"))).toBe("claude:0123456789abcdef");
    expect(new AccountBook(own).history("/home/user/.claude")).toEqual([{ account: "claude:0123456789abcdef", since: Date.parse("2026-01-05T00:00:00Z") }]);
  });
});
