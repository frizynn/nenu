import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchHistory, fetchSkills } from "@/lib/api";
import { http, HttpResponse } from "msw";
import { server } from "@/test/setup";
import { setLocked } from "@/lib/idle";
import type { PaneHistoryResponse } from "@/lib/types";
import { useLiveConversation } from "./use-live-conversation";

vi.mock("@/lib/api", async (original) => ({ ...await original<typeof import("@/lib/api")>(), fetchHistory: vi.fn() }));
const fetchMock = vi.mocked(fetchHistory);
const history = (paneId: string): PaneHistoryResponse => ({
  paneId,
  available: true,
  entries: [],
  hasMore: false,
  total: 0,
  fileTruncated: false,
});

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(history("w1:p1"));
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  setLocked(false);
});

afterEach(() => {
  vi.useRealTimers();
  setLocked(false);
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});

describe("useLiveConversation", () => {
  it("bounds busy polls to the newest 60 turns and never overlaps requests", async () => {
    let resolve!: (value: PaneHistoryResponse) => void;
    fetchMock.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const { result, unmount } = renderHook(() => useLiveConversation({ paneId: "w1:p1", session: "work", enabled: true, busy: true }));
    expect(fetchMock).toHaveBeenCalledWith("w1:p1", { limit: 60 }, "work", expect.any(AbortSignal));
    await act(async () => {
      result.current.refresh();
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => resolve(history("w1:p1")));
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("aborts a previous session and ignores its late result", async () => {
    let resolve!: (value: PaneHistoryResponse) => void;
    fetchMock.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const { result, rerender, unmount } = renderHook(({ session }) => useLiveConversation({ paneId: "w1:p1", session, enabled: true }), { initialProps: { session: "one" } });
    const oldSignal = fetchMock.mock.calls[0]![3]!;
    fetchMock.mockResolvedValue(history("new-session"));
    await act(async () => rerender({ session: "two" }));
    expect(oldSignal.aborted).toBe(true);
    await act(async () => resolve(history("old-session")));
    expect(result.current.history?.paneId).toBe("new-session");
    unmount();
  });

  it("pauses while hidden or locked, then immediately catches up on resume", async () => {
    const { unmount } = renderHook(() => useLiveConversation({ paneId: "w1:p1", enabled: true }));
    await act(async () => {});
    await act(async () => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => setLocked(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => setLocked(false));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    unmount();
  });

  it("retains the last good conversation during errors and uses idle cadence", async () => {
    const { result, unmount } = renderHook(() => useLiveConversation({ paneId: "w1:p1", enabled: true }));
    await act(async () => {});
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    expect(result.current.error).toBe(true);
    expect(result.current.history?.paneId).toBe("w1:p1");
    await act(async () => result.current.refresh());
    expect(result.current.error).toBe(false);
    unmount();
  });

  it("does not fetch when disabled and clears another pane's displayed history", async () => {
    const { result, rerender, unmount } = renderHook(({ paneId, enabled }) => useLiveConversation({ paneId, enabled }), { initialProps: { paneId: "w1:p1", enabled: true } });
    await act(async () => {});
    await act(async () => rerender({ paneId: "w2:p1", enabled: false }));
    expect(result.current.history).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    unmount();
  });
  it("unchanged background polls retain history identity without rerendering the hook", async () => {
    let renders = 0;
    const stable = history("stable");
    fetchMock.mockResolvedValue(stable);
    const { result, unmount } = renderHook(() => {
      renders++;
      return useLiveConversation({ paneId: "stable", enabled: true, busy: true });
    });
    await act(async () => {});
    const before = renders;
    await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
    expect(fetchMock).toHaveBeenCalledTimes(11);
    expect(result.current.history).toBe(stable);
    expect(renders).toBe(before);
    unmount();
  });

  it("drops the last good transcript when the next poll loses read authorization", async () => {
    server.use(http.get(/\/api\/pane\/[^/]+\/skills$/, () => new HttpResponse("Forbidden", { status: 403 })));
    let denied: unknown;
    try { await fetchSkills("forbidden"); } catch (error) { denied = error; }
    const { result, unmount } = renderHook(() => useLiveConversation({ paneId: "auth", enabled: true }));
    await act(async () => {});
    expect(result.current.history).not.toBeNull();
    fetchMock.mockRejectedValueOnce(denied);
    await act(async () => result.current.refresh());
    expect(result.current.history).toBeNull();
    expect(result.current.error).toBe(true);
    unmount();
  });

  it("refreshes immediately on idle to busy and then keeps the four-second cadence", async () => {
    const { rerender, unmount } = renderHook(({ busy }) => useLiveConversation({ paneId: "one", enabled: true, busy }), { initialProps: { busy: false } });
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await act(async () => rerender({ busy: true }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => rerender({ busy: true }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(3999); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    unmount();
  });

  it("refreshes completion metadata immediately even when the latest entry UUID is unchanged", async () => {
    const running: PaneHistoryResponse = { ...history("one"), available: true, entries: [{ uuid: "same-entry", role: "assistant", ts: "", turnId: "turn-one", parts: [{ kind: "thinking", text: "Working" }], turn: { status: "running" } }], hasMore: false, total: 1, fileTruncated: false };
    const completed: PaneHistoryResponse = { ...running, entries: running.entries.map((entry) => ({ ...entry, turn: { status: "completed", durationMs: 4200 } })) };
    fetchMock.mockResolvedValueOnce(running).mockResolvedValue(completed);
    const { result, rerender, unmount } = renderHook(({ busy }) => useLiveConversation({ paneId: "one", enabled: true, busy }), { initialProps: { busy: true } });
    await act(async () => {});
    expect(result.current.history).toBe(running);
    await act(async () => rerender({ busy: false }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.history).toBe(completed);
    await act(async () => { await vi.advanceTimersByTimeAsync(11_999); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    unmount();
  });

  it("coalesces activity transitions during a read into exactly one immediate follow-up", async () => {
    let resolve!: (value: PaneHistoryResponse) => void;
    fetchMock.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const { rerender, unmount } = renderHook(({ busy }) => useLiveConversation({ paneId: "one", enabled: true, busy }), { initialProps: { busy: false } });
    await act(async () => rerender({ busy: true }));
    await act(async () => rerender({ busy: false }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => resolve(history("one")));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(11_999); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    unmount();
  });

  it.each(["hidden", "disabled", "locked"])("does not fetch activity edges while %s and resumes with a single read", async (mode) => {
    const { rerender, unmount } = renderHook(({ busy, enabled }) => useLiveConversation({ paneId: "one", enabled, busy }), { initialProps: { busy: false, enabled: true } });
    await act(async () => {});
    await act(async () => {
      if (mode === "hidden") {
        Object.defineProperty(document, "hidden", { configurable: true, value: true });
        document.dispatchEvent(new Event("visibilitychange"));
      } else if (mode === "locked") setLocked(true);
      else rerender({ busy: false, enabled: false });
    });
    await act(async () => rerender({ busy: true, enabled: mode !== "disabled" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      if (mode === "hidden") {
        Object.defineProperty(document, "hidden", { configurable: true, value: false });
        document.dispatchEvent(new Event("visibilitychange"));
      } else if (mode === "locked") setLocked(false);
      else rerender({ busy: true, enabled: true });
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("discards an old scope's queued transition instead of refreshing the new scope twice", async () => {
    let resolve!: (value: PaneHistoryResponse) => void;
    fetchMock.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const { rerender, result, unmount } = renderHook(({ busy, session }) => useLiveConversation({ paneId: "one", session, enabled: true, busy }), { initialProps: { busy: false, session: "old" } });
    await act(async () => rerender({ busy: true, session: "old" }));
    const oldSignal = fetchMock.mock.calls[0]![3]!;
    const current = history("new-session");
    fetchMock.mockResolvedValue(current);
    await act(async () => rerender({ busy: false, session: "new" }));
    expect(oldSignal.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => resolve(history("old-session")));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.history).toBe(current);
    unmount();
  });

});


it("keeps the cached conversation quiet during a brief failed refresh", async () => {
  const hook = renderHook(() => useLiveConversation({ paneId: "w1:p1", enabled: true, busy: true }));
  await act(async () => {});
  fetchMock.mockRejectedValue(new Error("weak signal"));
  await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
  expect(hook.result.current.history?.available).toBe(true);
  expect(hook.result.current.error).toBe(false);
  hook.unmount();
});
