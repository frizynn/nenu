import { mkdirSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import type { FakeHerdr } from "../../bridge/test-support/fake-herdr.ts";

// The demo herd every e2e run starts from: one Claude pane working (screen ticking, journal
// growing), one idle, one blocked on a real captured permission dialog, a Codex pane and a shell.
// Content is synthetic; the dialog comes from the repo's own fixture corpus.

export interface DemoHerd {
  working: string;
  idle: string;
  blocked: string;
  codex: string;
  shell: string;
  /** Claude journal file per pane id. */
  journals: Map<string, string>;
  dialog: string;
}

const FIXTURES = resolve(import.meta.dir, "../../web/src/fixtures/panes");
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** The dialog half of a captured screen: everything below its last horizontal rule. */
export async function fixtureDialog(name: string): Promise<string> {
  const rows = stripAnsi(await readFile(join(FIXTURES, `${name}.txt`), "utf8")).trimEnd().split("\n");
  const rule = rows.findLastIndex((r) => /^─{20,}/.test(r));
  return rows.slice(rule + 1).join("\n");
}

let seq = 0;
function journalRow(type: "user" | "assistant", text: string, parentUuid: string | null, at: number): { uuid: string; line: string } {
  const uuid = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  const message = type === "user" ? { role: "user", content: text } : { role: "assistant", content: [{ type: "text", text }] };
  return { uuid, line: JSON.stringify({ type, uuid, parentUuid, timestamp: new Date(at).toISOString(), message }) + "\n" };
}

function journalLines(turns: Array<["user" | "assistant", string]>, at: number): { body: string; last: string | null } {
  let parent: string | null = null;
  let body = "";
  for (const [type, text] of turns) {
    const row = journalRow(type, text, parent, at);
    body += row.line;
    parent = row.uuid;
  }
  return { body, last: parent };
}

export async function writeJournal(file: string, turns: Array<["user" | "assistant", string]>, at: number): Promise<string | null> {
  const { body, last } = journalLines(turns, at);
  await writeFile(file, body);
  return last;
}

/** Add turns to a seeded journal, as the agent would while working. */
export async function appendJournal(file: string, turns: Array<["user" | "assistant", string]>, at: number): Promise<void> {
  await appendFile(file, journalLines(turns, at).body);
}

/** `shift` moves journal timestamps onto the bench clock (bridge.ts `epoch`). */
export async function seedDemoHerd(fake: FakeHerdr, opts: { claudeRoot: string; cwd: string; shift: number }): Promise<DemoHerd> {
  const projectDir = join(opts.claudeRoot, "-tmp-nenu-e2e");
  await mkdir(projectDir, { recursive: true });
  const ids = { working: "w1:working", idle: "w1:idle", blocked: "w2:blocked" };
  const sessions = {
    working: "11111111-1111-4111-8111-111111111111",
    idle: "22222222-2222-4222-8222-222222222222",
    blocked: "33333333-3333-4333-8333-333333333333",
  };
  const journals = new Map<string, string>();
  for (const key of Object.keys(ids) as Array<keyof typeof ids>) {
    const file = join(projectDir, `${sessions[key]}.jsonl`);
    journals.set(ids[key], file);
    await writeJournal(file, [
      ["user", `Demo task for the ${key} pane`],
      ["assistant", `Looking at the ${key} pane now.`],
    ], Date.now() + opts.shift);
  }
  const dialog = await fixtureDialog("claude--permission-bash");

  fake.addWorkspace("w1", "nenu").addWorkspace("w2", "api");
  fake.addTab("w1:t1", "redesign").addTab("w1:t2", "review").addTab("w2:t1", "server");
  const pane = (paneId: string, tabId: string, agent: "claude" | "codex" | null, label: string, sessionId?: string) =>
    fake.addPane({
      paneId, workspaceId: paneId.split(":")[0]!, tabId, agent, label, sessionId, cwd: opts.cwd,
      lines: agent === "claude" ? [`❯ Demo task for ${label}`, "", `● Looking at ${label} now.`] : [],
    });
  pane("w1:working", "w1:t1", "claude", "Working Claude", sessions.working);
  pane("w1:idle", "w1:t2", "claude", "Idle Claude", sessions.idle);
  pane("w2:blocked", "w2:t1", "claude", "Blocked Claude", sessions.blocked);
  pane("w2:codex", "w2:t1", "codex", "Codex");
  pane("w2:shell", "w2:t1", null, "Shell");
  fake.setStatus("w1:working", "working");
  fake.setDialog(ids.blocked, dialog);

  return { ...ids, codex: "w2:codex", shell: "w2:shell", journals, dialog };
}

/**
 * A finished Claude conversation shaped as Claude Code 2.1 writes it: tool calls with their results,
 * an `end_turn` answer and the `turn_duration` row after it. Two turns (1m 52s and 14s) whose answers
 * name pull requests as Markdown links and as a bare URL; `repeat` copies them for a long thread.
 * `tail` adds a third turn, still running (a step done, a note, a command waiting for its output) or
 * finished; written again with the same `at`, the running file only grows into the finished one.
 * Synthetic content.
 */
export async function writeChatJournal(file: string, at: number, repeat = 1, tail: "none" | "running" | "finished" = "none"): Promise<void> {
  const pr = (n: number) => `https://github.com/acme/shop/pull/${n}`;
  let body = "";
  let parent: string | null = null;
  let clock = at - repeat * 16 * 60_000;
  let n = 0;
  const row = (fields: Record<string, unknown>) => {
    // Its own first uuid per file: the bridge follows a conversation across files by that root.
    const uuid = `${basename(file).slice(0, 8)}-0000-4000-9000-${String(++n).padStart(12, "0")}`;
    body += JSON.stringify({ uuid, parentUuid: parent, timestamp: new Date(clock).toISOString(), isSidechain: false, ...fields }) + "\n";
    parent = uuid;
  };
  const user = (content: unknown) => row({ type: "user", message: { role: "user", content } });
  const assistant = (stop: "tool_use" | "end_turn", content: unknown[]) => row({ type: "assistant", message: { id: `msg_${n + 1}`, role: "assistant", stop_reason: stop, content } });
  const call = (name: string, input: Record<string, string>, output: string, ms: number) => {
    const id = `toolu_${n + 1}`;
    assistant("tool_use", [{ type: "tool_use", id, name, input }]);
    clock += ms;
    user([{ type: "tool_result", tool_use_id: id, content: output }]);
  };
  const turn = (ask: string, calls: Array<[string, Record<string, string>, string]>, answer: string, ms: number) => {
    user(ask);
    const start = clock;
    for (const [name, input, output] of calls) call(name, input, output, Math.floor(ms / (calls.length + 1)));
    clock = start + ms;
    assistant("end_turn", [{ type: "text", text: answer }]);
    row({ type: "system", subtype: "turn_duration", durationMs: ms, isMeta: false });
    clock += 60_000;
  };
  for (let i = 0; i < repeat; i++) {
    turn("The coupon field overflows on a phone. Fix it, then tell me where the open pull requests stand.", [
      ["Read", { file_path: "app/cart.ts" }, "export function cartTotals() {}"],
      ["Edit", { file_path: "app/cart.ts", old_string: "a", new_string: "b" }, "The file app/cart.ts has been updated."],
      ["Bash", { command: "bun test app/cart.test.ts" }, "3 pass\n0 fail"],
    ], [
      "The coupon field now sits under the total, so nothing overflows at 390 px. The discount is applied in `app/cart.ts` and the totals test covers it.",
      "",
      "Three pull requests are open in this project:",
      "",
      `1. [#42](${pr(42)}) Checkout flow: 3 files, +44 −16. Checks are running.`,
      `2. [#41](${pr(41)}) Cart badge: approved, 6 of 6 checks passed. Ready to merge.`,
      `3. [#38](${pr(38)}) Order history: 2 review comments to answer.`,
      "",
      `I recommend merging ${pr(41)} first; it does not touch the checkout.`,
    ].join("\n"), 112_000);
    turn("Looks good. Also check the empty-cart state before you push.", [
      ["Edit", { file_path: "app/cart.tsx", old_string: "a", new_string: "b" }, "The file app/cart.tsx has been updated."],
    ], `The empty cart now shows a single "Browse products" button. The cart tests pass, and it is pushed to [#42](${pr(42)}).`, 14_000);
  }
  if (tail !== "none") {
    user("Run the cart tests again, then push to the checkout branch.");
    const start = clock;
    call("Read", { file_path: "app/cart.test.ts" }, "describe(\"cart\")", 20_000);
    clock += 15_000;
    const id = `toolu_${n + 1}`;
    assistant("tool_use", [{ type: "text", text: "The totals test still covers the coupon, so this run checks both." },
      { type: "tool_use", id, name: "Bash", input: { command: "bun test app/cart.test.ts" } }]);
    if (tail === "finished") {
      clock = start + 75_000;
      user([{ type: "tool_result", tool_use_id: id, content: "5 pass\n0 fail" }]);
      assistant("end_turn", [{ type: "text", text: `The cart tests pass, 5 of 5, and the branch is pushed to [#42](${pr(42)}).` }]);
      row({ type: "system", subtype: "turn_duration", durationMs: 75_000, isMeta: false });
    }
  }
  await writeFile(file, body);
}

/** Keep the working pane's journal growing, like an agent streaming tool calls. Returns a stop function. */
export function tickJournal(file: string, now: () => number, everyMs = 2000): () => void {
  let n = 0;
  let parent: string | null = null;
  const timer = setInterval(() => {
    const row = journalRow("assistant", `Step ${++n}: still working.`, parent, now());
    parent = row.uuid;
    void appendFile(file, row.line);
  }, everyMs);
  return () => clearInterval(timer);
}

// A Claude log row as the CLI writes it: tool calls in an assistant message, their results in the
// next user row, a finished turn's answer marked end_turn and its duration on a system row.
function claudeRow(type: "user" | "assistant" | "system", parent: string | null, at: number, body: Record<string, unknown>): { uuid: string; line: string } {
  const uuid = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  return { uuid, line: JSON.stringify({ type, uuid, parentUuid: parent, timestamp: new Date(at).toISOString(), ...body }) + "\n" };
}
const say = (content: unknown[], stop: "tool_use" | "end_turn" | null) => ({ message: { role: "assistant", content, stop_reason: stop } });
const toolCall = (id: string, n: number) => n % 3 === 0
  ? { type: "tool_use", id, name: "Bash", input: { command: `rg -n "checkout" src/ | head -${20 + n}`, description: `Search step ${n}` } }
  : n % 3 === 1 ? { type: "tool_use", id, name: "Read", input: { file_path: `src/checkout/step-${n}.ts` } }
  : { type: "tool_use", id, name: "Edit", input: { file_path: `src/checkout/step-${n}.ts`, old_string: "a", new_string: "b" } };
const toolResult = (id: string, n: number) => ({ message: { role: "user", content: [{ type: "tool_result", tool_use_id: id,
  content: Array.from({ length: 3 + (n % 9) }, (_, i) => `src/checkout/step-${n}.ts:${i + 1}: const total${i} = cart.items.length * ${n};`).join("\n") }] } });
const answer = (n: number, shot: boolean) => `## Step ${n}\n\nThe checkout flow now ${n % 2 ? "keeps the cart" : "drops stale coupons"} across reloads.\n\n` +
  (shot ? `Screenshot: shots/step-${n}.png\n\n` : "") +
  `- Updated \`src/checkout/step-${n}.ts\`\n- Added a test for the empty cart\n\n\`\`\`ts\nexport function total${n}(cart: Cart) {\n  return cart.items.reduce((sum, item) => sum + item.price, 0);\n}\n\`\`\`\n\n` +
  "Everything else stays as it was. ".repeat(1 + (n % 4));

/**
 * A long session for scroll checks: `turns` finished turns, each a question, commentary, two tool calls
 * with their results and a Markdown answer. With `shots` (the pane's folder) every fourth answer names a
 * screenshot written there, as agents do. Returns the last row's uuid, the parent of what follows.
 */
export async function writeLongJournal(file: string, turns: number, at: number, shots?: string): Promise<string> {
  const png = shots ? await readFile(resolve(import.meta.dir, "../../web/public/nenu-pwa-512x512.png")) : null;
  if (shots) await mkdir(join(shots, "shots"), { recursive: true });
  let parent: string | null = null;
  let body = "";
  const add = (row: { uuid: string; line: string }) => { body += row.line; parent = row.uuid; };
  for (let n = 0; n < turns; n++) {
    const t = at + n * 60_000;
    add(claudeRow("user", parent, t, { message: { role: "user", content: `Question ${n}: ${"what changes in the checkout flow? ".repeat(1 + (n % 3))}` } }));
    for (const k of [1, 2]) {
      const id = `toolu_${n}_${k}`;
      add(claudeRow("assistant", parent, t + k * 1000, say([{ type: "text", text: `Looking at step ${n}.${k}.` }, toolCall(id, n + k)], "tool_use")));
      add(claudeRow("user", parent, t + k * 1000 + 500, toolResult(id, n + k)));
    }
    const shot = png !== null && n % 4 === 0;
    if (shot) await writeFile(join(shots!, "shots", `step-${n}.png`), png);
    add(claudeRow("assistant", parent, t + 5000, say([{ type: "text", text: answer(n, shot) }], "end_turn")));
    add(claudeRow("system", parent, t + 5001, { subtype: "turn_duration", durationMs: 5000 }));
  }
  await writeFile(file, body);
  return parent!;
}

/**
 * A turn that keeps running after `parent`: a question, then every `everyMs` a call, its result half a
 * step later, and a line of commentary every third step. Returns a stop function.
 */
export function tickWorkingTurn(file: string, parent: string, now: () => number, everyMs = 1500): () => void {
  let n = 0;
  let last = parent;
  const add = (row: { uuid: string; line: string }) => { last = row.uuid; void appendFile(file, row.line); };
  add(claudeRow("user", last, now(), { message: { role: "user", content: "Keep going with the checkout cleanup." } }));
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const step = setInterval(() => {
    const id = `toolu_live_${++n}`;
    const content = n % 3 === 0 ? [{ type: "text", text: `Step ${n}: ${"checking the next file. ".repeat(1 + (n % 4))}` }, toolCall(id, n)] : [toolCall(id, n)];
    add(claudeRow("assistant", last, now(), say(content, "tool_use")));
    const k = n;
    timers.push(setTimeout(() => add(claudeRow("user", last, now(), toolResult(id, k))), everyMs / 2));
  }, everyMs);
  return () => { clearInterval(step); for (const timer of timers) clearTimeout(timer); };
}

/**
 * What fake-org.ts starts from: Organizations' `overview --json` projects, plus the profile names.
 * A project's `coordinator` binds its coordinator to a demo pane, as `.state/coordinator.json` does.
 */
export interface OrgSeed {
  profiles: string[];
  /** `false` is an Organizations without `node move` (fake-org.ts). */
  moves?: boolean;
  /** `false` is an Organizations without `asks answer` (fake-org.ts). */
  answers?: boolean;
  /** `asks --json`'s rows, as Organizations prints them; without it the fake has no `asks` (fake-org.ts). */
  asks?: Array<Record<string, unknown>>;
  /** `asks --json`'s decision rows, from the Organizations that answers them (fake-org.ts). */
  decisions?: Array<Record<string, unknown>>;
  /** The operator's own profiles beside the built-ins (fake-org.ts). */
  savedProfiles?: Array<{ name: string; harness: string; model: string; reasoning_effort: string; description: string }>;
  projects: Array<{
    /** What fake-org.ts's `open` does: fail with `open_error`, or record `open_pane` as the coordinator's pane. */
    open_error?: string;
    open_pane?: { pane_id: string; workspace_id: string; tab_id: string };
    /** The pane fake-org.ts's next `node start` in this project runs in, as Organizations' new tab would. */
    start_pane?: { pane_id: string; workspace_id: string; tab_id: string };
    slug: string; name: string; goal: string; status: "active" | "paused";
    /** The glyph and colour picked with `set <slug> icon|tone`, empty when none was picked. */
    icon?: string; tone?: string;
    /** Also what `overview --json` prints of it: the agent, model and state the ticker last saw. */
    coordinator?: { pane_id: string; workspace_id: string; tab_id: string; agent?: string; model?: string; state?: string };
    /** The project coordinator's STATUS.md and token use, as Organizations prints them. */
    status_file?: ({ path: string; text: string; updated: string } & Record<string, unknown>) | null;
    usage?: Record<string, unknown> | null;
    threads: Array<Record<string, unknown> & { id: string }>;
    /** `routine list --json`'s routines, as Organizations prints them. */
    routines?: Array<Record<string, unknown>>;
  }>;
}

/**
 * One project whose coordinator is not running: a nested coordinator with three workers (one
 * bound to the blocked demo pane, one to the working one, one with an approved PR), a worker of
 * its own, and a resolved coordinator with its team. `at` is the bench clock's now.
 */
export function demoOrg(herd: Pick<DemoHerd, "working" | "idle" | "blocked">, at: number): OrgSeed {
  const ago = (minutes: number) => new Date(at - minutes * 60_000).toISOString();
  const bound = (paneId: string, tabId: string) => ({ workspace_id: paneId.split(":")[0], tab_id: tabId, pane_id: paneId });
  const thread = (id: string, title: string, parent: string, role: "worker" | "coordinator", status: string, group: string, minutes: number, extra: Record<string, unknown> = {}) => ({
    id, title, parent_id: parent, role, status, group, group_label: group, note: "", branch: "", workspace_id: "", tab_id: "", pane_id: "", cwd: "",
    updated: ago(minutes), report_unacked: false, auto_fix_ci: false, auto_merge: false, pr: null, ...extra,
  });
  return {
    profiles: ["claude", "codex"],
    projects: [{
      slug: "acme",
      name: "Acme Shop",
      goal: "Coordinar iniciativas de Acme que requieran varios threads o PRs",
      status: "active",
      threads: [
        thread("t-0001", "Cierre Wholesale", "root", "coordinator", "resolved", "resolved", 3000),
        thread("t-0002", "Extraer requisitos", "t-0001", "worker", "resolved", "resolved", 3100),
        thread("t-0003", "Auditar código y PRs", "t-0001", "worker", "resolved", "resolved", 3050),
        thread("t-0004", "Revisar grupos", "root", "worker", "resolved", "resolved", 2800),
        thread("t-0010", "Rediseño mobile", "root", "coordinator", "open", "working", 1, bound(herd.idle, "w1:t2")),
        thread("t-0011", "Panel depósito", "t-0010", "worker", "open", "waiting-on-you", 4, bound(herd.blocked, "w2:t1")),
        thread("t-0012", "Landing a 390 px", "t-0010", "worker", "open", "working", 0, bound(herd.working, "w1:t1")),
        thread("t-0013", "Panel mercadería", "t-0010", "worker", "open", "ready-for-review", 12, {
          pr: {
            url: "https://github.com/acme/shop/pull/1342", state: "OPEN", review: "APPROVED", checks: { passed: 6, pending: 0, failed: 0 },
            additions: 182, deletions: 40, failing: [], comment_count: 1, draft: false, mergeable: "MERGEABLE", merge_blocker: null,
          },
        }),
        thread("t-0014", "Hotfix login", "root", "worker", "open", "idle", 35),
      ],
    }],
  };
}

/**
 * A project shaped like a long-running real one (measured 2026-10-10: 8 resolved coordinators, 20
 * threads nested under five of them, 63 resolved top-level threads), with open work at three depths
 * in every state: a coordinator waiting on you, an idle one running a working thread, a thread ready
 * for review and a nested coordinator with a thread of its own; a thread waiting on you and an idle
 * one at the top; and a resolved thread under the open coordinator. With `coordinator` the
 * project's own coordinator runs in the demo Codex pane.
 */
export function orgTreeSeed(herd: Pick<DemoHerd, "working" | "idle" | "blocked" | "codex">, at: number, { coordinator = false } = {}): OrgSeed {
  const ago = (minutes: number) => new Date(at - minutes * 60_000).toISOString();
  const bound = (paneId: string, tabId: string) => ({ workspace_id: paneId.split(":")[0]!, tab_id: tabId, pane_id: paneId });
  const node = (id: number, title: string, parent: string, role: "worker" | "coordinator", group: string, minutes: number, extra: Record<string, unknown> = {}) => ({
    id: `t-${String(id).padStart(4, "0")}`, title, parent_id: parent, role, status: group === "resolved" ? "resolved" : "open", group,
    group_label: group, note: "", branch: "", workspace_id: "", tab_id: "", pane_id: "", cwd: "", updated: ago(minutes),
    report_unacked: false, auto_fix_ci: false, auto_merge: false, pr: null, ...extra,
  });
  const threads: Array<Record<string, unknown> & { id: string }> = [];
  let id = 0;
  // Resolved coordinators, oldest first, each with the threads it ran.
  const teams: Array<[string, number]> = [
    ["Cierre Wholesale", 2], ["Publicación Wholesale", 2], ["Revisar PRs a develop", 4], ["Mergear PRs restantes", 10],
    ["Preparar release", 2], ["Investigar WhatsApp", 0], ["Stock y vínculos", 0], ["Prueba de plantilla", 0],
  ];
  for (const [index, [title, size]] of teams.entries()) {
    const coordinatorId = `t-${String(++id).padStart(4, "0")}`;
    const minutes = 30_000 - index * 3000;
    threads.push(node(id, title, "root", "coordinator", "resolved", minutes));
    for (let n = 1; n <= size; n++) threads.push(node(++id, `${title}: paso ${n}`, coordinatorId, "worker", "resolved", minutes + n * 10));
  }
  for (let n = 1; n <= 63; n++) threads.push(node(++id, `Tarea cerrada ${n}`, "root", "worker", "resolved", 29_000 - n * 300));
  threads.push(
    node(101, "Migración de stock", "root", "coordinator", "waiting-on-you", 20),
    node(102, "Rediseño mobile", "root", "coordinator", "idle", 2, bound(herd.idle, "w1:t2")),
    node(103, "Landing a 390 px", "t-0102", "worker", "working", 0, bound(herd.working, "w1:t1")),
    node(104, "Panel mercadería", "t-0102", "worker", "ready-for-review", 12, {
      pr: {
        url: "https://github.com/acme/shop/pull/1342", state: "OPEN", review: "APPROVED", checks: { passed: 6, pending: 0, failed: 0 },
        additions: 182, deletions: 40, failing: [], comment_count: 1, draft: false, mergeable: "MERGEABLE", merge_blocker: null,
      },
    }),
    node(105, "Checkout", "t-0102", "coordinator", "working", 6),
    node(106, "Ajustar pagos", "t-0105", "worker", "idle", 9),
    node(107, "Auditar estilos", "t-0102", "worker", "resolved", 40),
    node(108, "Hotfix login", "root", "worker", "idle", 35),
    node(109, "Panel depósito", "root", "worker", "waiting-on-you", 4, bound(herd.blocked, "w2:t1")),
  );
  return {
    profiles: ["claude", "codex"],
    projects: [{
      slug: "acme",
      name: "Acme Shop",
      goal: "Coordinar iniciativas de Acme que requieran varios threads o PRs",
      status: "active",
      ...(coordinator ? { coordinator: bound(herd.codex, "w2:t1") } : {}),
      threads,
    }],
  };
}

/**
 * A project coordinator's chat as an operator's phone showed it on 2026-10-14: a working Claude
 * coordinator over five open top-level threads (three ready for review with a pull request, one of
 * them mergeable; one working on its own PR; one waiting on you in the blocked demo pane) and a
 * resolved thread whose PR merged. `at` is the bench clock's now.
 */
export function projectChatSeed(herd: Pick<DemoHerd, "working" | "blocked">, at: number): OrgSeed {
  const ago = (minutes: number) => new Date(at - minutes * 60_000).toISOString();
  const bound = (paneId: string, tabId: string) => ({ workspace_id: paneId.split(":")[0]!, tab_id: tabId, pane_id: paneId });
  const pr = (number: number, extra: Record<string, unknown> = {}) => ({
    url: `https://github.com/acme/shop/pull/${number}`, state: "OPEN", review: "REVIEW_REQUIRED", checks: { passed: 6, pending: 0, failed: 0 },
    additions: 120, deletions: 30, failing: [], comment_count: 0, draft: false, mergeable: "MERGEABLE", merge_blocker: "review required", ...extra,
  });
  const node = (id: number, title: string, group: string, minutes: number, extra: Record<string, unknown> = {}) => ({
    id: `t-${String(id).padStart(4, "0")}`, title, parent_id: "root", role: "worker", status: group === "resolved" ? "resolved" : "open", group,
    group_label: group, note: "", branch: "", workspace_id: "", tab_id: "", pane_id: "", cwd: "", updated: ago(minutes),
    report_unacked: false, auto_fix_ci: false, auto_merge: false, pr: null, ...extra,
  });
  return {
    profiles: ["claude", "codex"],
    projects: [{
      slug: "acme",
      name: "Acme Shop",
      goal: "Coordinar iniciativas de Acme que requieran varios threads o PRs",
      status: "active",
      coordinator: bound(herd.working, "w1:t1"),
      threads: [
        node(1, "Hotfix login", "resolved", 600, { pr: pr(1700, { state: "MERGED" }) }),
        node(2, "Pedidos de la tienda", "ready-for-review", 8, { branch: "acme-t-0002", pr: pr(1352, { review: "APPROVED", merge_blocker: null }) }),
        node(3, "Pedidos mayoristas", "working", 2, { branch: "acme-t-0003", pr: pr(1351, { checks: { passed: 3, pending: 3, failed: 0 }, merge_blocker: "checks pending" }) }),
        node(4, "Release de pedidos", "ready-for-review", 30, { branch: "acme-t-0004", pr: pr(1345) }),
        node(5, "Bugs del asistente", "ready-for-review", 5, { branch: "acme-t-0005", pr: pr(1350) }),
        node(6, "Panel depósito", "waiting-on-you", 4, bound(herd.blocked, "w2:t1")),
      ],
    }],
  };
}

/**
 * A coordinator over two threads that need you for different reasons: one stopped on a real dialog
 * (the blocked demo pane), one idle after saying it waits for your reply (the idle demo pane, its
 * own `Waiting for you` report), and a third still working. `at` is the bench clock's now.
 */
export function needsYouSeed(herd: Pick<DemoHerd, "working" | "idle" | "blocked">, at: number): OrgSeed {
  const ago = (minutes: number) => new Date(at - minutes * 60_000).toISOString();
  const bound = (paneId: string, tabId: string) => ({ workspace_id: paneId.split(":")[0]!, tab_id: tabId, pane_id: paneId });
  const node = (id: number, title: string, group: string, minutes: number, extra: Record<string, unknown> = {}) => ({
    id: `t-${String(id).padStart(4, "0")}`, title, parent_id: "root", role: "worker", status: "open", group, group_label: group, note: "",
    branch: "", workspace_id: "", tab_id: "", pane_id: "", cwd: "", updated: ago(minutes), report_unacked: false, auto_fix_ci: false,
    auto_merge: false, pr: null, activity: "", percent: null, ...extra,
  });
  return {
    profiles: ["claude"],
    projects: [{
      slug: "demo",
      name: "Demo shop",
      goal: "Ship the checkout redesign",
      status: "active",
      coordinator: bound(herd.working, "w1:t1"),
      threads: [
        node(1, "Checkout copy", "waiting-on-you", 3, { ...bound(herd.idle, "w1:t2"), note: "idle", activity: "Waiting for you", percent: 85 }),
        node(2, "Payments panel", "waiting-on-you", 6, { ...bound(herd.blocked, "w2:t1"), note: "blocked" }),
        node(3, "Order export", "working", 1, { activity: "Writing the CSV", percent: 40 }),
      ],
    }],
  };
}

/** git in the bench's folder, with none of the caller's GIT_* and no signing or identity of the operator's. */
function git(dir: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = Bun.spawnSync(["git", "-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: dir, env });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

/** `count` lines of plausible TypeScript about `topic`; `edit` rewrites line `i`. */
function code(topic: string, count: number, edit: (line: string, i: number) => string = (line) => line): string {
  return Array.from({ length: count }, (_, i) =>
    edit(i % 6 === 0 ? `export function ${topic}Step${i}(input: ${topic[0]!.toUpperCase()}${topic.slice(1)}Input) {` : i % 6 === 5 ? "}" : `  const value${i} = input.items.filter((item) => item.${topic} > ${i}).length; // ${topic} ${i}`, i),
  ).join("\n") + "\n";
}

/**
 * The demo panes' folder as a pull request's worktree: `main` (also `origin/main`) and the checked-out
 * `e2e-demo`, one commit changing six files (an edit, a new file, a removal, a rename, a binary) and
 * an uncommitted edit. Returns what GitHub would count for the PR: the committed lines.
 */
export function seedDiffRepo(dir: string): { additions: number; deletions: number } {
  const files: Record<string, string | Uint8Array> = {
    "app/cart.ts": code("cart", 40),
    "app/checkout.tsx": code("checkout", 60),
    "app/styles.css": Array.from({ length: 20 }, (_, i) => `.row-${i} { padding: ${i}px; }`).join("\n") + "\n",
    "app/legacy.ts": code("legacy", 12),
    "README.md": "# Acme Shop\n\nThe shop's storefront and admin.\n",
    "app/logo.png": new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 1, 2, 3]),
  };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  git(dir, "add", "--", ...Object.keys(files));
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(dir, "branch", "main");

  writeFileSync(join(dir, "app/cart.ts"), code("cart", 44, (line, i) => i === 3 ? `${line.replace("> 3", ">= 3")}` : i === 20 ? "  const discount = applyCoupon(input.coupon, input.total);" : line));
  writeFileSync(join(dir, "app/checkout.tsx"), code("checkout", 66, (line, i) => i === 8 || i === 40 ? line.replace("filter", "findAll") : line));
  writeFileSync(join(dir, "app/payment.ts"), code("payment", 30));
  writeFileSync(join(dir, "app/logo.png"), new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 9, 9, 9, 9]));
  git(dir, "rm", "-q", "app/legacy.ts");
  mkdirSync(join(dir, "docs"), { recursive: true });
  git(dir, "mv", "README.md", "docs/README.md");
  git(dir, "add", "--", "app");
  git(dir, "commit", "-q", "-m", "feat: checkout with coupons");
  const [additions, deletions] = git(dir, "diff", "--shortstat", "origin/main", "HEAD").match(/\d+(?= insertion| deletion)/g)!.map(Number);
  // Not committed yet: what the agent is still typing.
  writeFileSync(join(dir, "app/styles.css"), Array.from({ length: 20 }, (_, i) => `.row-${i} { padding: ${i === 4 ? 6 : i}px; }`).join("\n") + "\n.coupon { color: var(--status-done); }\n");
  return { additions: additions!, deletions: deletions! };
}

