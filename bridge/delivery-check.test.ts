import { describe, expect, test } from "bun:test";

import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeLogReader, deliveryVerdict, loggedMessage, sameMessage } from "./delivery-check.ts";

// Shapes measured on Claude Code 2.1.296, 2.1.299 and 2.1.300 under Herdr 0.9.3 on macOS. The PTY
// hands a 1 500-character send to Claude as two reads, 1 022 and 478 bytes; Claude takes the first
// as a paste, and about two times in three it then logs only the 478. A paste it keeps is logged
// inside `<pasted_content>` tags, with the literal tail after them.

const wrap = (text: string, id = "75ce") => `\n\n<pasted_content id="${id}">\n${text}\n</pasted_content id="${id}">\n`;
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const row = (content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "user", message: { role: "user", content }, origin: { kind: "human" }, timestamp: "2026-10-14T19:57:00.399Z", ...extra });

describe("loggedMessage", () => {
  test("reads the operator's typed message and when Claude logged it", () => {
    expect(loggedMessage(row("deploy the staging build"))).toEqual({ at: Date.parse("2026-10-14T19:57:00.399Z"), text: "deploy the staging build" });
    expect(loggedMessage(row([{ type: "text", text: "with blocks" }]))?.text).toBe("with blocks");
  });

  test("skips what the operator did not type: tool results, meta rows, commands, other row types", () => {
    expect(loggedMessage(row([{ type: "tool_result", tool_use_id: "t", content: "ok" }]))).toBeNull();
    expect(loggedMessage(row("<system-reminder>x</system-reminder>", { origin: undefined, isMeta: true }))).toBeNull();
    expect(loggedMessage(row("a notice", { origin: { kind: "task-notification" } }))).toBeNull();
    expect(loggedMessage(row("<command-name>/compact</command-name>\n<command-args></command-args>"))).toBeNull();
    expect(loggedMessage(row("<bash-input>ls</bash-input>"))).toBeNull();
    expect(loggedMessage(JSON.stringify({ type: "assistant", message: { content: "hi" }, timestamp: "2026-10-14T19:57:00Z" }))).toBeNull();
    expect(loggedMessage("not json")).toBeNull();
  });
});

describe("deliveryVerdict", () => {
  const sent = words(240); // about 1 500 characters, one line

  test("a log that holds the whole message is complete, whatever Claude did to its whitespace", () => {
    expect(deliveryVerdict(sent, sent)).toEqual({ verdict: "complete" });
    expect(deliveryVerdict(sent, `${wrap(sent.slice(0, 1022))}\n${sent.slice(1022)}`)).toEqual({ verdict: "complete" });
    const lines = sent.replaceAll(" word1", "\nword1");
    expect(deliveryVerdict(lines, wrap(lines))).toEqual({ verdict: "complete" });
  });

  test("a log holding only the tail is incomplete, and says how much arrived", () => {
    const tail = sent.slice(1022);
    expect(deliveryVerdict(sent, tail)).toEqual({ verdict: "incomplete", sentChars: sent.length, receivedChars: tail.length });
    expect(deliveryVerdict(`${sent} OK.`, "OK.")).toMatchObject({ verdict: "incomplete", receivedChars: 3 });
  });

  test("nothing logged, or a message Claude rewrites on purpose, cannot be judged", () => {
    expect(deliveryVerdict(sent, null)).toEqual({ verdict: "unknown" });
    // Claude attaches an image path as `[Image #1]`, so the log is shorter by design.
    expect(deliveryVerdict(`look at this /tmp/up/w1_p1-shot.png ${sent}`, `[Image #1] look at this ${sent}`)).toEqual({ verdict: "unknown" });
    // A log longer than the message, or different in content, is a rewrite this check does not model.
    expect(deliveryVerdict("short", "short and then some")).toEqual({ verdict: "unknown" });
  });
});

describe("claudeLogReader (ADR 0116)", () => {
  const at = (ms: number) => new Date(ms).toISOString();
  const typed = (text: string, ms: number) => JSON.stringify({ type: "user", timestamp: at(ms), message: { role: "user", content: text } });
  const enqueue = (text: string, ms: number) => JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: at(ms), content: text });
  async function logFile(lines: string[]) {
    const dir = await mkdtemp(join(tmpdir(), "nenu-log-"));
    const path = join(dir, "s.jsonl");
    await writeFile(path, lines.map((line) => `${line}\n`).join(""));
    return { path, dir, add: (line: string) => appendFile(path, `${line}\n`) };
  }
  const sent = "deploy the staging build and tell me when it is up";

  test("answers this message logged, and skips another one logged in the same window", async () => {
    const log = await logFile([typed("someone else typed this at the terminal", 2_000)]);
    const read = claudeLogReader(async () => log.path);
    expect(await read(1_000, sent)).toEqual({ kind: "none" });
    await log.add(typed(sent, 3_000));
    expect(await read(1_000, sent)).toEqual({ kind: "logged", text: sent });
    await rm(log.dir, { recursive: true });
  });

  test("answers queued for this message enqueued mid-turn, never for another", async () => {
    const log = await logFile([enqueue("another message", 2_000)]);
    const read = claudeLogReader(async () => log.path);
    expect(await read(1_000, sent)).toEqual({ kind: "none" });
    await log.add(enqueue(sent, 3_000));
    expect(await read(1_000, sent)).toEqual({ kind: "queued" });
    await rm(log.dir, { recursive: true });
  });

  test("a logged tail a dropped head left is this message; pictures are compared without their paths", async () => {
    expect(sameMessage(words(240), words(240).slice(1022))).toBe(true);
    expect(sameMessage(words(240), "word239")).toBe(false);
    expect(sameMessage("look /s/uploads/a-k3-0a1b2c3d.png here", "look [Image #4] here")).toBe(true);
  });

  test("says nothing about a moment its first look did not read back to, nor without a log", async () => {
    // Over 1 MiB of rows after the moment asked about: the first look starts past it.
    const filler = Array.from({ length: 3_000 }, (_, i) => typed(`filler ${"x".repeat(400)} ${i}`, 5_000 + i));
    const log = await logFile(filler);
    expect(await claudeLogReader(async () => log.path)(1_000, sent)).toEqual({ kind: "unreadable" });
    expect(await claudeLogReader(async () => log.path)(9_000, sent)).toEqual({ kind: "none" });
    expect(await claudeLogReader(async () => null)(1_000, sent)).toEqual({ kind: "unreadable" });
    await rm(log.dir, { recursive: true });
  });
});
