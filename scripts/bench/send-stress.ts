import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { claudeTurn, decodeClaudeSession } from "../../bridge/agent-state-sources.ts";
import { claudeLogReader } from "../../bridge/delivery-check.ts";
import { guardedSend, OutputTrigger } from "../../bridge/guarded-send.ts";
import { HerdrClient } from "../../bridge/herdr-client.ts";
import { deliverQueuedMessage } from "../../bridge/queue-delivery.ts";
import type { QueuedMessage } from "../../bridge/message-queue.ts";
import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { splitLines } from "../../web/src/lib/blocks.ts";
import { adapterFor } from "../../web/src/lib/harness/index.ts";

// The send under stress, against a REAL Claude Code in a Herdr pane of your own (never one with work
// in it: the bench types, presses Enter, Escape and Backspace there, and starts turns). It runs the
// bridge's own send path (guardedSend with the reply route's deps, or the queue's delivery) and judges
// every send by Claude's log, not by what the send said:
//
//   ok        logged once, whole, each picture attached, the box empty afterwards
//   refused   (dialog only) nothing typed and the dialog still up: the right answer
//   stuck     part of the message still in the box after the send returned and the turn settled
//   dup       logged twice or more
//   lost      the send said "sent" and Claude never logged it
//   false     the send said it failed and Claude logged it (a resend would duplicate it)
//   failed    the send said it failed, nothing logged, box clean (safe to resend, still a failure)
//   path      logged once but a picture went as its path, not attached
//   partial   logged with fewer characters than sent
//
//   bun scripts/bench/send-stress.ts <pane> [--rounds 3] [--only idle-short,busy-img1] [--out file.json]
//
// Start the pane's Claude in an empty folder with its own settings only and Bash(sleep) allowed, e.g.
//   claude --model haiku --setting-sources local --permission-mode default --allowedTools 'Bash(sleep:*)' 'Read'
// and, to simulate a loaded host, the same under `systemd-run --user --scope -p CPUQuota=15%`.

const args = process.argv.slice(2);
const pane = args[0] ?? "";
if (!pane || pane.startsWith("--")) throw new Error("usage: send-stress.ts <pane> [--rounds N] [--only a,b] [--out file]");
const flag = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const rounds = Number(flag("rounds") ?? 3);
const only = flag("only")?.split(",");
const out = flag("out");
const herdr = new HerdrClient(process.env.HERDR_SOCKET_PATH ?? join(homedir(), ".config/herdr/herdr.sock"));
const claude = adapterFor("claude")!;
const READ_LINES = 200;
// Named as Nenu names an uploaded picture, which is what travels in place (ADR 0104, isPicturePath).
const IMAGES = join(import.meta.dir, "send-stress-images", "uploads");

// ── The pane's Claude, its session file and its log ──────────────────────────────────────────────

async function claudeProcess(): Promise<{ pid: number; cwd: string }> {
  const info = (await herdr.processInfo(pane)) as { foreground_processes?: { pid: number; name: string; cwd: string }[] };
  const proc = info.foreground_processes?.find((p) => p.name === "claude");
  if (!proc) throw new Error(`no claude in the foreground of ${pane}`);
  return proc;
}

type SessionFile = { sessionId: string; status: string; waitingFor?: string };
function sessionFile(pid: number): SessionFile | null {
  try {
    return JSON.parse(readFileSync(join(homedir(), ".claude/sessions", `${pid}.json`), "utf8")) as SessionFile;
  } catch {
    return null;
  }
}

/** The pane's turn by the bridge's own rule over Claude's session file (ADR 0067); no transcript scan. */
function turnOf(pid: number) {
  let text: string;
  try {
    text = readFileSync(join(homedir(), ".claude/sessions", `${pid}.json`), "utf8");
  } catch {
    return undefined;
  }
  const file = decodeClaudeSession(text, pid);
  return file ? claudeTurn(file, null) : undefined;
}

function transcriptPath(cwd: string, sessionId: string): string | null {
  const dir = join(homedir(), ".claude/projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  const path = join(dir, `${sessionId}.jsonl`);
  return existsSync(path) ? path : null;
}

type Row = Record<string, unknown>;
function rows(path: string | null): Row[] {
  if (!path) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        return line ? [JSON.parse(line) as Row] : [];
      } catch {
        return [];
      }
    });
}

