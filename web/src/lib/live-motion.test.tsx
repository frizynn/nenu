import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

import { Glow } from "@/components/work-activity-label";
import { StateMark } from "@/components/status-badge";
import { resetIdleLock, setLocked } from "./idle";

// jsdom has no IntersectionObserver: this one lets a test say what is on screen.
let seen: (target: Element, visible: boolean) => void = () => {};
let reduce = false;
const reducedListeners = new Set<() => void>();

beforeEach(() => {
  const observed = new Set<Element>();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(fire: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void) {
      seen = (target, visible) => { if (observed.has(target)) fire([{ target, isIntersecting: visible }]); };
    }
    observe(target: Element) { observed.add(target); }
    unobserve(target: Element) { observed.delete(target); }
    disconnect() { observed.clear(); }
  });
  reduce = false;
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() { return query.includes("reduce") && reduce; },
    media: query, onchange: null,
    addEventListener: (_: string, fn: () => void) => reducedListeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => reducedListeners.delete(fn),
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }) as unknown as MediaQueryList);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetIdleLock();
  reducedListeners.clear();
});

const hide = (hidden: boolean) => {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
};

it("moves a glow only while it is on screen, and draws its moving copy only then", () => {
  const { container } = render(<Glow>Working for 9s</Glow>);
  const glow = container.querySelector<HTMLElement>("[data-glow]")!;
  expect(glow.dataset.glow).toBe("still");
  expect(container.querySelector(".glow-window")).toBeNull();
  act(() => seen(glow, true));
  expect(glow.dataset.glow).toBe("running");
  expect(container.querySelector(".glow-window")).toHaveAttribute("aria-hidden", "true");
  act(() => seen(glow, false));
  expect(container.querySelector(".glow-window")).toBeNull();
});

it("stills every live motion on a hidden page, under the idle lock and under reduced motion", () => {
  const { container } = render(<><Glow>Thinking…</Glow><StateMark state="working" /></>);
  const glow = container.querySelector<HTMLElement>("[data-glow]")!;
  const mark = container.querySelector<SVGElement>('[data-node-state="working"]')!;
  act(() => { seen(glow, true); seen(mark, true); });
  expect(glow.dataset.glow).toBe("running");
  expect(mark).toHaveAttribute("data-moving");

  hide(true);
  expect(glow.dataset.glow).toBe("still");
  expect(mark).not.toHaveAttribute("data-moving");
  hide(false);
  expect(mark).toHaveAttribute("data-moving");

  act(() => setLocked(true));
  expect(glow.dataset.glow).toBe("still");
  expect(mark).not.toHaveAttribute("data-moving");
  act(() => setLocked(false));
  expect(glow.dataset.glow).toBe("running");

  reduce = true;
  act(() => { for (const fn of reducedListeners) fn(); });
  expect(glow.dataset.glow).toBe("still");
  expect(mark).not.toHaveAttribute("data-moving");
});

it("steps every moving one on one shared timer, and stops it when nothing moves", () => {
  vi.useFakeTimers();
  try {
    const { container, unmount } = render(<><Glow>Working for 9s</Glow><StateMark state="working" /></>);
    const glow = container.querySelector<HTMLElement>("[data-glow]")!;
    const mark = container.querySelector<SVGElement>('[data-node-state="working"]')!;
    act(() => { seen(glow, true); seen(mark, true); });
    expect(vi.getTimerCount()).toBe(1);
    act(() => { vi.advanceTimersByTime(2200); });
    expect(vi.getTimerCount()).toBe(1);
    expect(mark.style.transform).toMatch(/^rotate\(\d+deg\)$/);
    expect(container.querySelector<HTMLElement>(".glow-window")!.style.transform).toMatch(/^translateX\([\d.]+%\)$/);
    act(() => { seen(glow, false); seen(mark, false); });
    expect(vi.getTimerCount()).toBe(0);
    expect(mark.style.transform).toBe("");
    unmount();
  } finally {
    vi.useRealTimers();
  }
});

it("never moves a mark that does not say work in progress", () => {
  const { container } = render(<><StateMark state="needs" /><StateMark state="review" /><StateMark state="idle" /></>);
  expect(container.querySelector("[data-moving]")).toBeNull();
});
