import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchMessageQueue, changeMessageQueue } from "@/lib/api";
import { setLocked } from "@/lib/idle";
import { resetLiveEvents } from "@/lib/live-events";
import { fakeLiveStream } from "@/test/live-stream";
import { queueRowStatus, useMessageQueue } from "./use-message-queue";

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
  localStorage.clear();
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
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(hook.result.current.page).toEqual(page);
    expect(hook.result.current.error).toBe("");
    expect(hook.result.current.refreshError).toBe("");
    vi.mocked(fetchMessageQueue).mockResolvedValue(page);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(hook.result.current.error).toBe("");
  } finally {
    hook.unmount();
    vi.useRealTimers();
  }
});

it("keeps mutation failures separate from background refreshes and reports sustained queue errors", async () => {
  vi.useFakeTimers();
  const hook = renderHook(() => useMessageQueue("pane", "session", true));
  try {
    await act(async () => {});
    vi.mocked(changeMessageQueue).mockRejectedValue(
      new Error("Message was not acknowledged"),
    );
    await act(async () => {
      await hook.result.current.mutate("add", "draft");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(hook.result.current.error).toBe("Message was not acknowledged");
    vi.mocked(fetchMessageQueue).mockRejectedValue(
      new Error("queue unavailable"),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(hook.result.current.refreshError).toBe(
      "Could not refresh the queue.",
    );
  } finally {
    hook.unmount();
    vi.useRealTimers();
  }
});

it("stops queue reads during the idle pause and catches up on resume", async () => {
  vi.useFakeTimers();
  const hook = renderHook(() => useMessageQueue("pane", "session", true));
  try {
    await act(async () => {});
    await act(async () => setLocked(true));
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(fetchMessageQueue).toHaveBeenCalledTimes(1);
    expect(hook.result.current.page).toEqual(page);
    await act(async () => setLocked(false));
    expect(fetchMessageQueue).toHaveBeenCalledTimes(2);
  } finally {
    hook.unmount();
    setLocked(false);
    vi.useRealTimers();
  }
});

it("recovers an unacknowledged enqueue automatically with the same ID", async () => {
  vi.useFakeTimers();
  const hook = renderHook(() => useMessageQueue("pane", "session", true));
  try {
    await act(async () => {});
    vi.mocked(changeMessageQueue).mockRejectedValueOnce(
      new Error("lost response"),
    );
    await act(async () => {
      expect(await hook.result.current.mutate("add", "Keep this")).toBe(false);
    });
    const id = vi.mocked(changeMessageQueue).mock.calls[0]![1].id;
    vi.mocked(changeMessageQueue).mockResolvedValue(page);
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(changeMessageQueue).toHaveBeenCalledTimes(2);
    expect(vi.mocked(changeMessageQueue).mock.calls[1]![1].id).toBe(id);
    expect(hook.result.current.accepted).toEqual({ id, text: "Keep this" });
    expect(hook.result.current.error).toBe("");
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(changeMessageQueue).toHaveBeenCalledTimes(2);
  } finally {
    hook.unmount();
    vi.useRealTimers();
  }
});

it("does not automatically replay an old saved enqueue", async () => {
  localStorage.setItem(
    `collie.queue.pending:${JSON.stringify(["pane", "session"])}`,
    JSON.stringify({
      id: "old",
      scope: page.scope,
      text: "Keep",
      createdAt: Date.now() - 6 * 60_000,
    }),
  );
  const hook = renderHook(() => useMessageQueue("pane", "session", true));
  await waitFor(() => expect(hook.result.current.page).toEqual(page));
  expect(changeMessageQueue).not.toHaveBeenCalled();
  hook.unmount();
});

describe("live queue updates", () => {
  it("re-reads its own pane's queue as soon as the bridge names it", async () => {
    const stream = fakeLiveStream();
    stream.open();
    const hook = renderHook(() => useMessageQueue("pane", "session", true));
    await waitFor(() => expect(hook.result.current.page).toEqual(page));
    expect(fetchMessageQueue).toHaveBeenCalledTimes(1);
    act(() => stream.send({ topic: "queue", paneId: "other" }));
    expect(fetchMessageQueue).toHaveBeenCalledTimes(1);
    act(() => stream.send({ topic: "queue", paneId: "pane" }));
    await waitFor(() => expect(fetchMessageQueue).toHaveBeenCalledTimes(2));
    hook.unmount();
    stream.stop();
    resetLiveEvents();
  });
});

describe("the send-time choice reaches the bridge", () => {
  const key = `collie.queue.pending:${JSON.stringify(["pane", "session"])}`;

  it("keeps an unacknowledged add in localStorage, with its mode, until the bridge acks it", async () => {
    vi.mocked(changeMessageQueue).mockRejectedValueOnce(new Error("lost response"));
    const hook = renderHook(() => useMessageQueue("pane", "session", true));
    await waitFor(() => expect(hook.result.current.page).toEqual(page));
    await act(async () => {
      expect(await hook.result.current.add("Steer it", "steer")).toBeNull();
    });
    const saved = JSON.parse(localStorage.getItem(key)!);
    expect(saved).toMatchObject({ text: "Steer it", deliveryMode: "steer" });
    vi.mocked(changeMessageQueue).mockResolvedValue(page);
    await act(async () => {
      expect(await hook.result.current.add("Steer it", "steer")).toBe(saved.id);
    });
    expect(vi.mocked(changeMessageQueue).mock.calls[1]![1]).toMatchObject({ action: "add", id: saved.id, deliveryMode: "steer" });
    expect(localStorage.getItem(key)).toBeNull();
    hook.unmount();
  });

  it("asks for Read it now with an explicit confirm", async () => {
    vi.mocked(changeMessageQueue).mockResolvedValue(page);
    const hook = renderHook(() => useMessageQueue("pane", "session", true));
    await waitFor(() => expect(hook.result.current.page).toEqual(page));
    await act(async () => {
      expect(await hook.result.current.readNow("row-1")).toBe(true);
    });
    expect(vi.mocked(changeMessageQueue).mock.calls[0]![1]).toEqual({ scope: page.scope, action: "now", id: "row-1", confirm: true });
    hook.unmount();
  });

  it("lists what the bridge delivered, as it reported it", async () => {
    const delivered = [{ id: "d1", text: "read me", sentAt: 5, deliveryMode: "asap", native: "enqueued" }];
    vi.mocked(fetchMessageQueue).mockResolvedValue({ ...page, delivered } as typeof page);
    const hook = renderHook(() => useMessageQueue("pane", "session", true));
    await waitFor(() => expect(hook.result.current.delivered).toEqual(delivered));
    hook.unmount();
  });
});

describe("queueRowStatus says what each CLI does with the row", () => {
  it.each([
    ["claude", { state: "queued", deliveryMode: "afterTurn", waitingFor: "working" }, "Waiting for Claude to finish this turn."],
    ["codex", { state: "queued", deliveryMode: "afterTurn" }, "Queued. It goes when Codex finishes this turn."],
    ["claude", { state: "queued", deliveryMode: "asap", waitingFor: "dialog" }, "Waiting. Answer the dialog first."],
    ["claude", { state: "queued", deliveryMode: "asap", waitingFor: "turn-start" }, "Waiting for Claude to start on the previous message."],
    ["claude", { state: "sent", native: "enqueued" }, "In Claude's queue. Claude reads it after the step it's on."],
    ["claude", { state: "sent", native: "absorbed" }, "Read by Claude"],
    ["claude", { state: "sent", native: "recalled" }, "Taken back into the terminal's input box"],
    ["codex", { state: "sent", deliveryMode: "steer" }, "Sent into Codex's current turn"],
    ["codex", { state: "sent", deliveryMode: "afterTurn" }, "Sent"],
  ] as const)("%s %j", (agent, row, label) => {
    expect(queueRowStatus(agent, row).label).toBe(label);
  });

  it("offers Read it now only for a row Claude's own queue holds", () => {
    expect(queueRowStatus("claude", { state: "sent", native: "enqueued" }).actions).toEqual(["readNow"]);
    expect(queueRowStatus("codex", { state: "sent", native: "enqueued" }).actions).toEqual([]);
    expect(queueRowStatus("claude", { state: "sent", native: "absorbed" }).actions).toEqual([]);
  });

  it("a stranded row says why and offers only Send here or Remove", () => {
    const status = queueRowStatus("claude", { state: "queued", stranded: { reason: "The conversation in this pane changed. Send it here or remove it.", since: 1 } });
    expect(status).toEqual({ tone: "problem", label: "The conversation in this pane changed. Send it here or remove it.", actions: ["sendNow", "remove"] });
  });
});
