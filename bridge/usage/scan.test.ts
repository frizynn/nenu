import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountBook, accountHash } from "./accounts.ts";
import { repoOf } from "./repos.ts";
import { emptyTotals, loadStore, readTotals, saveStore, scan, Seen, type ScanState, type Totals } from "./scan.ts";

let home = "";
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "nenu-usage-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

const usage = (o: Partial<Record<string, unknown>> = {}) => ({
  input_tokens: 10, cache_creation_input_tokens: 300, cache_read_input_tokens: 1000, output_tokens: 50,
  server_tool_use: { web_search_requests: 0 }, service_tier: "standard",
  cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 200 }, ...o,
});
/** An assistant row in Claude Code's own key order (the scan reads it in place). */
const assistant = (o: { id: string; req: string; ts: string; model?: string; usage?: object; cwd?: string; after?: object; content?: string }) => JSON.stringify({
  parentUuid: null, isSidechain: false,
  message: {
    model: o.model ?? "claude-opus-5-5", id: o.id, type: "message", role: "assistant",
    content: [{ type: "text", text: o.content ?? "hello" }], stop_reason: null, usage: o.usage ?? usage(), ...(o.after ?? {}),
  },
  requestId: o.req, type: "assistant", uuid: `u-${o.id}-${Math.random()}`, timestamp: o.ts, cwd: o.cwd ?? "/work/demo", sessionId: "s", version: "2.1.0",
});
const toolResult = (ts: string) => JSON.stringify({ type: "user", message: { role: "user", content: "x" }, toolUseResult: { usage: { input_tokens: 999, output_tokens: 999 } }, timestamp: ts });

function setup() {
  const claude = join(home, ".claude");
  const codex = join(home, ".codex");
  const project = join(claude, "projects", "-work-demo");
  mkdirSync(project, { recursive: true });
  mkdirSync(join(codex, "sessions", "2026", "01", "10"), { recursive: true });
  const totals: Totals = emptyTotals("2026-01-10", "UTC");
  const state: ScanState = { v: 1, files: {}, dirs: {}, cwds: {} };
  const seen = new Seen();
  const run = (opts: { chunk?: number; book?: AccountBook } = {}) => scan({
    roots: { claude: [{ configDir: claude }], codex: [codex] }, state, totals, seen,
    book: opts.book ?? new AccountBook([]), repoOf: (cwd) => repoOf(cwd, home), chunk: opts.chunk,
  });
  const sum = (agent: "claude" | "codex") => {
    const s = [0, 0, 0, 0, 0, 0, 0];
    for (const day of Object.values(totals.days)) for (const [k, v] of Object.entries(day)) if (k.startsWith(`${agent}|`)) v.forEach((n, i) => (s[i]! += n));
    return s;
  };
  return { claude, codex, project, totals, state, seen, run, sum };
}

