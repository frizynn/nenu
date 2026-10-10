import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { ClaudeParser } from "./journal/claude.ts";
import { feedText } from "./journal/lines.ts";
import type { NativeQueueEvent } from "./journal/types.ts";
import { effectiveMode, nativeState, normalizeMode, sendNowKeys, submitKind } from "./queue-native.ts";

const FIXTURES = join(import.meta.dir, "..", "web", "src", "lib", "harness", "claude", "fixtures");
const probeEvents = async () => {
  const parser = new ClaudeParser();
  feedText(await Bun.file(join(FIXTURES, "journal-queue-and-dialogs-v2296.jsonl")).text(), (l, o, b) => parser.line(l, o, b));
  return parser.facts().queue;
};
const at = (iso: string) => Date.parse(iso);

describe("what Claude's own queue did with a message (P0 journal, Claude Code 2.1.296)", () => {
  test("enqueued, then absorbed mid-turn (remove + queued_command)", async () => {
    const events = await probeEvents();
    const banana = "Also add the word BANANA to your final reply.";
    const enqueued = events.slice(0, 1);
    expect(nativeState(enqueued, banana, at("2026-10-10T00:04:31.000Z"))).toBe("enqueued");
    expect(nativeState(events, banana, at("2026-10-10T00:04:31.000Z"))).toBe("absorbed");
  });

  test("a dequeue with no content reads the head of the queue, not a task notification behind it", async () => {
    const events = await probeEvents();
    // "Say PLUM" (00:09:56) left by dequeue at 00:09:59; the notification queued at 00:10:19 is another item.
    expect(nativeState(events, "Say PLUM at the end.", at("2026-10-10T00:09:56.000Z"))).toBe("absorbed");
  });

  test("Up recalls the queue into the input box (popAll)", async () => {
    const events = await probeEvents();
    const cut = events.findIndex((e) => e.kind === "popAll");
    expect(nativeState(events.slice(0, cut + 1), "Say APPLE at the end.", at("2026-10-10T00:07:49.000Z"))).toBe("recalled");
  });

  test("an enqueue from before the delivery, or of other text, is not this message", async () => {
    const events = await probeEvents();
    expect(nativeState(events, "Say APPLE at the end.", at("2026-10-10T01:00:00.000Z"))).toBeUndefined();
    expect(nativeState(events, "Never sent", 0)).toBeUndefined();
  });

  test("two identical messages: the second stays queued after the first is read", () => {
    const events: NativeQueueEvent[] = [
      { kind: "enqueue", ts: "2026-10-10T00:00:00.000Z", content: "ok" },
      { kind: "enqueue", ts: "2026-10-10T00:00:10.000Z", content: "ok" },
      { kind: "dequeue", ts: "2026-10-10T00:00:11.000Z" },
    ];
    expect(nativeState(events, "ok", at("2026-10-10T00:00:09.000Z"))).toBe("enqueued");
  });
});

describe("delivery modes, as P0 measured the keys", () => {
  test("without a choice a row lands after the running turn, as the queue always did", () => {
    expect(normalizeMode("claude", undefined)).toBe("afterTurn");
    expect(normalizeMode("codex", undefined)).toBe("afterTurn");
  });

  test("Claude's Enter and Codex's Enter are one behaviour, named the CLI's way", () => {
    expect(normalizeMode("claude", "steer")).toBe("asap");
    expect(normalizeMode("codex", "asap")).toBe("steer");
    expect(effectiveMode({ agent: "claude", deliveryMode: "afterTurn", sendNow: true })).toBe("asap");
  });

  test("only Codex queues for the next turn with a key (Tab, while a turn runs)", () => {
    expect(submitKind("codex", "afterTurn", true)).toBe("tab");
    expect(submitKind("codex", "afterTurn", false)).toBe("enter");
    expect(submitKind("codex", "steer", true)).toBe("enter");
    expect(submitKind("claude", "afterTurn", true)).toBe("enter");
  });

  test("only Claude has a send-now chord that keeps the turn", () => {
    expect(sendNowKeys("claude")).toEqual(["ctrl+enter"]);
    expect(sendNowKeys("codex")).toBeNull();
  });
});
