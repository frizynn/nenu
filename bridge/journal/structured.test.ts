import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { ClaudeParser, claudeRowImages, parseClaudeTranscript } from "./claude.ts";
import { codexRowImages, parseCodexTranscript } from "./codex.ts";
import { deliveredFilePaths } from "./delivered.ts";
import { feedLines, feedText } from "./lines.ts";

// What the journal carries beside speech: images (as byte-free markers), SendUserFile's structured
// result, the session title, Claude's own queue rows, and a question still waiting for its answer.

const FIXTURES = join(import.meta.dir, "..", "..", "web", "src", "lib", "harness", "claude", "fixtures");
const parse = (lines: unknown[]) => {
  const parser = new ClaudeParser();
  feedText(lines.map((l) => JSON.stringify(l)).join("\n"), (line, offset, bytes) => parser.line(line, offset, bytes));
  return parser;
};
const ask = (id: string) => ({
  type: "assistant", uuid: `a-${id}`, timestamp: "2026-10-10T00:12:19.557Z",
  message: { role: "assistant", content: [{ type: "tool_use", id, name: "AskUserQuestion", input: {
    questions: [{ question: "Which fruits?", header: "Fruit", multiSelect: true, options: [{ label: "Apple", description: "red" }, { label: "Banana" }] }],
  } }] },
});
const answer = (id: string) => ({
  type: "user", uuid: `r-${id}`, timestamp: "t",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "The user answered" }] },
});

describe("Claude structured rows", () => {
  test("the P0 probe log: queue operations, the absorbed message as speech, and no pending question", async () => {
    const parser = new ClaudeParser();
    feedText(await Bun.file(join(FIXTURES, "journal-queue-and-dialogs-v2296.jsonl")).text(), (l, o, b) => parser.line(l, o, b));
    const { queue, pendingQuestion } = parser.facts();
    expect(queue.map((q) => q.kind).slice(0, 4)).toEqual(["enqueue", "remove", "queued_command", "enqueue"]);
    expect(queue[1]).toMatchObject({ kind: "remove", reason: "absorbed_mid_turn", content: "Also add the word BANANA to your final reply." });
    expect(queue[2]).toMatchObject({ kind: "queued_command", commandUuid: queue[1]!.commandUuid, deliveryId: queue[1]!.deliveryId });
    expect(queue.some((q) => q.kind === "popAll")).toBe(true);
    // Claude writes an absorbed message only as the attachment; it is still something the operator said.
    const said = parser.entries().filter((e) => e.role === "user").map((e) => e.parts[0]?.kind === "text" ? e.parts[0].text : "");
    expect(said).toContain("Also add the word BANANA to your final reply.");
    expect(pendingQuestion).toBeUndefined();
  });

  test("custom-title names the session, the newest one winning", () => {
    const parser = parse([
      { type: "custom-title", customTitle: "first", sessionId: "s" },
      { type: "custom-title", customTitle: "Acceso a skill de apuntes", sessionId: "s" },
    ]);
    expect(parser.facts().title).toBe("Acceso a skill de apuntes");
    expect(parse([]).facts().title).toBeUndefined();
  });

  test("an unanswered AskUserQuestion is a hint until its result arrives; ExitPlanMode carries the plan", () => {
    const pending = parse([ask("q1")]).facts().pendingQuestion;
    expect(pending).toEqual({ source: "claude-journal", observedAt: Date.parse("2026-10-10T00:12:19.557Z"), question: "Which fruits?", options: ["Apple", "Banana"] });
    expect(parse([ask("q1"), answer("q1")]).facts().pendingQuestion).toBeUndefined();
    const plan = parse([{ type: "assistant", uuid: "p", timestamp: "t", message: { role: "assistant", content: [
      { type: "tool_use", id: "p1", name: "ExitPlanMode", input: { plan: "1. do it" } },
    ] } }]).facts().pendingQuestion;
    expect(plan).toMatchObject({ source: "claude-journal", detail: "1. do it" });
    // The question also rides on the tool part, like Codex's request_user_input.
    expect(parse([ask("q1")]).entries()[0]!.parts[0]).toMatchObject({ questions: [{ title: "Which fruits?", options: ["Apple", "Banana"] }] });
  });

  test("SendUserFile attachments come from toolUseResult; a malformed or failed result adds none", () => {
    const send = { type: "assistant", uuid: "a", timestamp: "t", message: { role: "assistant", content: [{ type: "tool_use", id: "s1", name: "SendUserFile", input: {} }] } };
    const result = (extra: Record<string, unknown>, isError = false) => ({
      type: "user", uuid: "r", timestamp: "t",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "s1", content: "1 file delivered to user.", ...(isError ? { is_error: true } : {}) }] },
      ...extra,
    });
    const ok = parse([send, result({ toolUseResult: { caption: "c", display: "attach", attachments: [{ path: "/tmp/report.pdf", size: 1 }, { path: "relative.txt" }] } })]);
    expect(ok.entries()[0]!.parts[0]).toMatchObject({ result: { attachments: [{ kind: "file", path: "/tmp/report.pdf" }] } });
    expect(deliveredFilePaths(ok.entries())).toEqual(["/tmp/report.pdf"]);
    const failed = parse([send, result({ toolUseResult: { attachments: [{ path: "/tmp/x" }] } }, true)]);
    expect(failed.entries()[0]!.parts[0]).not.toHaveProperty("result.attachments");
  });

  test("the regex stays the fallback for a SendUserFile result without structured attachments", () => {
    const entries = parseClaudeTranscript([
      { type: "assistant", uuid: "a", timestamp: "t", message: { role: "assistant", content: [{ type: "tool_use", id: "s1", name: "SendUserFile", input: {} }] } },
      { type: "user", uuid: "r", timestamp: "t", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "s1", content: "1 files delivered to user.\n  /tmp/a.png → file_uuid: x" }] } },
    ].map((l) => JSON.stringify(l)).join("\n"));
    expect(deliveredFilePaths(entries)).toEqual(["/tmp/a.png"]);
  });

  test("rowImages counts images in the same order the parser numbers them", () => {
    const img = (data: string) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } });
    const row = { type: "user", message: { role: "user", content: [
      img("A"), { type: "tool_result", tool_use_id: "x", content: [img("B"), { type: "text", text: "t" }, img("C")] }, img("D"),
    ] } };
    expect(claudeRowImages(row).map((i) => i.data)).toEqual(["A", "B", "C", "D"]);
    expect(claudeRowImages({ type: "user", message: { content: "text" } })).toEqual([]);
  });
});

