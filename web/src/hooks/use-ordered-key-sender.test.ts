import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useOrderedKeySender } from "./use-ordered-key-sender";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("useOrderedKeySender", () => {
  it("keeps one call in flight and batches everything typed behind it", async () => {
    const first = deferred<boolean>();
    const send = vi
      .fn<(keys: string[]) => Promise<boolean>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(true);
    const { result } = renderHook(() => useOrderedKeySender(send, vi.fn()));

    act(() => result.current.enqueue(["a"]));
    await waitFor(() => expect(send).toHaveBeenCalledWith(["a"]));

    act(() => {
      result.current.enqueue(["b"]);
      result.current.enqueue(["c", "d"]);
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.current.busy).toBe(true);

    first.resolve(true);
    await waitFor(() => expect(send).toHaveBeenNthCalledWith(2, ["b", "c", "d"]));
    await waitFor(() => expect(result.current.busy).toBe(false));
  });

  it("splits a large committed string into bounded ordered requests", async () => {
    const send = vi.fn<(keys: string[]) => Promise<boolean>>().mockResolvedValue(true);
    const { result } = renderHook(() => useOrderedKeySender(send, vi.fn()));
    const keys = Array.from({ length: 70 }, (_, i) => String(i % 10));

    act(() => result.current.enqueue(keys));

    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[0][0]).toEqual(keys.slice(0, 64));
    expect(send.mock.calls[1][0]).toEqual(keys.slice(64));
    await waitFor(() => expect(result.current.busy).toBe(false));
  });

  it("stops and discards queued keys after a failed batch", async () => {
    const first = deferred<boolean>();
    const send = vi.fn<(keys: string[]) => Promise<boolean>>().mockReturnValue(first.promise);
    const onFailure = vi.fn();
    const { result } = renderHook(() => useOrderedKeySender(send, onFailure));

    act(() => result.current.enqueue(["a"]));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    act(() => result.current.enqueue(["b"]));

    first.resolve(false);
    await waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.busy).toBe(false));
  });

  it("reset drops queued keys without cancelling the batch already on the wire", async () => {
    const first = deferred<boolean>();
    const send = vi
      .fn<(keys: string[]) => Promise<boolean>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(true);
    const { result } = renderHook(() => useOrderedKeySender(send, vi.fn()));

    act(() => result.current.enqueue(["old"]));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.enqueue(["discard"]);
      result.current.reset();
    });

    first.resolve(true);
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("sends a paste as its own write in line: keys before it first, keys after it wait for its answer", async () => {
    const paste = deferred<boolean>();
    const order: string[] = [];
    const send = vi.fn(async (keys: string[]) => {
      order.push(keys.join(""));
      return true;
    });
    const { result } = renderHook(() => useOrderedKeySender(send, vi.fn()));

    act(() => result.current.enqueue(["a", "b", async () => {
      order.push("paste");
      return paste.promise;
    }, "c"]));
    await waitFor(() => expect(order).toEqual(["ab", "paste"]));
    act(() => result.current.enqueue(["d"]));
    expect(send).toHaveBeenCalledTimes(1);

    paste.resolve(true);
    await waitFor(() => expect(order).toEqual(["ab", "paste", "cd"]));
    await waitFor(() => expect(result.current.busy).toBe(false));
  });

  it("tells a write still waiting on its upload that a reset moved on, so the next pane's keys go at once", async () => {
    const upload = deferred<void>();
    const seen: boolean[] = [];
    const send = vi.fn<(keys: string[]) => Promise<boolean>>().mockResolvedValue(true);
    const { result } = renderHook(() => useOrderedKeySender(send, vi.fn()));

    act(() => result.current.enqueue([async (current, moved) => {
      await Promise.race([upload.promise, moved]);
      seen.push(current());
      return true;
    }]));
    act(() => result.current.reset());
    act(() => result.current.enqueue(["n"]));
    await waitFor(() => expect(send).toHaveBeenCalledWith(["n"]));
    expect(seen).toEqual([false]);
  });

  it("keeps the line held by a write on its way across a reset: the bridge would refuse a second one", async () => {
    const paste = deferred<boolean>();
    const send = vi.fn<(keys: string[]) => Promise<boolean>>().mockResolvedValue(true);
    const { result } = renderHook(() => useOrderedKeySender(send, vi.fn()));

    act(() => result.current.enqueue([() => paste.promise]));
    act(() => result.current.reset());
    act(() => result.current.enqueue(["n"]));
    expect(send).not.toHaveBeenCalled();
    paste.resolve(true);
    await waitFor(() => expect(send).toHaveBeenCalledWith(["n"]));
  });

  it("stops the line on a failed write", async () => {
    const send = vi.fn<(keys: string[]) => Promise<boolean>>().mockResolvedValue(true);
    const onFailure = vi.fn();
    const { result } = renderHook(() => useOrderedKeySender(send, onFailure));

    act(() => result.current.enqueue([async () => false, "x"]));
    await waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
    expect(send).not.toHaveBeenCalled();
  });
});
