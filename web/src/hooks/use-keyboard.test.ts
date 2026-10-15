import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { keyboardStep, useFocusInPlace, type KeyboardState } from "./use-keyboard";

/** Feed visual-viewport samples through the machine, as the resize listener does. */
function run(samples: Array<{ height: number; width?: number }>, start: KeyboardState = { open: false, baseline: 800, width: 390 }) {
  const states: KeyboardState[] = [];
  let state = start;
  for (const sample of samples) {
    state = keyboardStep(state, { height: sample.height, width: sample.width ?? state.width });
    states.push(state);
  }
  return states;
}

describe("keyboardStep", () => {
  it("is closed when the height is unchanged", () => {
    expect(run([{ height: 800 }]).at(-1)!.open).toBe(false);
  });

  it("ignores small drops like the URL bar collapsing", () => {
    expect(run([{ height: 720 }]).at(-1)!.open).toBe(false); // -80px
  });

  it("opens once the height drops past 150px", () => {
    expect(run([{ height: 660 }]).map((s) => s.open)).toEqual([false]); // -140px: not yet
    expect(run([{ height: 480 }]).map((s) => s.open)).toEqual([true]); // -320px
  });

  it("stays open between 100 and 150px, so a suggestion bar or a URL bar does not flicker it", () => {
    // -336 (keyboard), -290 (suggestion bar folds), -120 (half way down): still the keyboard.
    expect(run([{ height: 464 }, { height: 510 }, { height: 680 }]).map((s) => s.open)).toEqual([true, true, true]);
  });

  it("closes only when the height comes back within 100px of the baseline", () => {
    expect(run([{ height: 464 }, { height: 705 }, { height: 800 }]).map((s) => s.open)).toEqual([true, false, false]);
  });

  it("does not open from the dead band when it was closed", () => {
    expect(run([{ height: 680 }, { height: 660 }]).map((s) => s.open)).toEqual([false, false]);
  });

  it("raises the baseline while closed, never while open", () => {
    const [closed, open, stillOpen] = run([{ height: 844 }, { height: 508 }, { height: 600 }]);
    expect(closed).toMatchObject({ open: false, baseline: 844 });
    expect(open).toMatchObject({ open: true, baseline: 844 });
    expect(stillOpen).toMatchObject({ open: true, baseline: 844 });
  });

  it("re-baselines on a width change, which is a rotation and not the keyboard", () => {
    const states = run([{ height: 464 }, { height: 390, width: 844 }, { height: 200, width: 844 }]);
    expect(states[1]).toEqual({ open: false, baseline: 390, width: 844 });
    expect(states[2]!.open).toBe(true);
  });
});

describe("useFocusInPlace", () => {
  afterEach(() => {
    delete (navigator as { platform?: string }).platform;
    delete (document as { caretPositionFromPoint?: unknown }).caretPositionFromPoint;
    document.body.replaceChildren();
  });

  /** The draft inside its composer, on `platform`, with the hook mounted. */
  function mount(platform: string) {
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
    const anchor = document.createElement("div");
    const input = document.createElement("textarea");
    input.value = "a draft";
    const elsewhere = document.createElement("button");
    anchor.append(input);
    document.body.append(anchor, elsewhere);
    const focus = vi.spyOn(input, "focus");
    const view = renderHook(() => useFocusInPlace({ current: input }, { current: anchor }));
    return { anchor, input, elsewhere, focus, view };
  }
  const press = (el: Element, type: "pointerdown" | "pointercancel", pointerType = "touch") =>
    el.dispatchEvent(Object.assign(new Event(type, { bubbles: true }), { pointerType, clientX: 12, clientY: 8 }));
  /** The focus a tap gives the field: the browser's own, not a script's focus() call. */
  const tapFocus = (input: HTMLTextAreaElement) => HTMLElement.prototype.focus.call(input);
  const scrollFree = (focus: { mock: { calls: unknown[][] } }) => focus.mock.calls.filter(([options]) => (options as FocusOptions | undefined)?.preventScroll === true).length;

  it("on iOS, a touch on the idle draft parks focus beside it, and the tap's focus arrives without scrolling the page", () => {
    const { anchor, input, focus } = mount("iPhone");
    press(input, "pointerdown");
    expect(document.activeElement).toBe(anchor);
    expect(anchor.getAttribute("tabindex")).toBe("-1");
    tapFocus(input);
    expect(document.activeElement).toBe(input);
    expect(scrollFree(focus)).toBe(1);
    expect(anchor.hasAttribute("tabindex")).toBe(false);
    // The tap's own press is dropped once its focus is replaced: the caret goes where the finger landed.
    expect(input.selectionStart).toBe(input.value.length);
  });

  it("puts the caret under the finger when the browser can say where that is", () => {
    const { input } = mount("iPhone");
    (document as { caretPositionFromPoint?: unknown }).caretPositionFromPoint = () => ({ offsetNode: input, offset: 2 });
    press(input, "pointerdown");
    tapFocus(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 2]);
  });

  it("leaves a focused control where it is and catches the tap's blur of it instead", () => {
    const { input, elsewhere, focus } = mount("iPhone");
    elsewhere.focus();
    press(input, "pointerdown");
    expect(document.activeElement).toBe(elsewhere);
    tapFocus(input);
    expect(scrollFree(focus)).toBe(1);
  });

  it("does nothing for a mouse, a touch that became a scroll, a draft already focused, or a browser that resizes for the keyboard", () => {
    const mouse = mount("MacIntel");
    press(mouse.input, "pointerdown", "mouse");
    tapFocus(mouse.input);
    expect(scrollFree(mouse.focus)).toBe(0);
    mouse.view.unmount();
    document.body.replaceChildren();

    const scroll = mount("iPhone");
    press(scroll.input, "pointerdown");
    press(scroll.input, "pointercancel");
    expect(document.activeElement).toBe(document.body);
    expect(scroll.anchor.hasAttribute("tabindex")).toBe(false);
    tapFocus(scroll.input);
    expect(scrollFree(scroll.focus)).toBe(0);
    scroll.input.blur();
    scroll.view.unmount();
    document.body.replaceChildren();

    const focused = mount("iPhone");
    tapFocus(focused.input);
    press(focused.input, "pointerdown");
    expect(document.activeElement).toBe(focused.input);
    expect(scrollFree(focused.focus)).toBe(0);
    focused.input.blur();
    focused.view.unmount();
    document.body.replaceChildren();

    const android = mount("Linux armv8l");
    press(android.input, "pointerdown");
    expect(document.activeElement).toBe(document.body);
    tapFocus(android.input);
    expect(scrollFree(android.focus)).toBe(0);
  });

  it("lets go of the page on unmount", () => {
    const { input, anchor, focus, view } = mount("iPhone");
    view.unmount();
    press(input, "pointerdown");
    expect(document.activeElement).not.toBe(anchor);
    tapFocus(input);
    expect(scrollFree(focus)).toBe(0);
  });
});
