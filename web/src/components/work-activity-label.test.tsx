import { Profiler } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetIdleLock, setLocked } from "@/lib/idle";
import { WorkActivityLabel } from "./work-activity-label";

let hidden = false;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-08T12:00:05Z"));
  hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  resetIdleLock();
});
afterEach(() => { cleanup(); resetIdleLock(); vi.restoreAllMocks(); vi.useRealTimers(); });
const startedAt = "2026-09-08T12:00:00Z";
function visibility(value: boolean) {
  act(() => { hidden = value; document.dispatchEvent(new Event("visibilitychange")); });
}

describe("WorkActivityLabel", () => {
  it("updates only the elapsed text, once a minute, without causing React commits for the surrounding transcript", () => {
    const committed = vi.fn();
    render(<Profiler id="transcript" onRender={committed}><WorkActivityLabel startedAt={startedAt} /></Profiler>);
    expect(screen.getByText("Working for <1m")).toBeVisible();
    const initialCommits = committed.mock.calls.length;
    act(() => { vi.advanceTimersByTime(54_000); });
    expect(screen.getByText("Working for <1m")).toBeVisible();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText("Working for 1m")).toBeVisible();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText("Working for 2m")).toBeVisible();
    expect(committed).toHaveBeenCalledTimes(initialCommits);
  });

  it("pauses while hidden and catches up on visibility without creating duplicate timers", () => {
    render(<WorkActivityLabel startedAt={startedAt} />);
    expect(vi.getTimerCount()).toBe(1);
    visibility(true);
    expect(vi.getTimerCount()).toBe(0);
    act(() => { vi.advanceTimersByTime(120_000); });
    expect(screen.getByText("Working for <1m")).toBeInTheDocument();
    visibility(false);
    expect(screen.getByText("Working for 2m")).toBeInTheDocument();
    visibility(false);
    expect(vi.getTimerCount()).toBe(1);
    act(() => { vi.advanceTimersByTime(55_000); });
    expect(screen.getByText("Working for 3m")).toBeInTheDocument();
  });

  it("does not start a timer in a hidden tab", () => {
    hidden = true;
    render(<WorkActivityLabel startedAt={startedAt} />);
    expect(vi.getTimerCount()).toBe(0);
    visibility(false);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("pauses under the idle lock and catches up when the user unlocks", () => {
    render(<WorkActivityLabel startedAt={startedAt} />);
    act(() => setLocked(true));
    expect(vi.getTimerCount()).toBe(0);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText("Working for <1m")).toBeInTheDocument();
    act(() => setLocked(false));
    expect(screen.getByText("Working for 1m")).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("cleans up intervals and visibility listeners on unmount", () => {
    const { unmount } = render(<WorkActivityLabel startedAt={startedAt} />);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    visibility(false);
    expect(vi.getTimerCount()).toBe(0);
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(screen.queryByText(/^Working/)).not.toBeInTheDocument();
  });

  it.each([undefined, "", "not-a-date"])("avoids a fake duration and timer for missing/invalid start %s", (start) => {
    render(<WorkActivityLabel startedAt={start} />);
    expect(screen.getByText("Working…")).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("replaces the old interval when the next activity starts", () => {
    const { rerender } = render(<WorkActivityLabel startedAt={startedAt} />);
    rerender(<WorkActivityLabel startedAt="2026-09-08T11:58:10Z" />);
    expect(screen.getByText("Working for 1m")).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(1);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByText("Working for 2m")).toBeInTheDocument();
  });

  // The words glow while the agent works (ADR 0117): a light passes across them, nothing else moves.
  // jsdom has no IntersectionObserver, so the glow stays still and its words are on the page once.
  it("glows its words, with no spinner, no dot and no second copy while still", () => {
    const { container } = render(<WorkActivityLabel startedAt={startedAt} />);
    expect(container.querySelector("[data-glow]")).toHaveAttribute("data-glow", "still");
    expect(container.querySelector("[data-live-glyph]")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("[class*='animate-']")).toBeNull();
    expect(screen.getAllByText(/^Working for/)).toHaveLength(1);
  });
});
