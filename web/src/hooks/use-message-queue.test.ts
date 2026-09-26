import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchMessageQueue, changeMessageQueue } from "@/lib/api";
import { useMessageQueue } from "./use-message-queue";

vi.mock("@/lib/api", () => ({
  fetchMessageQueue: vi.fn(),
  changeMessageQueue: vi.fn(),
}));
const page = {
  available: true as const,
  scope: "conversation-one",
  messages: [],
};
beforeEach(() => {
  sessionStorage.clear();
  vi.resetAllMocks();
  vi.mocked(fetchMessageQueue).mockResolvedValue(page);
});
describe("queue acknowledgements", () => {
  it("reuses an enqueue ID after an uncertain response and a remount", async () => {
    vi.mocked(changeMessageQueue).mockRejectedValueOnce(
      new Error("Connection lost"),
    );
    const first = renderHook(() => useMessageQueue("pane", "session", true));
    await waitFor(() => expect(first.result.current.page).toEqual(page));
    await act(async () => {
      expect(await first.result.current.mutate("add", "Follow up")).toBe(false);
    });
    const id = vi.mocked(changeMessageQueue).mock.calls[0]![1].id;
    first.unmount();
    vi.mocked(changeMessageQueue).mockResolvedValue(page);
    const next = renderHook(() => useMessageQueue("pane", "session", true));
    await waitFor(() => expect(next.result.current.page).toEqual(page));
    await act(async () => {
      expect(await next.result.current.mutate("add", "Follow up")).toBe(true);
    });
    expect(vi.mocked(changeMessageQueue).mock.calls[1]![1].id).toBe(id);
    await act(async () => {
      await next.result.current.mutate("add", "Follow up");
    });
    expect(vi.mocked(changeMessageQueue).mock.calls[2]![1].id).not.toBe(id);
    next.unmount();
  });
  it("does not acknowledge a write when the conversation is unavailable", async () => {
    vi.mocked(changeMessageQueue).mockResolvedValue({
      available: false,
      messages: [],
    });
    const hook = renderHook(() => useMessageQueue("pane", "session", true));
    await waitFor(() => expect(hook.result.current.page).toEqual(page));
    await act(async () => {
      expect(await hook.result.current.mutate("add", "Keep my draft")).toBe(
        false,
      );
    });
    expect(hook.result.current.error).toMatch(/conversation/i);
    hook.unmount();
  });
});

it("keeps cached queue refresh failures quiet while a brief drop recovers", async () => {
  vi.useFakeTimers();
  const hook = renderHook(() => useMessageQueue("pane", "session", true));
  try {
    await act(async () => {});
    vi.mocked(fetchMessageQueue).mockRejectedValue(new Error("weak signal"));
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(hook.result.current.page).toEqual(page);
    expect(hook.result.current.error).toBe("");
    vi.mocked(fetchMessageQueue).mockResolvedValue(page);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(hook.result.current.error).toBe("");
  } finally { hook.unmount(); vi.useRealTimers(); }
});
