import { describe, expect, test } from "bun:test";
import { mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  codexCursor,
  codexToolOutput,
  CodexTranscriptSource,
  isCodexSessionId,
  parseCodexTranscript,
} from "./codex.ts";

// Row builders mirroring the verified on-disk shape (codex rollout logs, cli 0.32.0, 2026-07-29).
// `{timestamp,type,payload}` are the only top-level keys — note the absence of any per-row id, which
// is the whole reason this adapter synthesises a cursor.
const item = (payload: Record<string, unknown>, ts = "2026-07-29T10:00:00.000Z") =>
  JSON.stringify({ timestamp: ts, type: "response_item", payload });

const message = (role: "user" | "assistant", text: string) =>
  item({
    type: "message",
    role,
    content: [{ type: role === "user" ? "input_text" : "output_text", text }],
  });

const event = (payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp: "2026-07-29T10:00:00.000Z", type: "event_msg", payload });

const meta = () =>
  JSON.stringify({
    timestamp: "2026-07-29T10:00:00.000Z",
    type: "session_meta",
    payload: { id: "116ee214-d563-4bcc-95f2-f03c5330d354", cwd: "/repo", cli_version: "0.32.0" },
  });

describe("isCodexSessionId", () => {
  test.each([
    ["a canonical uuid", "116ee214-d563-4bcc-95f2-f03c5330d354", true],
    ["a traversal attempt", "../../../etc/passwd", false],
    ["a uuid with a path glued on", "116ee214-d563-4bcc-95f2-f03c5330d354/../x", false],
    ["empty", "", false],
  ])("%s → %s", (_label, value, expected) => {
    expect(isCodexSessionId(value)).toBe(expected);
  });
});

