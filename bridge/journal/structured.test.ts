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
  test("a command keeps its description and an edit its lines added and removed", () => {
    const call = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
    const parts = parse([{ type: "assistant", uuid: "a", timestamp: "t", message: { role: "assistant", content: [
      call("b", "Bash", { command: "bun test", description: "Run the  tests" }),
      call("e", "Edit", { file_path: "a.ts", old_string: "keep\nold\nkeep", new_string: "keep\nnew\nnewer\nkeep" }),
      call("m", "MultiEdit", { file_path: "a.ts", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c\nd", new_string: "" }] }),
      call("w", "Write", { file_path: "b.ts", content: "one\ntwo\n" }),
      call("r", "Read", { file_path: "a.ts" }),
    ] } }]).entries()[0]!.parts;
    expect(parts.map((part) => part.kind === "tool" ? [part.description, part.diff] : null)).toEqual([
      ["Run the tests", undefined], [undefined, { added: 2, removed: 1 }], [undefined, { added: 1, removed: 3 }],
      [undefined, undefined], [undefined, undefined],
    ]);
  });

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

  // Captured 2026-10-14 in a disposable Herdr 0.9.3 with Claude Code 2.1.300: three 1 500-character
  // messages Nenu sent as one bracketed paste each (A typed, C queued for after the turn, D sent into
  // Claude's own queue and absorbed mid-turn). Claude logged every one between `<pasted_content>` tags.
  test("a pasted message reads as the text it held, whole and without Claude's paste tags (2.1.300)", async () => {
    const parser = new ClaudeParser();
    feedText(await Bun.file(join(FIXTURES, "journal-long-paste-v2300.jsonl")).text(), (l, o, b) => parser.line(l, o, b));
    const said = parser.entries().filter((e) => e.role === "user").map((e) => (e.parts[0]?.kind === "text" ? e.parts[0].text : ""));
    const pasted = said.filter((text) => text.includes("-HEAD-MARK"));
    expect(pasted.map((text) => text.match(/([A-Z])-HEAD-MARK/)?.[1])).toEqual(["A", "C", "D"]);
    for (const text of pasted) {
      expect(text).not.toContain("pasted_content");
      expect(text).toMatch(/^Reply only OK\. [A-Z]-HEAD-MARK alpha0 bravo1 /);
      expect(text).toMatch(/ [A-Z]-TAIL-MARK reply only OK\.$/);
      expect(text).toHaveLength(1500);
    }
    // Claude's own queue rows name the message as the operator wrote it, so a queued row can find it.
    const { queue } = parser.facts();
    expect(queue.filter((q) => q.kind === "enqueue" || q.kind === "remove" || q.kind === "queued_command").map((q) => q.content)).toEqual([pasted[2], pasted[2], pasted[2]]);
  });

  // 30 such rows in one machine's logs (2.1.280 to 2.1.299): a message with an image is a list of
  // blocks, and its text block carries the paste tags the same way.
  test("a paste beside an attached image reads without the tags too", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } };
    const text = { type: "text", text: '[Image #1] Look at this:\n\n<pasted_content id="5bb7">\nline one\nline two\n</pasted_content id="5bb7">\n' };
    const [entry] = parse([{ type: "user", uuid: "u", timestamp: "t", origin: { kind: "human" }, message: { role: "user", content: [image, text] } }]).entries();
    expect(entry!.parts).toEqual([{ kind: "image", index: 0, mediaType: "image/png" }, { kind: "text", text: "[Image #1] Look at this:\n\nline one\nline two" }]);
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

  test("a question's option descriptions ride beside its labels, one per option", () => {
    expect(parse([ask("q1")]).entries()[0]!.parts[0]).toMatchObject({ questions: [{ options: ["Apple", "Banana"], descriptions: ["red", ""] }] });
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
