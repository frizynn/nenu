import { useCallback, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { ImageIcon } from "@/components/ui/icon";

import { draftChips } from "@/lib/message-images";

// The pictures' chips in the draft, drawn under the textarea. The textarea stays the one thing that
// holds and edits the text (the native keyboard, dictation, selection all work as before); a chip is
// characters in it (lib/message-images.ts imageChip), and this layer, laid out with the textarea's own
// metrics, paints a pill behind each one and an image icon in its blank leading cells. It holds no
// text of its own that anyone sees: everything but the pills and icons is transparent.

const METRICS = [
  "boxSizing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "wordSpacing", "tabSize", "textIndent",
  "whiteSpace", "overflowWrap", "wordBreak",
] as const;

export function DraftChipLayer({ text, field }: { text: string; field: RefObject<HTMLTextAreaElement | null> }) {
  const layer = useRef<HTMLDivElement>(null);
  const chips = draftChips(text);

  // Follow the textarea's metrics, size and scroll: on every change of the text (cheap: one style
  // read), and whenever it resizes or scrolls without one.
  const follow = useCallback(() => {
    const el = field.current;
    const back = layer.current;
    if (!el || !back) return;
    const style = getComputedStyle(el);
    for (const key of METRICS) back.style[key] = style[key];
    back.style.borderStyle = "solid";
    back.style.borderColor = "transparent";
    // The textarea's own width less its scrollbar, so a line wraps where the textarea wraps it.
    back.style.width = `${el.clientWidth + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)}px`;
    back.style.height = `${el.offsetHeight}px`;
    back.scrollTop = el.scrollTop;
  }, [field]);
  const drawn = chips.length > 0;

  useLayoutEffect(follow, [follow, text]);
  useLayoutEffect(() => {
    const el = field.current;
    if (!el || !drawn) return;
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(follow);
    resize?.observe(el);
    el.addEventListener("scroll", follow, { passive: true });
    return () => {
      resize?.disconnect();
      el.removeEventListener("scroll", follow);
    };
  }, [field, follow, drawn]);

  if (!chips.length) return null;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const chip of chips) {
    parts.push(text.slice(at, chip.start));
    parts.push(
      <span key={chip.start} className="draft-chip">
        <ImageIcon aria-hidden="true" className="draft-chip-icon" />
        {text.slice(chip.start, chip.end)}
      </span>,
    );
    at = chip.end;
  }
  // A trailing newline needs a character after it to take its line, as the textarea gives it one.
  parts.push(`${text.slice(at)}​`);
  return <div ref={layer} aria-hidden="true" className="draft-chip-layer">{parts}</div>;
}