describe("parseCodexTranscript", () => {
  test("reads a user turn and an assistant turn", () => {
    const entries = parseCodexTranscript(
      [meta(), message("user", "fix the types"), message("assistant", "I'll open the file.")].join("\n"),
    );
    expect(entries.map((e) => e.role)).toEqual(["user", "assistant"]);
    expect(entries[0]!.parts).toEqual([{ kind: "text", text: "fix the types" }]);
    expect(entries[0]!.ts).toBe("2026-07-29T10:00:00.000Z");
  });

  // THE trap in this format: every turn is written twice, once per family. Parsing both renders the
  // whole conversation double.
  test("drops the event_msg family — the conversation is double-booked", () => {
    const entries = parseCodexTranscript(
      [
        message("user", "fix the types"),
        event({ type: "user_message", message: "fix the types" }),
        event({ type: "agent_message", message: "on it" }),
        event({ type: "token_count", info: {} }),
        message("assistant", "on it"),
      ].join("\n"),
    );
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.parts[0]).map((p) => (p as { text: string }).text)).toEqual([
      "fix the types",
      "on it",
    ]);
  });

  test("native compacted completion renders once without exposing replacement history", () => {
    const compacted = JSON.stringify({
      timestamp: "2026-09-07T21:27:52.812Z", type: "compacted",
      payload: {
        message: "", replacement_history: [{ role: "developer", content: "Private injected instructions" }],
        guardian_history: [], window_number: 1, window_id: "opaque-window", latest_token_usage_record: {},
      },
    });
    const entries = parseCodexTranscript([message("user", "Before compaction"), compacted, message("assistant", "After compaction")].join("\n"));
    expect(entries.map((entry) => entry.role)).toEqual(["user", "summary", "assistant"]);
    expect(entries[1]?.parts).toEqual([{ kind: "text", text: "Context compacted" }]);
    expect(entries[1]?.ts).toBe("2026-09-07T21:27:52.812Z");
    expect(parseCodexTranscript(compacted)[0]?.uuid).toBe(entries[1]?.uuid);
    expect(JSON.stringify(entries)).not.toContain("Private injected instructions");
  });

  test("compaction preserves a bounded actual summary and ignores malformed bookkeeping", () => {
    const row = (payload: unknown) => JSON.stringify({ type: "compacted", payload });
    const entries = parseCodexTranscript(row({ message: "\u001b[31m" + "Summary ".repeat(4000) + "\u001b[0m" }));
    const part = entries[0]?.parts[0];
    expect(part?.kind).toBe("text");
    if (part?.kind !== "text") throw new Error("missing summary");
    expect(part.text.startsWith("Summary ")).toBe(true);
    expect(part.text.length).toBe(20_000);
    expect(part.truncated).toBe(true);
    expect(parseCodexTranscript([row(null), row({}), row({ message: { secret: "not text" } })].join("\n"))).toEqual([]);
  });

  test("session_meta and other bookkeeping rows render nothing", () => {
    expect(parseCodexTranscript(meta())).toEqual([]);
  });

  // Live-verified against codex 0.145: three `developer` rows carrying injected system prompts
  // (permissions, multi-agent instructions) precede the first real turn. Mapping "not assistant" to
  // "user" — which the parser used to do — rendered those as things the operator had said.
  test.each(["developer", "system", "tool"])("a %s role is plumbing and renders nothing", (role) => {
    const entries = parseCodexTranscript(
      item({
        type: "message",
        role,
        content: [{ type: "input_text", text: "<permissions instructions>…" }],
      }),
    );
    expect(entries).toEqual([]);
  });

  test.each([
    ["world_state", { type: "world_state", state: {} }],
    ["turn_context", { type: "turn_context", cwd: "/repo" }],
  ])("the 0.145 row type %s renders nothing", (_label, payload) => {
    expect(parseCodexTranscript(item(payload))).toEqual([]);
  });

  test("a reasoning summary becomes a thinking part (unlike Claude, this one has text)", () => {
    const entries = parseCodexTranscript(
      item({
        type: "reasoning",
        summary: [{ type: "summary_text", text: "**Inspecting TypeScript errors**" }],
        content: null,
        encrypted_content: "gAAAAA…",
      }),
    );
    expect(entries[0]!.parts).toEqual([
      { kind: "thinking", text: "**Inspecting TypeScript errors**" },
    ]);
  });

  test("an encrypted-only reasoning row renders nothing rather than an empty bubble", () => {
    const entries = parseCodexTranscript(
      item({ type: "reasoning", summary: [], content: null, encrypted_content: "gAAAAA…" }),
    );
    expect(entries).toEqual([]);
  });

  // `arguments` is a JSON STRING here (pi passes an object), and a shell call's `command` is an argv
  // ARRAY — both were places a naive reuse of the Claude summariser produced an empty line.
  test("a shell call summarises to its joined argv", () => {
    const entries = parseCodexTranscript(
      item({
        type: "function_call",
        name: "shell",
        arguments: JSON.stringify({ command: ["bash", "-lc", "ls -la"], timeout_ms: 120000 }),
        call_id: "call_1",
      }),
    );
    expect(entries[0]!.parts[0]).toMatchObject({
      kind: "tool",
      name: "shell",
      summary: "bash -lc ls -la",
    });
  });

  test("malformed arguments still summarise to something", () => {
    const entries = parseCodexTranscript(
      item({ type: "function_call", name: "shell", arguments: '{"command": ["bash"', call_id: "c" }),
    );
    expect((entries[0]!.parts[0] as { summary: string }).summary).not.toBe("");
  });

  test("an output folds onto the call that produced it", () => {
    const entries = parseCodexTranscript(
      [
        item({ type: "function_call", name: "shell", arguments: "{}", call_id: "call_1" }),
        item({
          type: "function_call_output",
          call_id: "call_1",
          output: JSON.stringify({ output: "total 0\n", metadata: {} }),
        }),
      ].join("\n"),
    );
    // One entry, not two: the result attaches to its call rather than becoming its own turn.
    expect(entries).toHaveLength(1);
    expect(entries[0]!.parts[0]).toMatchObject({
      kind: "tool",
      result: { text: "total 0\n" },
    });
  });

  test("an orphan output is kept unattached so the window never drops output", () => {
    const entries = parseCodexTranscript(
      item({ type: "function_call_output", call_id: "gone", output: '{"output":"stranded"}' }),
    );
    expect(entries[0]!.parts[0]).toMatchObject({ kind: "tool", name: "result" });
  });

  test("custom raw-code calls keep their literal input and fold content-list results by call_id", () => {
    const entries = parseCodexTranscript([
      event({ type: "task_started", turn_id: "custom-turn" }),
      item({ type: "custom_tool_call", name: "exec", input: 'const result = await run();\ntext(result);', call_id: "custom-one" }),
      item({ type: "custom_tool_call", name: "exec", input: '"literal JSON-looking code"', call_id: "custom-two" }),
      item({ type: "custom_tool_call_output", call_id: "custom-two", output: [{ type: "input_text", text: "Second result" }] }),
      item({ type: "custom_tool_call_output", call_id: "custom-one", output: [
        { type: "input_text", text: "Script completed" },
        { type: "input_text", text: '\u001b[31mError: <script>alert("literal")</script>\u001b[0m' },
        { type: "input_image", image_url: "data:image/png;base64,PRIVATE_IMAGE", text: "not a text block" },
      ] }),
      event({ type: "task_complete", turn_id: "custom-turn", duration_ms: 50 }),
    ].join("\n"));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ turnId: "custom-turn", turn: { status: "completed", durationMs: 50 } });
    expect(entries[0]!.parts[0]).toEqual({ kind: "tool", name: "exec", summary: "const result = await run(); text(result);", result: { text: 'Script completed\nError: <script>alert("literal")</script>', attachments: [{ kind: "image", index: 0, mediaType: "image/png" }] } });
    expect(entries[1]!.parts[0]).toMatchObject({ summary: '"literal JSON-looking code"', result: { text: "Second result" } });
    expect(JSON.stringify(entries)).not.toContain("PRIVATE_IMAGE");
    expect(parseCodexTranscript([
      item({ type: "custom_tool_call", name: "exec", input: 'const result = await run();\ntext(result);', call_id: "custom-one" }),
    ].join("\n"))[0]!.uuid).toBe(entries[0]!.uuid);
  });

  test("custom tool text is bounded, supports string results, and preserves orphan output", () => {
    const entries = parseCodexTranscript([
      item({ type: "custom_tool_call", name: "exec", input: "x".repeat(400), call_id: "long" }),
      item({ type: "custom_tool_call_output", call_id: "long", output: [{ type: "input_text", text: "y".repeat(3000) }] }),
      item({ type: "custom_tool_call_output", call_id: "missing", output: "Literal tool error" }),
      item({ type: "custom_tool_call_output", call_id: "ignored", output: [null, {}, { type: "input_text", text: 3 }, { type: "input_image", image_url: "hidden" }] }),
    ].join("\n"));
    expect(entries).toHaveLength(2);
    const part = entries[0]!.parts[0];
    expect(part).toMatchObject({ kind: "tool", summary: `${"x".repeat(200)}…`, result: { text: "y".repeat(2000), truncated: true } });
    expect(entries[1]!.parts[0]).toEqual({ kind: "tool", name: "result", summary: "", result: { text: "Literal tool error" } });
  });

  test("injected environment context is dropped, not rendered as something you said", () => {
    const entries = parseCodexTranscript(
      [
        message("user", "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>"),
        message("user", "help me fix the typescript errors"),
      ].join("\n"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.parts[0]).toMatchObject({ text: "help me fix the typescript errors" });
  });

  test("injected AGENTS instructions stored with a user role are hidden like Codex hides them", () => {
    const injected = [
      "# AGENTS.md instructions for /Users/fran/Developer/soflex",
      "",
      "<INSTRUCTIONS>",
      "# Workspace Soflex",
      "Never print secrets.",
      "</INSTRUCTIONS>",
    ].join("\n");
    const entries = parseCodexTranscript([
      message("user", injected),
      message("user", "review PR 152"),
    ].join("\n"));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.parts[0]).toMatchObject({ text: "review PR 152" });
  });

  test("removes Codex memory metadata from a final answer but preserves its visible text", () => {
    const final = item({
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: [
        "The PR is ready.",
        "",
        "<oai-mem-citation>",
        "<citation_entries>",
        "MEMORY.md:1-2|note=[context]",
        "</citation_entries>",
        "<rollout_ids>",
        "01a067f0-290a-7282-af86-cb10a95c001c",
        "</rollout_ids>",
        "</oai-mem-citation>",
      ].join("\n") }],
    });
    const entries = parseCodexTranscript(final);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.parts).toEqual([{ kind: "text", text: "The PR is ready." }]);
  });

  test("keeps ordinary text that mentions instruction or memory tags", () => {
    const entries = parseCodexTranscript([
      message("user", "Why does <INSTRUCTIONS> appear?"),
      item({ type: "message", role: "assistant", phase: "final_answer", content: [
        { type: "output_text", text: "The literal <oai-mem-citation> tag is documented here." },
      ] }),
    ].join("\n"));
    expect(entries.map((entry) => (entry.parts[0] as { text: string }).text)).toEqual([
      "Why does <INSTRUCTIONS> appear?",
      "The literal <oai-mem-citation> tag is documented here.",
    ]);
  });

  test("a clipped or partial line is skipped, not thrown on", () => {
    const entries = parseCodexTranscript(
      ['{"timestamp":"2026","type":"response_i', message("user", "hi")].join("\n"),
    );
    expect(entries).toHaveLength(1);
  });

  test("every entry gets a cursor, and identical rows still get distinct ones", () => {
    const dup = item({ type: "function_call", name: "shell", arguments: "{}", call_id: "c" });
    const entries = parseCodexTranscript([dup, dup].join("\n"));
    expect(entries).toHaveLength(2);
    expect(entries[0]!.uuid).not.toBe(entries[1]!.uuid);
    expect(entries.every((e) => e.uuid !== "")).toBe(true);
  });
});

