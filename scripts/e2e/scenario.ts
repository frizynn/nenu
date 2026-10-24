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

/**
 * The operator's command demo (T3 Code captures, 2026-10-21) as a Claude log: a thought, words, three
 * commands in parallel, a thought, words, one that fails and one with a long output, then the answer;
 * before it, a turn that reads, edits and runs one command. `stage` "running" stops after the failing
 * command starts; "finished" writes the rest. Rows of one API message share its id, as the CLI's do.
 */
export async function writeCommandsJournal(file: string, at: number, stage: "running" | "finished"): Promise<void> {
  let body = "";
  let parent: string | null = null;
  // The demo turn starts 8 s before `at`, so a capture taken then reads "Working for" about as long as
  // the finished turn's measured duration (some 9 s) says.
  let clock = at - 90_000;
  let n = 0;
  const row = (fields: Record<string, unknown>) => {
    const uuid = `${basename(file).slice(0, 8)}-0000-4000-9000-${String(++n).padStart(12, "0")}`;
    body += JSON.stringify({ uuid, parentUuid: parent, timestamp: new Date(clock).toISOString(), isSidechain: false, ...fields }) + "\n";
    parent = uuid;
  };
  const user = (content: unknown) => row({ type: "user", message: { role: "user", content } });
  let message = 0;
  const assistant = (stop: "tool_use" | "end_turn" | null, blocks: unknown[], id = `msg_${++message}`) => {
    for (const block of blocks) row({ type: "assistant", message: { id, role: "assistant", stop_reason: stop, content: [block] } });
  };
  const bash = (id: string, command: string) => ({ type: "tool_use", id, name: "Bash", input: { command } });
  const result = (id: string, content: string, isError = false) => user([{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }]);
  const done = (ms: number) => row({ type: "system", subtype: "turn_duration", durationMs: ms, isMeta: false });

  // A turn that reads, edits and runs one command.
  user("Arreglá el typo del README y corré los tests.");
  let start = clock;
  clock += 2000;
  assistant("tool_use", [{ type: "tool_use", id: "toolu_r1", name: "Read", input: { file_path: "README.md" } }]);
  result("toolu_r1", "# Nenu\n\nA phone web UI for your Herdr agnet herd.");
  clock += 1500;
  assistant("tool_use", [{ type: "tool_use", id: "toolu_e1", name: "Edit", input: { file_path: "README.md", old_string: "agnet", new_string: "agent" } }]);
  result("toolu_e1", "The file README.md has been updated.");
  clock += 1500;
  assistant("tool_use", [bash("toolu_t1", "bun test bridge/journal")]);
  clock += 3000;
  result("toolu_t1", " 212 pass\n 0 fail\nRan 212 tests across 14 files. [1.84s]");
  clock += 1000;
  assistant("end_turn", [{ type: "text", text: "Listo: el README dice *agent* y los 212 tests pasan." }]);
  done(clock - start);
  clock = at - 8_000;

  // The operator's demo.
  user("hola usa comandos quiero ver como se ven en esta interfaz");
  start = clock;
  clock += 1500;
  assistant("tool_use", [
    { type: "thinking", thinking: "The user just wants to see how commands render here, so I'll run a few harmless ones in parallel to demonstrate the different shapes." },
    { type: "text", text: "Dale, corro algunos comandos inofensivos para que veas cómo se muestran." },
    bash("toolu_c1", "pwd && ls -la"),
    bash("toolu_c2", "date && uname -a && sw_vers"),
    bash("toolu_c3", "echo \"Hola desde la terminal 👋\" && for i in 1 2 3; do echo \"línea $i\"; done"),
  ]);
  clock += 1200;
  result("toolu_c1", ["/Users/fran/Developer/nenu", "total 96", "drwxr-xr-x  18 fran  staff    576 Oct 21 17:05 .", "drwxr-xr-x  12 fran  staff    384 Oct 20 09:12 ..",
    "-rw-r--r--   1 fran  staff   2193 Oct 21 16:58 README.md", "drwxr-xr-x  24 fran  staff    768 Oct 21 16:40 bridge", "drwxr-xr-x  11 fran  staff    352 Oct 21 16:40 web"].join("\n"));
  result("toolu_c2", ["Wed Oct 21 17:05:45 CEST 2026", "Darwin Macbook-M5.local 25.6.0 Darwin Kernel Version 25.6.0: Sat Jul 11 15:26:12 PDT 2026; root:xnu-12377.161.13~4/RELEASE_ARM64_T8142 arm64",
    "ProductName:\t\tmacOS", "ProductVersion:\t\t26.6", "BuildVersion:\t\t25G72"].join("\n"));
  result("toolu_c3", "Hola desde la terminal 👋\nlínea 1\nlínea 2\nlínea 3");
  clock += 1500;
  assistant("tool_use", [
    { type: "thinking", thinking: "I should also show a failing command with longer output to demonstrate how errors get rendered, keeping it harmless." },
    { type: "text", text: "Sumo uno que falla, así ves también cómo se muestra un error." },
    bash("toolu_c4", "ls /carpeta-que-no-existe"),
  ]);
  if (stage === "finished") {
    clock += 800;
    result("toolu_c4", "Exit code 1\nls: /carpeta-que-no-existe: No such file or directory", true);
    clock += 1200;
    assistant("tool_use", [bash("toolu_c5", "git log --oneline -40")]);
    clock += 900;
    result("toolu_c5", Array.from({ length: 40 }, (_, i) => `${(0x81c6c149 - i * 7919).toString(16).slice(0, 8)} ${["feat(chat): ", "fix(composer): ", "docs: ", "test(e2e): "][i % 4]}change number ${40 - i} in the transcript`).join("\n"));
    clock += 2000;
    assistant("end_turn", [{ type: "text", text: "Listo, corrí 5 comandos. Ninguno cambia nada en tu máquina. Tendrías que verlos arriba, cada uno en su bloque." }]);
    done(clock - start);
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
