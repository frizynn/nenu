import { useEffect, useState, type RefObject } from "react";
import { watchViewport } from "@/hooks/use-app-viewport";
import { isTextField } from "@/hooks/use-auto-scroll";

// Detect whether the on-screen keyboard is open by watching the visual viewport height.
//
// The viewport meta uses `interactive-widget=resizes-content`, so where it is honoured (Chromium; not
// Safari on iOS, which shrinks only the visual viewport) BOTH the layout and visual viewport shrink
// together when the soft keyboard opens — which means the usual trick of comparing
// `window.innerHeight` to `visualViewport.height` reads ~0 and can't see the keyboard. What DOES
// still change is the absolute height: it drops by the keyboard's height. So we remember the tallest
// height seen while closed (the baseline) and call the keyboard "open" once the current height falls
// well below it.
//
// Why this exists: a textarea keeps DOM focus when Android collapses the keyboard (no `blur` fires),
// so focus alone can't tell us the keyboard closed — but the viewport resize always does.

// Two thresholds, so a height that hovers near one of them cannot flip the layout back and forth:
// it opens past 150px (more than the URL bar's ~60–100px, less than any keyboard's ~250px+) and
// closes only once the height is back within 100px. A suggestion bar folding or the URL bar showing
// while the keyboard is up stays inside the band.
const OPEN_DROP_PX = 150;
const CLOSE_DROP_PX = 100;

export interface KeyboardState {
  open: boolean;
  /** The tallest height seen while closed. */
  baseline: number;
  width: number;
}

/** One visual-viewport sample through the machine (pure, so the band is testable). */
export function keyboardStep(state: KeyboardState, sample: { height: number; width: number }): KeyboardState {
  // A width change is an orientation/layout change, not the keyboard: re-baseline, so a portrait
  // baseline doesn't read as "open" in landscape.
  if (sample.width !== state.width) return { open: false, baseline: sample.height, width: sample.width };
  const baseline = state.open ? state.baseline : Math.max(state.baseline, sample.height);
  const drop = baseline - sample.height;
  const open = state.open ? drop >= CLOSE_DROP_PX : drop > OPEN_DROP_PX;
  return { open, baseline, width: state.width };
}

export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let state: KeyboardState = { open: false, baseline: vv.height, width: vv.width };
    // Read on every moment the viewport may have changed, not only its own `resize`, which iOS can lose;
    // and only a focused field holds the keyboard up, whatever the last sample said.
    const update = () => {
      state = keyboardStep(state, { height: vv.height, width: vv.width });
      setOpen(state.open && isTextField(document.activeElement));
    };
    update();
    return watchViewport(vv, update);
  }, []);
  return open;
}

// Safari on iOS answers a tap that focuses a text field by scrolling the page until the field is centred
// in what the keyboard leaves, and that scroll carries every fixed layer, the whole app, up with the
// keyboard; useAppViewport can only bring it back once visualViewport reports, after the keyboard has
// risen. WebKit skips the scroll for a focus that carries `preventScroll` (WKContentView
// _zoomToRevealFocusedElement), and a focus made while the tap blurs the element it leaves replaces the
// tap's own. So a touch on the idle draft parks focus on `anchor` when nothing holds it, and the tap's
// blur focuses the draft without the scroll: the app is sized to the visual viewport, so the draft rises
// by layout once the keyboard is up. WebKit then drops the tap's press, so the caret is put where the
// finger landed. Apple's touch platforms only: Chromium resizes the layout for the keyboard instead.
const SCROLLS_TO_REVEAL = /iPhone|iPad|iPod|Mac/;

export function useFocusInPlace(inputRef: RefObject<HTMLTextAreaElement | null>, anchorRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const input = inputRef.current;
    const anchor = anchorRef.current;
    if (!input || !anchor || !SCROLLS_TO_REVEAL.test(navigator.platform)) return;
    // Where the finger landed, while that touch may still become the tap; a scroll cancels it.
    let touch: { x: number; y: number } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse" || input.disabled || document.activeElement === input) return;
      touch = { x: event.clientX, y: event.clientY };
      if (document.activeElement && document.activeElement !== document.body) return;
      anchor.tabIndex = -1;
      anchor.focus({ preventScroll: true });
    };
    const onPointerCancel = () => {
      touch = null;
      if (document.activeElement === anchor) anchor.blur();
    };
    const onBlur = (event: FocusEvent) => {
      if (event.target === anchor) anchor.removeAttribute("tabindex");
      if (event.relatedTarget !== input || !touch) return;
      const { x, y } = touch;
      touch = null;
      input.focus({ preventScroll: true });
      const caret = document.caretPositionFromPoint?.(x, y);
      const offset = caret?.offsetNode === input ? caret.offset : input.value.length;
      input.setSelectionRange(offset, offset);
    };
    input.addEventListener("pointerdown", onPointerDown);
    input.addEventListener("pointercancel", onPointerCancel);
    document.addEventListener("blur", onBlur, true);
    return () => {
      input.removeEventListener("pointerdown", onPointerDown);
      input.removeEventListener("pointercancel", onPointerCancel);
      document.removeEventListener("blur", onBlur, true);
      anchor.removeAttribute("tabindex");
    };
  }, [inputRef, anchorRef]);
}
