import { act, fireEvent, render } from "@testing-library/react";
import { useState } from "react";

import { useAutoScroll } from "./use-auto-scroll";

// use-auto-scroll's stickiness needs a real DOM ref (scrollRef attached to an element) plus a
// ResizeObserver — jsdom has neither the layout nor the observer, so we mount a tiny harness, pin
// the element's scroll metrics by hand, and drive a mocked ResizeObserver's callback ourselves.

type Observed = { el: Element; cb: ResizeObserverCallback };

// Every constructed observer, so tests can fire container and/or content observations.
let observers: Observed[] = [];
class MockResizeObserver {
  private cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(el: Element) {
    observers.push({ el, cb: this.cb });
  }
  unobserve() {}
  disconnect() {
    observers = observers.filter((o) => o.cb !== this.cb);
  }
}

function setMetrics(
  el: HTMLElement,
  m: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(el, "scrollHeight", { value: m.scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: m.clientHeight, configurable: true });
  Object.defineProperty(el, "scrollTop", { value: m.scrollTop, configurable: true, writable: true });
}

function Harness({ dep = "constant" }: { dep?: unknown }) {
  const { scrollRef, onScroll } = useAutoScroll<HTMLDivElement>({ dep });
  return (
    <div ref={scrollRef} onScroll={onScroll} data-testid="scroll">
      <div data-testid="content">body</div>
    </div>
  );
}

function GrowingHarness() {
  const [dep, setDep] = useState("a");
  const { scrollRef, onScroll, scrollToBottom } = useAutoScroll<HTMLDivElement>({ dep });
  return (
    <div>
      <div ref={scrollRef} onScroll={onScroll} data-testid="scroll">
        <div data-testid="content">body</div>
      </div>
      <button type="button" onClick={() => setDep("b")} data-testid="grow-dep">
        grow dep
      </button>
      <button type="button" onClick={() => scrollToBottom()} data-testid="jump">
        jump
      </button>
    </div>
  );
}

function fireResize(el: Element) {
  for (const o of observers.filter((x) => x.el === el)) {
    o.cb([], {} as ResizeObserver);
  }
}

