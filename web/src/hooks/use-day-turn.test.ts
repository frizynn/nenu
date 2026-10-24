import { act, renderHook } from "@testing-library/react";

import { untilMidnight, useDayTurn } from "./use-day-turn";

describe("useDayTurn", () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date(2026, 9, 23, 23, 0) }));
  afterEach(() => vi.useRealTimers());

  it("counts to the next local midnight", () => {
    expect(untilMidnight()).toBe(60 * 60 * 1000);
  });

  it("redraws once each day turns while active, and never when not", () => {
    let renders = 0;
    const { rerender } = renderHook(({ active }) => { renders++; useDayTurn(active); }, { initialProps: { active: true } });
    act(() => vi.advanceTimersByTime(60 * 60 * 1000 - 1));
    expect(renders).toBe(1);
    act(() => vi.advanceTimersByTime(2_000));
    expect(renders).toBe(2);
    act(() => vi.advanceTimersByTime(24 * 60 * 60 * 1000));
    expect(renders).toBe(3);
    // Back from a sleep that froze the timer: the new day is read on return.
    vi.setSystemTime(Date.now() + 26 * 60 * 60 * 1000);
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(renders).toBe(4);
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(renders).toBe(4);
    rerender({ active: false });
    const before = renders;
    act(() => vi.advanceTimersByTime(48 * 60 * 60 * 1000));
    expect(renders).toBe(before);
  });
});