describe("Claude transcripts", () => {
  test("a response written once per content block counts once, with its cache split", () => {
    const t = setup();
    const row = { id: "msg_1", req: "req_1", ts: "2026-01-10T12:00:00.000Z" };
    writeFileSync(join(t.project, "s1.jsonl"), `${assistant(row)}\n${assistant({ ...row, content: "second block" })}\n`);
    const r = t.run();
    expect(r.rows).toBe(1);
    expect(r.duplicates).toBe(1);
    // [rows, input, output, write 5m, write 1h, cache read, reasoning]
    expect(t.sum("claude")).toEqual([1, 10, 50, 200, 100, 1000, 0]);
  });

  test("a nested object after usage does not hide the row (it did in the first prototype)", () => {
    const t = setup();
    const after = { context_management: { applied_edits: [{ type: "clear_tool_uses_20250919" }] }, diagnostics: null };
    writeFileSync(join(t.project, "s1.jsonl"), `${assistant({ id: "msg_1", req: "r", ts: "2026-01-10T12:00:00.000Z", after })}\n`);
    expect(t.run().rows).toBe(1);
  });

  test("only top-level usage counts, not the per-iteration copies inside it", () => {
    const t = setup();
    const u = usage({ iterations: [{ input_tokens: 7777, output_tokens: 7777 }], speed: "standard" });
    writeFileSync(join(t.project, "s1.jsonl"), `${assistant({ id: "msg_1", req: "r", ts: "2026-01-10T12:00:00.000Z", usage: u })}\n`);
    t.run();
    expect(t.sum("claude")[1]).toBe(10);
    expect(t.sum("claude")[2]).toBe(50);
  });

  test("tool results carrying a usage object and synthetic rows are not billed", () => {
    const t = setup();
    writeFileSync(join(t.project, "s1.jsonl"), [
      toolResult("2026-01-10T12:00:00.000Z"),
      assistant({ id: "msg_2", req: "r2", ts: "2026-01-10T12:00:01.000Z", model: "<synthetic>" }),
    ].join("\n") + "\n");
    expect(t.run().rows).toBe(0);
  });

  test("fast mode and Haiku's long prompts keep their own model key for pricing", () => {
    const t = setup();
    writeFileSync(join(t.project, "s1.jsonl"), [
      assistant({ id: "msg_1", req: "a", ts: "2026-01-10T12:00:00.000Z", usage: usage({ speed: "fast" }) }),
      assistant({ id: "msg_2", req: "b", ts: "2026-01-10T12:00:01.000Z", model: "claude-haiku-5-5", usage: usage({ cache_read_input_tokens: 200_000 }) }),
    ].join("\n") + "\n");
    t.run();
    const models = Object.keys(t.totals.days["2026-01-10"]!).map((k) => k.split("|")[2]);
    expect(models.sort()).toEqual(["claude-haiku-5-5+long", "claude-opus-5-5+fast"]);
  });

  test("a half-written last line is read when it is finished, and nothing twice", () => {
    const t = setup();
    const file = join(t.project, "s1.jsonl");
    const second = assistant({ id: "msg_2", req: "b", ts: "2026-01-10T12:00:01.000Z" });
    writeFileSync(file, `${assistant({ id: "msg_1", req: "a", ts: "2026-01-10T12:00:00.000Z" })}\n${second.slice(0, 40)}`);
    expect(t.run().rows).toBe(1);
    appendFileSync(file, `${second.slice(40)}\n`);
    const r = t.run();
    expect(r.rows).toBe(1);
    expect(r.bytes).toBe(second.length + 1);
    expect(t.run().read).toBe(0);
  });

  test("a line longer than the read buffer is skipped through, and read back once when it is a row", () => {
    const t = setup();
    const big = assistant({ id: "msg_1", req: "a", ts: "2026-01-10T12:00:00.000Z", content: "x".repeat(20_000) });
    writeFileSync(join(t.project, "s1.jsonl"), `${"{\"type\":\"user\",\"pad\":\"" + "y".repeat(30_000) + "\"}"}\n${big}\n${assistant({ id: "msg_2", req: "b", ts: "2026-01-10T12:00:01.000Z" })}\n`);
    const r = t.run({ chunk: 4096 });
    expect(r.rows).toBe(2);
  });

  test("a message copied into a subagent's or a resumed transcript counts once", () => {
    const t = setup();
    const row = assistant({ id: "msg_1", req: "a", ts: "2026-01-10T12:00:00.000Z" });
    mkdirSync(join(t.project, "s1", "subagents"), { recursive: true });
    writeFileSync(join(t.project, "s1.jsonl"), `${row}\n`);
    writeFileSync(join(t.project, "s1", "subagents", "agent-1.jsonl"), `${row}\n`);
    expect(t.run().rows).toBe(1);
  });

  test("the seen set survives a save, so a later copy still counts once", () => {
    const t = setup();
    const row = assistant({ id: "msg_1", req: "a", ts: "2026-01-10T12:00:00.000Z" });
    writeFileSync(join(t.project, "s1.jsonl"), `${row}\n`);
    t.run();
    const state = join(home, "state");
    mkdirSync(state);
    saveStore(state, { totals: t.totals, state: t.state, seen: t.seen }, Date.parse("2026-01-10T13:00:00Z"));
    const store = loadStore(state, "2026-01-10", "UTC");
    writeFileSync(join(t.project, "s2.jsonl"), `${row}\n`);
    // A folder is listed again only once its mtime moves; two writes inside one tick of the file
    // system's clock would leave s2 unlisted, so the folder is dated as a later scan would find it.
    const later = new Date(Date.now() + 60_000);
    utimesSync(t.project, later, later);
    const r = scan({
      roots: { claude: [{ configDir: t.claude }], codex: [] }, ...store, book: new AccountBook([]), repoOf: (cwd) => repoOf(cwd, home),
    });
    expect(r).toMatchObject({ rows: 0, duplicates: 1 });
  });

  test("a scan told to stop (its bridge is gone) reads no further log and counts nothing", () => {
    const t = setup();
    writeFileSync(join(t.project, "s1.jsonl"), `${assistant({ id: "msg_1", req: "a", ts: "2026-01-10T12:00:00.000Z" })}\n`);
    const r = scan({
      roots: { claude: [{ configDir: t.claude }], codex: [] }, state: t.state, totals: t.totals, seen: t.seen,
      book: new AccountBook([]), repoOf: (cwd) => repoOf(cwd, home), stop: () => true,
    });
    expect(r).toMatchObject({ stopped: true, read: 0, rows: 0 });
    expect(t.totals.days).toEqual({});
  });

  test("each message goes to the account active when it was written", () => {
    const t = setup();
    writeFileSync(join(t.project, "s1.jsonl"), [
      assistant({ id: "msg_1", req: "a", ts: "2026-01-10T10:00:00.000Z" }),
      assistant({ id: "msg_2", req: "b", ts: "2026-01-10T12:00:00.000Z" }),
    ].join("\n") + "\n");
    const book = new AccountBook([
      { at: Date.parse("2026-01-10T09:00:00Z"), harness: "claude", account: "claude:aaaaaaaaaaaaaaaa", configDir: t.claude },
      { at: Date.parse("2026-01-10T11:00:00Z"), harness: "claude", account: "claude:bbbbbbbbbbbbbbbb", configDir: t.claude },
    ]);
    t.run({ book });
    const accounts = Object.keys(t.totals.days["2026-01-10"]!).map((k) => k.split("|")[1]).sort();
    expect(accounts).toEqual(["claude:aaaaaaaaaaaaaaaa", "claude:bbbbbbbbbbbbbbbb"]);
  });
});

