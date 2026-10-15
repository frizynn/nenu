import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import {
  __resetReloadGuard,
  holdReload,
  isReloadHeld,
  isWorkHeld,
  releaseReload,
  subscribeReloadHeld,
  useHoldReload,
  waiveViewHolds,
} from "./reload-guard";

afterEach(() => {
  __resetReloadGuard();
  vi.useRealTimers();
});

describe("hold registry", () => {
  it("is held while any key is held; hold/release are idempotent per key", () => {
    expect(isReloadHeld()).toBe(false);
    holdReload("a");
    holdReload("a"); // idempotent — still one holder
    expect(isReloadHeld()).toBe(true);

    holdReload("b");
    releaseReload("a");
    expect(isReloadHeld()).toBe(true); // b still holds

    releaseReload("b");
    expect(isReloadHeld()).toBe(false);
    releaseReload("b"); // releasing an unheld key is a harmless no-op
    expect(isReloadHeld()).toBe(false);
  });
});

describe("useHoldReload", () => {
  it("holds while active, releases when inactive and on unmount", () => {
    const { rerender, unmount } = renderHook(({ active }) => useHoldReload("x", active), {
      initialProps: { active: false },
    });
    expect(isReloadHeld()).toBe(false);

    act(() => rerender({ active: true }));
    expect(isReloadHeld()).toBe(true);

    act(() => rerender({ active: false }));
    expect(isReloadHeld()).toBe(false);

    act(() => rerender({ active: true }));
    expect(isReloadHeld()).toBe(true);
    act(() => unmount()); // unmount must release even while still active
    expect(isReloadHeld()).toBe(false);
  });
});

describe("views and unsent work", () => {
  it("an open view stops holding for a moment after the app returns; unsent work never does", () => {
    vi.useFakeTimers();
    holdReload("open-agent-session", "view");
    expect(isReloadHeld()).toBe(true);
    expect(isWorkHeld()).toBe(false);
    waiveViewHolds();
    expect(isReloadHeld()).toBe(false);
    holdReload("composer:w1:p1");
    expect(isReloadHeld()).toBe(true);
    expect(isWorkHeld()).toBe(true);
    releaseReload("composer:w1:p1");
    expect(isReloadHeld()).toBe(false);
    vi.advanceTimersByTime(15_000);
    expect(isReloadHeld()).toBe(true); // the grace is over: the reader may be reading now
  });

  it("tells waiting reloads when views stop holding", () => {
    const listener = vi.fn();
    const stop = subscribeReloadHeld(listener);
    waiveViewHolds();
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
  });

  it("useHoldReload takes the hold's kind", () => {
    renderHook(() => useHoldReload("preview", true, "view"));
    waiveViewHolds();
    expect(isReloadHeld()).toBe(false);
  });
});