describe("Codex images", () => {
  const userImage = {
    timestamp: "t", type: "response_item", payload: { type: "message", role: "user", content: [
      { type: "input_text", text: '<image name=[Image #1] path="/var/folders/x/clipboard.png">' },
      { type: "input_image", image_url: "data:image/png;base64,QUJD", detail: "high" },
      { type: "input_text", text: "</image>" },
      { type: "input_text", text: "[Image #1] this looks wrong" },
    ] },
  };

  test("a pasted image is a marker and its wrapper text is not speech", () => {
    const [entry] = parseCodexTranscript(JSON.stringify(userImage));
    expect(entry!.parts).toEqual([{ kind: "image", index: 0, mediaType: "image/png" }, { kind: "text", text: "[Image #1] this looks wrong" }]);
    expect(JSON.stringify(entry)).not.toContain("QUJD");
    expect(codexRowImages(userImage)).toEqual([{ mediaType: "image/png", data: "QUJD" }]);
  });

  test("a remote image URL is neither indexed nor served", () => {
    const remote = { ...userImage, payload: { ...userImage.payload, content: [{ type: "input_image", image_url: "https://example.com/a.png" }, { type: "input_text", text: "hi" }] } };
    expect(parseCodexTranscript(JSON.stringify(remote))[0]!.parts).toEqual([{ kind: "text", text: "hi" }]);
    expect(codexRowImages(remote)).toEqual([]);
  });
});

describe("line framing", () => {
  test("byte offsets agree between the byte and text framings, multi-byte text included", () => {
    const text = '{"a":"ñandú"}\n\n{"b":"€"}\n{"partial"';
    const fromText: Array<[string, number, number]> = [];
    feedText(text, (l, o, b) => fromText.push([l, o, b]));
    const fromBytes: Array<[string, number, number]> = [];
    const consumed = feedLines(new TextEncoder().encode(text), 0, (l, o, b) => fromBytes.push([l, o, b]));
    expect(fromBytes).toEqual(fromText.slice(0, 2));
    expect(consumed).toBe(Buffer.byteLength('{"a":"ñandú"}\n\n{"b":"€"}\n'));
  });
});
