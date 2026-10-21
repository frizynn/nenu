import { useEffect } from "react";
import { isTextField } from "@/hooks/use-auto-scroll";

// iOS can say late, or never, that the keyboard went down: a `resize` lost on the way out, one that lands
// mid-zoom, a return from the background, a turn of the phone. So any of those moments re-reads the
// viewport every frame for this long, past the keyboard's own animation.
const SETTLE_MS = 1000;

/** Whether the focused element can be holding the on-screen keyboard up: a text field, or a frame
 * (a preview's form) whose own field we cannot see into. A frame stays focused after its keyboard goes
 * down, so there the viewport's own reading is the only guard left, as it was for every field before. */
export function mayHoldKeyboard(element: Element | null): boolean {
  return isTextField(element) || element instanceof HTMLIFrameElement;
}

/** Calls `onChange` once a frame, for SETTLE_MS after every moment the visible viewport may have
 * changed, including those iOS does not report as a viewport event: a field gaining or losing focus,
 * the window resizing, the page coming back into view. Returns the unsubscribe. */
export function watchViewport(viewport: VisualViewport, onChange: () => void): () => void {
  let frame = 0;
  let settleUntil = 0;
  const tick = () => {
    frame = 0;
    onChange();
    if (performance.now() < settleUntil) frame = requestAnimationFrame(tick);
  };
  const settle = () => {
    settleUntil = performance.now() + SETTLE_MS;
    if (!frame) frame = requestAnimationFrame(tick);
  };
  const onVisibility = () => { if (document.visibilityState === "visible") settle(); };
  const sources: Array<[EventTarget, string, () => void]> = [
    [viewport, "resize", settle], [viewport, "scroll", settle],
    [document, "focusin", settle], [document, "focusout", settle], [document, "visibilitychange", onVisibility],
    [window, "resize", settle], [window, "pageshow", settle],
  ];
  for (const [target, type, listener] of sources) target.addEventListener(type, listener);
  return () => {
    cancelAnimationFrame(frame);
    for (const [target, type, listener] of sources) target.removeEventListener(type, listener);
  };
}

/** Safari leaves the layout viewport behind the keyboard. Size the app to its visible viewport,
 * without React renders during keyboard animation or resizing the layout when the user pinch-zooms.
 * Only a focused field can hold the keyboard up, so without one the app keeps the full height,
 * whatever the viewport last said; it still follows the viewport's offset, which iOS 26 can leave
 * above 0 once the keyboard is down (WebKit bug 297779). */
export function useAppViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const style = document.documentElement.style;
    const write = (name: string, value: string | null) => {
      if (style.getPropertyValue(name) === (value ?? "")) return;
      if (value === null) style.removeProperty(name);
      else style.setProperty(name, value);
    };
    const update = () => {
      const typing = mayHoldKeyboard(document.activeElement);
      if (viewport.scale === 1) {
        write("--app-viewport-height", typing ? `${viewport.height}px` : null);
        write("--app-viewport-top", `${viewport.offsetTop}px`);
      } else if (!typing) {
        write("--app-viewport-height", null);
      }
    };
    update();
    const unwatch = watchViewport(viewport, update);
    return () => {
      unwatch();
      style.removeProperty("--app-viewport-height");
      style.removeProperty("--app-viewport-top");
    };
  }, []);
}
