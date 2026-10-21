import { useEffect } from "react";
import { isTextField } from "@/hooks/use-auto-scroll";

// iOS can say late, or never, that the keyboard went down: a `resize` lost on the way out, one that lands
// mid-zoom, a return from the background, a turn of the phone. So any of those moments re-reads the
// viewport every frame for this long, past the keyboard's own animation.
const SETTLE_MS = 1000;

/** Calls `onChange` at every moment the visible viewport may have changed, including those iOS does
 * not report as a viewport event: a field gaining or losing focus, the window resizing, the page
 * coming back into view. Returns the unsubscribe. */
export function watchViewport(viewport: VisualViewport, onChange: () => void): () => void {
  const onVisibility = () => { if (document.visibilityState === "visible") onChange(); };
  const sources: Array<[EventTarget, string, () => void]> = [
    [viewport, "resize", onChange], [viewport, "scroll", onChange],
    [document, "focusin", onChange], [document, "focusout", onChange], [document, "visibilitychange", onVisibility],
    [window, "resize", onChange], [window, "pageshow", onChange],
  ];
  for (const [target, type, listener] of sources) target.addEventListener(type, listener);
  return () => { for (const [target, type, listener] of sources) target.removeEventListener(type, listener); };
}

/** Safari leaves the layout viewport behind the keyboard. Size the app to its visible viewport,
 * without React renders during keyboard animation or resizing the layout when the user pinch-zooms.
 * Only a focused text field can hold the keyboard up, so without one the app keeps the full height,
 * whatever the viewport last said; it still follows the viewport's offset, which iOS 26 can leave
 * above 0 once the keyboard is down (WebKit bug 297779). */
export function useAppViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const style = document.documentElement.style;
    let frame = 0;
    let settleUntil = 0;
    const write = (name: string, value: string | null) => {
      if (style.getPropertyValue(name) === (value ?? "")) return;
      if (value === null) style.removeProperty(name);
      else style.setProperty(name, value);
    };
    const update = () => {
      frame = 0;
      const typing = isTextField(document.activeElement);
      if (viewport.scale === 1) {
        write("--app-viewport-height", typing ? `${viewport.height}px` : null);
        write("--app-viewport-top", `${viewport.offsetTop}px`);
      } else if (!typing) {
        write("--app-viewport-height", null);
        write("--app-viewport-top", null);
      }
      if (performance.now() < settleUntil) frame = requestAnimationFrame(update);
    };
    update();
    const unwatch = watchViewport(viewport, () => {
      settleUntil = performance.now() + SETTLE_MS;
      if (!frame) frame = requestAnimationFrame(update);
    });
    return () => {
      cancelAnimationFrame(frame);
      unwatch();
      style.removeProperty("--app-viewport-height");
      style.removeProperty("--app-viewport-top");
    };
  }, []);
}