describe("codexToolOutput", () => {
  test("unwraps the JSON envelope codex writes", () => {
    expect(codexToolOutput('{"output":"hello","metadata":{}}')).toBe("hello");
  });

  test("a non-JSON output is its own text rather than nothing", () => {
    expect(codexToolOutput("plain text")).toBe("plain text");
  });

  test("JSON without an output field falls back to the raw string", () => {
    expect(codexToolOutput('{"other":1}')).toBe('{"other":1}');
  });
});

describe("codexCursor", () => {
  test("is deterministic for the same row", () => {
    expect(codexCursor("a", new Map())).toBe(codexCursor("a", new Map()));
  });

  test("depends on content, not position — the point of hashing rather than counting", () => {
    const seen = new Map<string, number>();
    codexCursor("filler", seen);
    codexCursor("filler", seen);
    // "a" is the third row here but the first anywhere else; its cursor must not encode that.
    expect(codexCursor("a", seen)).toBe(codexCursor("a", new Map()));
  });
});

// The fs half. Codex's resolve is a targeted walk of date-partitioned directories, and it now walks
// EACH configured sessions root in turn (a second CODEX_HOME is the same multi-home case Claude's
// CLAUDE_CONFIG_DIR raised — issue #92). Real files, because containment runs on realpaths.
describe("CodexTranscriptSource — several sessions roots", () => {
  const A = "11111111-aaaa-bbbb-cccc-222222222222";
  const B = "33333333-dddd-eeee-ffff-444444444444";

  /**
   * base/a/2026/08/11/rollout-…-<A>.jsonl   the first home's log
   * base/b/2026/08/11/rollout-…-<B>.jsonl   the second home's log
   * base/outside.jsonl                      a file neither root may reach
   */
  async function fixture() {
    const created = `${tmpdir()}/collie-codex-roots-${Math.floor(performance.now() * 1000)}`;
    await mkdir(created, { recursive: true });
    const base = await realpath(created);
    const a = `${base}/a`;
    const b = `${base}/b`;
    await mkdir(`${a}/2026/08/11`, { recursive: true });
    await mkdir(`${b}/2026/08/11`, { recursive: true });
    await Bun.write(`${a}/2026/08/11/rollout-2026-08-11T09-00-00-${A}.jsonl`, "{}\n");
    await Bun.write(`${b}/2026/08/11/rollout-2026-08-11T10-00-00-${B}.jsonl`, "{}\n");
    await Bun.write(`${base}/outside.jsonl`, "{}\n");
    return { base, a, b };
  }

  test("a single root string behaves exactly as before", async () => {
    const { base, a } = await fixture();
    const src = new CodexTranscriptSource(a);
    expect(await src.resolve({ kind: "id", value: A })).toEndWith(`${A}.jsonl`);
    expect(await src.resolve({ kind: "id", value: B })).toBeNull();
    await rm(base, { recursive: true, force: true });
  });

  test("finds a session under whichever root holds it", async () => {
    const { base, a, b } = await fixture();
    const src = new CodexTranscriptSource([a, b]);
    expect(await src.resolve({ kind: "id", value: A })).toEndWith(`${A}.jsonl`);
    expect(await src.resolve({ kind: "id", value: B })).toEndWith(`${B}.jsonl`);
    await rm(base, { recursive: true, force: true });
  });

  test("a rollout symlinked out of its root is refused, and the next root still answers", async () => {
    const { base, a, b } = await fixture();
    await symlink(`${base}/outside.jsonl`, `${a}/2026/08/11/rollout-2026-08-11T11-00-00-${B}.jsonl`);
    const src = new CodexTranscriptSource([a, b]);
    expect(await src.resolve({ kind: "id", value: B })).toBe(
      `${b}/2026/08/11/rollout-2026-08-11T10-00-00-${B}.jsonl`,
    );
    await rm(base, { recursive: true, force: true });
  });
});

test("preserves asynchronous question text and choices outside the truncated tool summary", () => {
  const rows = parseCodexTranscript(JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "request_user_input_async", call_id: "question", arguments: JSON.stringify({ questions: [{ title: "Which source?", options: ["Instagram", "Web"] }] }) } }));
  expect(rows[0]?.parts[0]).toMatchObject({ questions: [{ title: "Which source?", options: ["Instagram", "Web"] }] });
});