describe("Codex rollouts", () => {
  const meta = (account?: string) => JSON.stringify({ timestamp: "2026-01-10T12:00:00.000Z", type: "session_meta", payload: { id: "r1", cwd: "/work/demo", base_instructions: { text: "say \"cwd\":\"/nope\"" }, ...(account ? { creator_account_id: account } : {}) } });
  const turn = (model: string) => JSON.stringify({ timestamp: "2026-01-10T12:00:01.000Z", type: "turn_context", payload: { cwd: "/work/demo", model } });
  const tokens = (ts: string, total: number[], last?: number[], limits?: object) => JSON.stringify({
    timestamp: ts, type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: total[0], cached_input_tokens: total[1], output_tokens: total[2], reasoning_output_tokens: total[3], total_tokens: 0 },
        last_token_usage: last ? { input_tokens: last[0], cached_input_tokens: last[1], output_tokens: last[2], reasoning_output_tokens: last[3] } : null,
      },
      rate_limits: limits ?? null,
    },
  });

  test("cumulative totals become differences; a reset counts its own row", () => {
    const t = setup();
    const file = join(t.codex, "sessions", "2026", "01", "10", "rollout-2026-01-10T12-00-00-r1.jsonl");
    writeFileSync(file, [
      meta("acct-1"),
      turn("gpt-6.1-sol"),
      tokens("2026-01-10T12:00:02.000Z", [100, 60, 10, 4]),
      tokens("2026-01-10T12:00:03.000Z", [100, 60, 10, 4]),
      tokens("2026-01-10T12:00:04.000Z", [250, 160, 30, 9], undefined, { primary: { used_percent: 12.5, window_minutes: 10080, resets_at: 1768000000 }, secondary: null, plan_type: "plus" }),
      tokens("2026-01-10T12:00:05.000Z", [20, 0, 5, 0], [20, 0, 5, 0]),
    ].join("\n") + "\n");
    const r = t.run();
    expect(r.rows).toBe(3);
    // input is the uncached part: (100-60) + (150-100) + 20
    expect(t.sum("codex")).toEqual([3, 110, 35, 0, 0, 160, 9]);
    const key = Object.keys(t.totals.days["2026-01-10"]!)[0]!;
    expect(key).toBe(`codex|codex:${accountHash("acct-1")}|gpt-6.1-sol|${repoOf("/work/demo", home).key}`);
    expect(t.totals.codexLimits[`codex:${accountHash("acct-1")}`]).toEqual({
      observedAt: Date.parse("2026-01-10T12:00:04.000Z"), plan: "plus", windows: [{ windowMinutes: 10080, usedPercent: 12.5, resetsAt: 1768000000 }],
    });
  });

  test("an archived rollout is the same rollout, not new usage", () => {
    const t = setup();
    const name = "rollout-2026-01-10T12-00-00-r1.jsonl";
    writeFileSync(join(t.codex, "sessions", "2026", "01", "10", name), `${meta()}\n${tokens("2026-01-10T12:00:02.000Z", [100, 0, 10, 0])}\n`);
    expect(t.run().rows).toBe(1);
    mkdirSync(join(t.codex, "archived_sessions"), { recursive: true });
    renameSync(join(t.codex, "sessions", "2026", "01", "10", name), join(t.codex, "archived_sessions", name));
    expect(t.run().rows).toBe(0);
    expect(t.sum("codex")[0]).toBe(1);
  });
});

