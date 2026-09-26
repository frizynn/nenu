import { describe, expect, test, spyOn } from "bun:test";
import { historyResponse } from "./history-response.ts";
import type { TranscriptPage } from "./journal/types.ts";
import type { JournalAdapter } from "./journal/types.ts";
import { parseCodexTranscript } from "./journal/codex.ts";
import { TranscriptStore } from "./journal/store.ts";

const page = (text: string): Omit<TranscriptPage, "paneId"> => ({
  entries: [{ uuid: "one", ts: "", role: "assistant", parts: [{ kind: "text", text }] }],
  total: 1, hasMore: false, fileTruncated: false,
});

describe("conditional history response", () => {
  test("a native completion-only append changes the validator and delivers same-UUID turn metadata", async () => {
    const row = (type: string, payload: unknown) => JSON.stringify({ type, timestamp: "2026-09-08T00:00:00.000Z", payload });
    let log = [
      row("event_msg", { type: "task_started", turn_id: "work-one" }),
      row("response_item", { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Answer already rendered" }] }),
    ].join("\n");
    let mtimeMs = 1;
    const adapter: JournalAdapter = {
      agent: "codex", parse: parseCodexTranscript,
      source: {
        resolve: async () => "/contained/fake.jsonl",
        stat: async () => ({ size: log.length, mtimeMs }),
        load: async () => ({ text: log, size: log.length, mtimeMs, complete: true }),
      },
    };
    const store = new TranscriptStore(), ref = { kind: "id" as const, value: "session" };
    const pending = (await store.page(adapter, ref, { limit: 60 }))!;
    const first = historyResponse(pending, "pane", null, null), previousEtag = first.headers.get("etag");
    expect(pending.entries[0]!.turn?.status).toBe("running");
    expect(pending.entries[0]!.phase).toBe("final_answer");
    expect(historyResponse((await store.page(adapter, ref, { limit: 60 }))!, "pane", previousEtag, null).status).toBe(304);

    log += `\n${row("event_msg", { type: "task_complete", turn_id: "work-one", duration_ms: 3477 })}`;
    mtimeMs++;
    const completed = (await store.page(adapter, ref, { limit: 60 }))!;
    expect(completed).not.toBe(pending);
    expect(completed.entries.map((entry) => entry.uuid)).toEqual(pending.entries.map((entry) => entry.uuid));
    expect(pending.entries[0]!.turn?.status).toBe("running"); // previously cached response stays immutable
    const changed = historyResponse(completed, "pane", previousEtag, null);
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(previousEtag);
    const body = await changed.json();
    expect(body.entries[0]).toMatchObject({ phase: "final_answer", turn: { status: "completed", durationMs: 3477 } });
    expect(historyResponse((await store.page(adapter, ref, { limit: 60 }))!, "pane", changed.headers.get("etag"), null).status).toBe(304);
  });
  test("unchanged pages have an empty no-store 304 with no repeat JSON serialization", async () => {
    const data = page("An unchanged message");
    const first = historyResponse(data, "one", null, "gzip");
    const etag = first.headers.get("etag");
    expect(etag).not.toBeNull();
    const stringify = spyOn(JSON, "stringify");
    try {
      const unchanged = historyResponse(data, "one", etag, "gzip");
      expect(unchanged.status).toBe(304);
      expect(unchanged.headers.get("cache-control")).toBe("no-store");
      expect(unchanged.headers.get("etag")).toBe(etag);
      expect(await unchanged.text()).toBe("");
      expect(stringify).not.toHaveBeenCalled();
    } finally { stringify.mockRestore(); }
  });

  test("changed content, paging and pane identities do not reuse a stale representation", () => {
    const initial = page("one");
    const etag = historyResponse(initial, "one", null, null).headers.get("etag");
    expect(historyResponse(page("two"), "one", etag, null).status).toBe(200);
    expect(historyResponse({ ...initial, hasMore: true }, "one", etag, null).status).toBe(200);
    expect(historyResponse(initial, "two", etag, null).status).toBe(200);
  });
});


test("multiple readers reuse the encoded history without serializing or compressing again", async () => {
  const data = page("Repeatable message ".repeat(1000));
  const first = historyResponse(data, "one", null, "gzip");
  const bytes = await first.arrayBuffer();
  const stringify = spyOn(JSON, "stringify");
  const gzip = spyOn(Bun, "gzipSync");
  try {
    const next = historyResponse(data, "one", null, "gzip");
    expect(await next.arrayBuffer()).toEqual(bytes);
    expect(stringify).not.toHaveBeenCalled();
    expect(gzip).not.toHaveBeenCalled();
    const plain = historyResponse(data, "one", null, null);
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect((await plain.json()).entries).toEqual(data.entries);
  } finally { stringify.mockRestore(); gzip.mockRestore(); }
});


test("large pages do not retain their encoded body but keep conditional reads cheap", async () => {
  const data = page("large ".repeat(60_000));
  const first = historyResponse(data, "one", null, "gzip");
  const expected = await first.arrayBuffer();
  const stringify = spyOn(JSON, "stringify");
  try {
    expect(historyResponse(data, "one", first.headers.get("etag"), "gzip").status).toBe(304);
    expect(stringify).not.toHaveBeenCalled();
    expect(await historyResponse(data, "one", null, "gzip").arrayBuffer()).toEqual(expected);
    expect(stringify).toHaveBeenCalledTimes(1);
  } finally { stringify.mockRestore(); }
});