/** A commit past every limit of the diff viewer: 320 new files and one generated file of 4,000 lines. */
export function growDiffRepo(dir: string): void {
  mkdirSync(join(dir, "app/generated"), { recursive: true });
  writeFileSync(join(dir, "app/generated/catalog.ts"), code("catalog", 4000));
  for (let n = 0; n < 320; n++) writeFileSync(join(dir, `app/generated/item-${String(n).padStart(3, "0")}.ts`), code(`item${n}`, 60));
  git(dir, "add", "--", "app/generated");
  git(dir, "commit", "-q", "-m", "feat: generated catalog");
}

/** `demoOrg`, with its PR #1342 on the working pane's thread, on `e2e-demo`, sized as `size` says. */
export function diffOrg(herd: Pick<DemoHerd, "working" | "idle" | "blocked">, at: number, size: { additions: number; deletions: number }): OrgSeed {
  const seed = demoOrg(herd, at);
  const project = seed.projects[0]!;
  const pr = { ...(project.threads.find((thread) => thread.id === "t-0013")!.pr as Record<string, unknown>), ...size };
  project.threads = project.threads.map((thread) =>
    thread.id === "t-0012" ? { ...thread, branch: "e2e-demo", pr }
    : thread.id === "t-0013" ? { ...thread, pr: { ...pr, url: "https://github.com/acme/shop/pull/1338", additions: 64, deletions: 12 } }
    : thread);
  return seed;
}