describe("projects", () => {
  test("a worktree counts with its repo; a home-folder .git is not the project", () => {
    mkdirSync(join(home, "src", "app", ".git", "worktrees", "feature"), { recursive: true });
    mkdirSync(join(home, "trees", "feature"), { recursive: true });
    writeFileSync(join(home, "trees", "feature", ".git"), `gitdir: ${join(home, "src", "app", ".git", "worktrees", "feature")}\n`);
    mkdirSync(join(home, ".git"));
    mkdirSync(join(home, "notes"));
    expect(repoOf(join(home, "trees", "feature"), home)).toEqual(repoOf(join(home, "src", "app", "sub"), home));
    expect(repoOf(join(home, "src", "app"), home).label).toBe("app");
    expect(repoOf(join(home, "notes"), home).label).toBe("notes");
    expect(repoOf(join(home, "gone", "worktree"), home).label).toBe("worktree");
  });
});

describe("the store on disk", () => {
  const codexLine = (ts: string, total: number[]) => JSON.stringify({
    timestamp: ts, type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: { input_tokens: total[0], cached_input_tokens: total[1], output_tokens: total[2], reasoning_output_tokens: 0 } } },
  });

  /** Two scans of growing logs; the second one's save stops at its `stopAt`-th rename (a restart, kill -9). */
  function twoScans(name: string, stopAt?: number) {
    const root = join(home, name);
    const project = join(root, ".claude", "projects", "-work-demo");
    const rollouts = join(root, ".codex", "sessions");
    mkdirSync(project, { recursive: true });
    mkdirSync(rollouts, { recursive: true });
    const stateDir = join(root, "state");
    mkdirSync(stateDir);
    const once = (stop?: number) => {
      const store = loadStore(stateDir, "2026-01-10", "UTC");
      scan({ roots: { claude: [{ configDir: join(root, ".claude") }], codex: [join(root, ".codex")] }, ...store, book: new AccountBook([]), repoOf: (cwd) => repoOf(cwd, home) });
      const rename = fs.renameSync;
      let renames = 0;
      const spy = stop === undefined ? undefined : spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (++renames === stop) throw new Error("stopped");
        rename(from, to);
      });
      try { saveStore(stateDir, store, Date.parse("2026-01-10T13:00:00Z")); } catch { /* the process died here */ } finally { spy?.mockRestore(); }
    };
    const claudeLog = join(project, "s1.jsonl");
    const codexLog = join(rollouts, "rollout-2026-01-10T12-00-00-r1.jsonl");
    writeFileSync(claudeLog, `${assistant({ id: "msg_1", req: "a", ts: "2026-01-10T12:00:00.000Z" })}\n`);
    writeFileSync(codexLog, `${codexLine("2026-01-10T12:00:00.000Z", [100, 0, 10])}\n`);
    once();
    appendFileSync(claudeLog, `${assistant({ id: "msg_2", req: "b", ts: "2026-01-10T12:01:00.000Z" })}\n`);
    appendFileSync(codexLog, `${codexLine("2026-01-10T12:01:00.000Z", [250, 0, 30])}\n`);
    once(stopAt);
    once();
    const sums: Record<string, number[]> = {};
    for (const day of Object.values(readTotals(stateDir)!.days)) for (const [k, v] of Object.entries(day)) {
      const s = (sums[k.split("|")[0]!] ??= [0, 0, 0, 0, 0, 0, 0]);
      v.forEach((n, i) => (s[i]! += n));
    }
    return sums;
  }

  test("a scan stopped anywhere in its save loses nothing and counts nothing twice", () => {
    const whole = twoScans("whole");
    expect(whole).toEqual({ claude: [2, 20, 100, 400, 200, 2000, 0], codex: [2, 250, 30, 0, 0, 0, 0] });
    for (let stopAt = 1; stopAt <= 6; stopAt++) expect({ stopAt, sums: twoScans(`stop-${stopAt}`, stopAt) }).toEqual({ stopAt, sums: whole });
  });
});