describe("useAutoScroll — resize re-pin", () => {
  // jsdom has no Element.scrollTo; the mount-time follow effect calls it, so keep a harmless default
  // on the prototype and shadow it per-test with a spy on the specific element.
  beforeAll(() => {
    if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
  });
  beforeEach(() => {
    observers = [];
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("re-pins to the bottom when the container resizes while following", () => {
    const { getByTestId } = render(<Harness />);
    const el = getByTestId("scroll");
    // Content taller than the viewport; the observer fired on mount is a no-op until we drive it.
    setMetrics(el, { scrollHeight: 500, clientHeight: 200, scrollTop: 300 });
    const scrollTo = vi.fn();
    el.scrollTo = scrollTo as unknown as HTMLElement["scrollTo"];

    // Following by default (autoScroll = true), so a resize snaps the tail back into view — pinned
    // to scrollHeight, NOT a recomputed at-bottom (the shrink already pushed the tail off-screen).
    act(() => fireResize(el));

    expect(scrollTo).toHaveBeenCalledWith({ top: 500, behavior: "auto" });
  });

  it("re-pins when CONTENT grows while following (pane open / AnsiOutput layout)", () => {
    // Opening a pane paints the scroll container at its final flex height first; the terminal
    // mirror's content then grows inside it. That does NOT resize the container — only the child —
    // so stickiness must observe content too, or the view stays stuck at the top of scrollback.
    const { getByTestId } = render(<Harness />);
    const el = getByTestId("scroll");
    const content = getByTestId("content");
    setMetrics(el, { scrollHeight: 500, clientHeight: 200, scrollTop: 0 });
    const scrollTo = vi.fn();
    el.scrollTo = scrollTo as unknown as HTMLElement["scrollTo"];

    act(() => fireResize(content));

    expect(scrollTo).toHaveBeenCalledWith({ top: 500, behavior: "auto" });
  });

  it("does NOT yank the view down on resize when the user has scrolled up", () => {
    const { getByTestId } = render(<Harness />);
    const el = getByTestId("scroll");
    // At the bottom, then scrolled up to 300px from it, past the 24px threshold → not following.
    setMetrics(el, { scrollHeight: 500, clientHeight: 200, scrollTop: 300 });
    fireEvent.scroll(el);
    el.scrollTop = 0;
    fireEvent.scroll(el); // onScroll captures the scrolled-up intent (autoScroll = false)

    const scrollTo = vi.fn();
    el.scrollTo = scrollTo as unknown as HTMLElement["scrollTo"];
    act(() => fireResize(el));

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("pins to the bottom on mount / when dep changes while following", () => {
    const { getByTestId } = render(<GrowingHarness />);
    const el = getByTestId("scroll");
    setMetrics(el, { scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    const scrollTo = vi.fn();
    el.scrollTo = scrollTo as unknown as HTMLElement["scrollTo"];

    act(() => fireEvent.click(getByTestId("grow-dep")));

    expect(scrollTo).toHaveBeenCalledWith({ top: 800, behavior: "auto" });
  });

  // A pin queues a scroll event that the browser dispatches on the next frame; output that grows
  // before then makes that event report a gap the user never scrolled.
  it("keeps following when content grows between a pin and its scroll event", () => {
    const onAtBottomChange = vi.fn();
    function Following() {
      const [dep, setDep] = useState("a");
      const { scrollRef, onScroll, isAtBottom } = useAutoScroll<HTMLDivElement>({ dep, onAtBottomChange });
      return (
        <div>
          <div ref={scrollRef} onScroll={onScroll} data-testid="scroll" data-at-bottom={String(isAtBottom)} />
          <button type="button" onClick={() => setDep("b")} data-testid="grow-dep">grow dep</button>
        </div>
      );
    }
    const { getByTestId } = render(<Following />);
    const el = getByTestId("scroll");
    const box = { height: 500, top: 0 };
    Object.defineProperties(el, {
      scrollHeight: { configurable: true, get: () => box.height },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, get: () => box.top, set: (v: number) => { box.top = Math.min(v, box.height - 200); } },
    });
    el.scrollTo = ((o: ScrollToOptions) => { el.scrollTop = o.top ?? 0; }) as HTMLElement["scrollTo"];
    act(() => { el.scrollTo({ top: 500 }); fireEvent.scroll(el); });

    box.height = 560;
    act(() => fireEvent.click(getByTestId("grow-dep")));
    box.height = 600;
    fireEvent.scroll(el);

    expect(el.dataset.atBottom).toBe("true");
    expect(onAtBottomChange).not.toHaveBeenCalledWith(false);
    expect(box.top).toBe(400);
  });

  // The terminal mirror sits over the same composer (see live-conversation.test.tsx, T09): replacing
  // the draft empties the box for one layout, the list grows and clamps, then shrinks back unseen.
  it("keeps following when an edit beside the list moves it for one layout", () => {
    const onAtBottomChange = vi.fn();
    function Following() {
      const { scrollRef, onScroll, isAtBottom } = useAutoScroll<HTMLDivElement>({ onAtBottomChange });
      return (
        <div>
          <div ref={scrollRef} onScroll={onScroll} data-testid="scroll" data-at-bottom={String(isAtBottom)} />
          <textarea aria-label="Draft" />
        </div>
      );
    }
    const { getByTestId, getByLabelText } = render(<Following />);
    const el = getByTestId("scroll");
    const box = { height: 3145, client: 439, top: 0 };
    Object.defineProperties(el, {
      scrollHeight: { configurable: true, get: () => box.height },
      clientHeight: { configurable: true, get: () => box.client },
      scrollTop: { configurable: true, get: () => box.top, set: (v: number) => { box.top = Math.max(0, Math.min(v, box.height - box.client)); } },
    });
    el.scrollTo = ((o: ScrollToOptions) => { el.scrollTop = o.top ?? 0; }) as HTMLElement["scrollTo"];
    act(() => { el.scrollTo({ top: box.height }); fireEvent.scroll(el); });

    fireEvent.input(getByLabelText("Draft"), { target: { value: "Línea 1" } });
    box.client = 587;
    el.scrollTop = box.top;
    box.client = 439;
    fireEvent.scroll(el);

    expect(el.dataset.atBottom).toBe("true");
    expect(onAtBottomChange).not.toHaveBeenCalledWith(false);
    expect(box.top).toBe(2706);
  });

  // The phone keyboard going down: the list grows and the browser clamps scrollTop, then the composer's
  // rows come back before that clamp's scroll event is dispatched (see live-conversation.test.tsx).
  it("keeps following when the list grows and shrinks back before its scroll event", () => {
    const onAtBottomChange = vi.fn();
    function Following() {
      const { scrollRef, onScroll, isAtBottom } = useAutoScroll<HTMLDivElement>({ onAtBottomChange });
      return <div ref={scrollRef} onScroll={onScroll} data-testid="scroll" data-at-bottom={String(isAtBottom)} />;
    }
    const { getByTestId } = render(<Following />);
    const el = getByTestId("scroll");
    const box = { height: 1851, client: 453, top: 0 };
    Object.defineProperties(el, {
      scrollHeight: { configurable: true, get: () => box.height },
      clientHeight: { configurable: true, get: () => box.client },
      scrollTop: { configurable: true, get: () => box.top, set: (v: number) => { box.top = Math.max(0, Math.min(v, box.height - box.client)); } },
    });
    el.scrollTo = ((o: ScrollToOptions) => { el.scrollTop = o.top ?? 0; }) as HTMLElement["scrollTo"];
    act(() => { el.scrollTo({ top: box.height }); fireEvent.scroll(el); });

    box.client = 789;
    el.scrollTop = box.top;
    box.client = 757;
    fireEvent.scroll(el);

    expect(el.dataset.atBottom).toBe("true");
    expect(onAtBottomChange).not.toHaveBeenCalledWith(false);
    expect(box.top).toBe(1094);

    // A bounce past the bottom, then the reader's flick up from it.
    box.top = 1150;
    fireEvent.scroll(el);
    box.top = 900;
    fireEvent.scroll(el);
    expect(el.dataset.atBottom).toBe("false");
    expect(box.top).toBe(900);
  });

  // The mirror's Find and the History search are one-line inputs: a keystroke there never resizes
  // anything, and the jump to the match it starts is a move up the list has to make.
  it("lets a jump to a search match leave the tail right after a keystroke in a search box", () => {
    const onAtBottomChange = vi.fn();
    function Searching() {
      const { scrollRef, onScroll, isAtBottom } = useAutoScroll<HTMLDivElement>({ onAtBottomChange });
      return (
        <div>
          <input aria-label="Find" />
          <div ref={scrollRef} onScroll={onScroll} data-testid="scroll" data-at-bottom={String(isAtBottom)} />
        </div>
      );
    }
    const { getByTestId, getByLabelText } = render(<Searching />);
    const el = getByTestId("scroll");
    const box = { height: 3145, client: 439, top: 0 };
    Object.defineProperties(el, {
      scrollHeight: { configurable: true, get: () => box.height },
      clientHeight: { configurable: true, get: () => box.client },
      scrollTop: { configurable: true, get: () => box.top, set: (v: number) => { box.top = Math.max(0, Math.min(v, box.height - box.client)); } },
    });
    el.scrollTo = ((o: ScrollToOptions) => { el.scrollTop = o.top ?? 0; }) as HTMLElement["scrollTo"];
    act(() => { el.scrollTo({ top: box.height }); fireEvent.scroll(el); });

    fireEvent.input(getByLabelText("Find"), { target: { value: "needle" } });
    el.scrollTop = 0;
    act(() => { fireEvent.scroll(el); });

    expect(box.top).toBe(0);
    expect(el.dataset.atBottom).toBe("false");
    expect(onAtBottomChange).toHaveBeenCalledWith(false);
  });

  it("no-ops without a ResizeObserver (jsdom / older browsers)", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    // Mounting must not throw when the observer is absent — the effect bails on the typeof guard.
    expect(() => render(<Harness />)).not.toThrow();
  });
});