/**
 * A neutral store project for Home's list: a coordinator thread on the idle pane running a worker on
 * the working pane (PR on `e2e-demo`, sized as `size` says), a worker on the blocked pane, a worker
 * ready for review with no pane, and an idle worker of the project's own.
 */
export function homeOrg(herd: Pick<DemoHerd, "working" | "idle" | "blocked">, at: number, size: { additions: number; deletions: number }): OrgSeed {
  const ago = (minutes: number) => new Date(at - minutes * 60_000).toISOString();
  const bound = (paneId: string, tabId: string) => ({ workspace_id: paneId.split(":")[0]!, tab_id: tabId, pane_id: paneId });
  const pr = (number: number, extra: Record<string, unknown> = {}) => ({
    url: `https://github.com/acme/shop/pull/${number}`, state: "OPEN", review: "REVIEW_REQUIRED", checks: { passed: 6, pending: 0, failed: 0 },
    additions: 64, deletions: 12, failing: [], comment_count: 0, draft: false, mergeable: "MERGEABLE", merge_blocker: null, ...extra,
  });
  const node = (id: string, title: string, parent: string, role: "worker" | "coordinator", group: string, minutes: number, extra: Record<string, unknown> = {}) => ({
    id, title, parent_id: parent, role, status: group === "resolved" ? "resolved" : "open", group, group_label: group, note: "", branch: "",
    workspace_id: "", tab_id: "", pane_id: "", cwd: "", updated: ago(minutes), report_unacked: false, auto_fix_ci: false, auto_merge: false, pr: null, ...extra,
  });
  return {
    profiles: ["claude", "codex"],
    projects: [{
      slug: "acme-shop", name: "Acme Shop", goal: "Storefront, checkout and the admin panel", status: "active",
      threads: [
        node("t-0001", "Search index", "root", "worker", "resolved", 3000),
        node("t-0010", "Checkout redesign", "root", "coordinator", "working", 1, bound(herd.idle, "w1:t2")),
        node("t-0011", "Payments webhook", "t-0010", "worker", "waiting-on-you", 4, bound(herd.blocked, "w2:t1")),
        node("t-0012", "Checkout flow", "t-0010", "worker", "working", 0, { ...bound(herd.working, "w1:t1"), branch: "e2e-demo", pr: pr(42, size) }),
        node("t-0013", "Cart badge", "t-0010", "worker", "ready-for-review", 12, { pr: pr(41, { review: "APPROVED" }) }),
        node("t-0014", "Login hotfix", "root", "worker", "idle", 35),
      ],
    }],
  };
}