/** Every time Claude took the message in: a typed user row, or an enqueue while it worked. */
function deliveries(all: Row[], nonce: string): { text: string; images: number; queued?: true }[] {
  const found: { text: string; images: number; queued?: true }[] = [];
  for (const row of all) {
    if (row.type === "queue-operation" && row.operation === "enqueue" && String(row.content ?? "").includes(nonce)) {
      found.push({ text: String(row.content), images: (String(row.content).match(/\[Image #\d+\]/g) ?? []).length, queued: true });
      continue;
    }
    if (row.type !== "user") continue;
    const content = (row.message as { content?: unknown } | undefined)?.content;
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? (content as Row[]) : [];
    if (blocks.some((b) => b.type === "tool_result")) continue;
    const text = blocks.filter((b) => b.type === "text").map((b) => String(b.text)).join("");
    if (!text.includes(nonce)) continue;
    // Claude writes `[Image #N]` in the text only for a picture it attached; the image itself may sit
    // in another block or row.
    found.push({ text, images: Math.max(blocks.filter((b) => b.type === "image").length, (text.match(/\[Image #\d+\]/g) ?? []).length) });
  }
  return found;
}

async function box(): Promise<{ draft: string | null; composer: boolean }> {
  const lines = splitLines(parseAnsi((await herdr.readPane(pane, "recent", READ_LINES, "ansi")).text));
  return { draft: claude.extractInputDraft(lines), composer: claude.composerReady?.(lines) === true };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean> | boolean, ms: number, step = 100): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(step);
  }
  return false;
}

// ── Messages ───────────────────────────────────────────────────────────────────────────────────

const picture = (i: number) => join(IMAGES, `bench-${["red", "green", "blue"][i % 3]}-0000aaaa.png`);
function message(kind: string, nonce: string): string {
  if (kind === "short") return `${nonce} reply with the single word ok`;
  // Just under Claude's paste threshold (800), on one line: typed, not pasted.
  if (kind === "mid") return `${nonce} reply with the single word ok. ${"padding words to stay on one line ".repeat(20)}`.slice(0, 760);
  // Short, over several lines: typed, each newline a key of its own.
  if (kind === "lines") return `${nonce} reply with the single word ok.\nsecond line\nthird line`;
  if (kind === "long") {
    const body = Array.from({ length: 14 }, (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog, ${"and again ".repeat(3)}`).join("\n");
    return `${nonce} long message, reply with the single word ok.\n${body}`;
  }
  const count = kind === "img3" ? 3 : 1;
  const parts = Array.from({ length: count }, (_, i) => `picture ${i + 1} ${picture(i)}`);
  return `${nonce} name the colour of each picture in one word each: ${parts.join(" then ")} end`;
}

// ── Setups ─────────────────────────────────────────────────────────────────────────────────────

async function typeRaw(text: string, enter = false) {
  await herdr.sendPaneText(pane, `\x1b[200~${text}\x1b[201~${enter ? "\r" : ""}`);
}

async function settleIdle(pid: number) {
  await until(() => sessionFile(pid)?.status === "idle", 90_000, 200);
  // Nothing of an earlier trial may stay in the box.
  for (let i = 0; i < 3; i++) {
    const b = await box();
    if (b.composer && b.draft === null) return;
    if (!b.composer) await herdr.sendPaneKeys(pane, ["Escape"]);
    else await herdr.sendPaneKeys(pane, ["ctrl+k", ...Array<string>([...(b.draft ?? "")].length + 32).fill("Backspace")]);
    // A loaded Claude takes a while to close a menu or clear the box: wait for it, never press twice.
    await until(async () => { const now = await box(); return now.composer && now.draft === null; }, 10_000, 200);
  }
}

async function startTurn(pid: number, seconds: number) {
  await typeRaw(`Use the Bash tool to run exactly: sleep ${seconds}. Then reply with the single word slept.`, true);
  await until(() => sessionFile(pid)?.status === "busy", 15_000, 50);
  // Let the tool call start, so the send lands mid-turn rather than on the prompt's echo.
  await sleep(1500);
}

async function openDialog(pid: number, nonce: string) {
  // A fresh conversation: one that saw its earlier dialogs refused stops asking for the tool.
  const before = sessionFile(pid)?.sessionId;
  await typeRaw("/clear", true);
  await until(() => sessionFile(pid)?.sessionId !== before, 15_000, 100);
  await sleep(1000);
  // Not the nonce itself: the dialog's prompt must not count as a delivery of the message.
  await typeRaw(`Use the Bash tool to run exactly: touch dialog-${nonce.split("").reverse().join("")}.txt`, true);
  await until(() => sessionFile(pid)?.status === "waiting", 30_000, 100);
  await until(async () => !(await box()).composer, 5_000, 50);
}

// ── One trial ──────────────────────────────────────────────────────────────────────────────────

type Verdict = "ok" | "refused" | "stuck" | "dup" | "lost" | "false" | "failed" | "path" | "partial" | "setup";
interface Trial {
  variant: string;
  round: number;
  verdict: Verdict;
  ms: number;
  said: string;
  logged: number;
  left: string | null;
  load: number;
}

const VARIANTS = [
  "idle-short", "idle-mid", "idle-lines", "idle-long", "idle-img1", "idle-img3",
  "busy-short", "busy-mid", "busy-long", "busy-img1", "busy-img3",
  "dialog-short", "draft-short",
  "queue-idle-img1", "queue-busy-img3",
] as const;

async function trial(variant: string, round: number): Promise<Trial> {
  const { pid, cwd } = await claudeProcess();
  await settleIdle(pid);
  const nonce = `Z${Date.now().toString(36).slice(-5)}${round}`;
  const kind = variant.split("-").at(-1)!;
  const text = message(kind, nonce);
  const pictures = kind === "img3" ? 3 : kind === "img1" ? 1 : 0;
  if (variant.includes("busy")) await startTurn(pid, 10);
  if (variant.startsWith("dialog")) {
    await openDialog(pid, nonce);
    // A dialog that never opened (Claude answered without the tool) is no trial of a send into one.
    if ((await box()).composer || sessionFile(pid)?.status !== "waiting") {
      await herdr.sendPaneKeys(pane, ["Escape"]);
      return { variant, round, verdict: "setup", ms: 0, said: "the dialog did not open", logged: 0, left: null, load: 0 };
    }
  }
  if (variant.startsWith("draft")) {
    await herdr.sendPaneText(pane, `hand typed draft ${nonce}`);
    await until(async () => (await box()).draft !== null, 5_000, 50);
  }
  const load = Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]);
  const session = sessionFile(pid);
  const log = () => Promise.resolve(session ? transcriptPath(cwd, session.sessionId) : null);
  const started = Date.now();
  let said: string;
  let ok: boolean;
  let refusedClean = false;
  if (variant.startsWith("queue")) {
    const row = { id: nonce, revision: 1, paneId: pane, agent: "claude", text } as unknown as QueuedMessage;
    const write = async (wire: string, submit: boolean, _id: string, paste: boolean) => {
      if (submit) await herdr.sendPaneKeys(pane, ["Enter"]);
      else await herdr.sendPaneText(pane, paste ? `\x1b[200~${wire}\x1b[201~` : wire);
      return { ok: true as const };
    };
    const outcome = await deliverQueuedMessage(row, herdr, write, async () => true, "enter", { received: claudeLogReader(log), turn: () => turnOf(pid) });
    ok = outcome.status === "sent";
    said = ok ? "sent" : `${outcome.status}: ${outcome.error ?? ""}`;
  } else {
    const { outcome } = await guardedSend(
      { herdr, paneId: pane, readLines: READ_LINES, submitKeys: ["Enter"], trigger: new OutputTrigger(), received: claudeLogReader(log), turn: () => turnOf(pid) },
      { text, requestId: nonce },
    );
    ok = outcome.ok;
    said = outcome.ok ? "sent" : `${outcome.stage}${outcome.code ? `/${outcome.code}` : ""}: ${outcome.error}`;
    refusedClean = !outcome.ok && !outcome.textDelivered;
  }
  const ms = Date.now() - started;
  const path = session ? transcriptPath(cwd, session.sessionId) : null;
  // Claude logs a typed message at once and a mid-turn one as an enqueue; give either time to land.
  // A send that said it failed gets as long: a late row is the duplicate a resend would make.
  await until(() => deliveries(rows(path), nonce).length > 0, 20_000, 100);
  const afterBox = await box();
  // Escape only on a dialog still up: on an empty box a second one opens Claude's rewind.
  if (variant.startsWith("dialog") && !afterBox.composer) await herdr.sendPaneKeys(pane, ["Escape"]);
  const found = deliveries(rows(path ?? (session ? transcriptPath(cwd, session.sessionId) : null)), nonce);
  const left = afterBox.draft !== null && afterBox.draft.replace(/\s+/g, "").includes(nonce) ? afterBox.draft.slice(0, 120) : null;
  const strip = (s: string) => s.replace(/\[Image #\d+\]/g, "").replace(/<\/?pasted_content[^>]*>/g, "").replace(/\s+/g, "");
  const want = strip(pictures ? text.replace(/\/\S+\.png/g, "") : text);
  let verdict: Verdict;
  // Claude logs a message it queued mid-turn as an enqueue, and again as a typed row if it then
  // sends it as a turn of its own: one delivery. Two of either kind is two.
  const typedRows = found.filter((f) => !f.queued).length;
  if (typedRows > 1 || found.length - typedRows > 1) verdict = "dup";
  else if (variant.startsWith("dialog")) verdict = found.length === 0 && !ok && refusedClean && !afterBox.composer && left === null ? "refused" : found.length ? "false" : left ? "stuck" : "failed";
  else if (left !== null && found.length === 0) verdict = "stuck";
  else if (found.length === 0) verdict = ok ? "lost" : "failed";
  else if (!ok) verdict = "false";
  else if (pictures && found[0]!.images < pictures) verdict = "path";
  else if (strip(found[0]!.text.replace(/\/\S+\.png/g, "")).length < want.length * 0.98) verdict = "partial";
  else verdict = "ok";
  return { variant, round, verdict, ms, said: said.slice(0, 160), logged: found.length, left, load };
}

// ── Run ────────────────────────────────────────────────────────────────────────────────────────

const results: Trial[] = [];
const chosen = VARIANTS.filter((v) => !only || only.includes(v));
for (let round = 1; round <= rounds; round++) {
  for (const variant of chosen) {
    let result: Trial;
    try {
      result = await trial(variant, round);
    } catch (err) {
      result = { variant, round, verdict: "failed", ms: 0, said: `bench error: ${String(err)}`, logged: 0, left: null, load: 0 };
    }
    results.push(result);
    console.log(`${result.verdict.padEnd(8)} ${variant.padEnd(16)} r${round} ${String(result.ms).padStart(6)}ms load=${result.load} ${result.said}${result.left ? ` LEFT=${JSON.stringify(result.left)}` : ""}`);
    if (out) writeFileSync(out, JSON.stringify(results, null, 1));
  }
}

const good = (t: Trial) => t.verdict === "ok" || t.verdict === "refused";
// A trial whose setup failed says nothing about the send; it is counted apart.
const counted = results.filter((t) => t.verdict !== "setup");
console.log("\nvariant           good/total   p50ms   max ms   bad verdicts");
for (const variant of chosen) {
  const mine = counted.filter((t) => t.variant === variant);
  const times = mine.map((t) => t.ms).sort((a, b) => a - b);
  const bad = mine.filter((t) => !good(t)).map((t) => t.verdict);
  console.log(`${variant.padEnd(18)}${`${mine.filter(good).length}/${mine.length}`.padEnd(13)}${String(times[Math.floor(times.length / 2)] ?? 0).padStart(6)}${String(times.at(-1) ?? 0).padStart(9)}   ${bad.join(",")}`);
}
const total = counted.filter(good).length;
console.log(`\nall: ${total}/${counted.length} good · stuck ${counted.filter((t) => t.verdict === "stuck").length} · dup ${counted.filter((t) => t.verdict === "dup").length} · setup failed ${results.length - counted.length}`);