/**
 * homeOrg's Acme Shop beside four neighbour projects, each with an open thread that last moved at a
 * different age (the sidebar's periods) and a resolved one, and Acme Shop with a scheduled and a pull
 * request routine. Every project then draws its own mark, its own age and its own date group.
 */
export function deskOrg(herd: Pick<DemoHerd, "working" | "idle" | "blocked">, at: number, size: { additions: number; deletions: number }): OrgSeed {
  const seed = homeOrg(herd, at, size);
  const ago = (minutes: number) => new Date(at - minutes * 60_000).toISOString();
  const node = (id: string, title: string, group: string, minutes: number) => ({
    id, title, parent_id: "root", role: "worker", status: group === "resolved" ? "resolved" : "open", group, group_label: group, note: "", branch: "",
    workspace_id: "", tab_id: "", pane_id: "", cwd: "", updated: ago(minutes), report_unacked: false, auto_fix_ci: false, auto_merge: false, pr: null,
  });
  const HOUR = 60;
  const DAY = 24 * HOUR;
  const neighbour = (slug: string, name: string, goal: string, threads: ReturnType<typeof node>[]) => ({ slug, name, goal, status: "active" as const, threads });
  seed.projects[0]!.routines = [
    { name: "nightly-dependency-check", trigger: "schedule", schedule: "daily 03:00", events: [], enabled: true, command: "", command_status: "none",
      prompt: "", last_run: ago(20 * HOUR), next_run: new Date(at + 4 * 3_600_000).toISOString(), skipped_unhandled: 0, skipped_no_coordinator: 0 },
    { name: "pr-follow-up", trigger: "pr", schedule: "", events: ["checks-failed", "review"], enabled: true, command: "", command_status: "none",
      prompt: "", last_run: "", next_run: "", skipped_unhandled: 0, skipped_no_coordinator: 0 },
  ];
  seed.projects.push(
    neighbour("docs-site", "Docs site", "Guides and the API reference", [node("t-0101", "API reference pages", "ready-for-review", 2 * HOUR), node("t-0102", "Old guides", "resolved", 9 * DAY)]),
    neighbour("mobile-app", "Mobile app", "The iOS and Android clients", [node("t-0201", "Push permission prompt", "idle", DAY + 3 * HOUR)]),
    neighbour("billing-api", "Billing API", "Invoices, plans and webhooks", [node("t-0301", "Invoice export", "idle", 12 * DAY)]),
    neighbour("data-pipeline", "Data pipeline", "Nightly exports and the warehouse", [node("t-0401", "Warehouse backfill", "idle", 45 * DAY)]),
  );
  return seed;
}
