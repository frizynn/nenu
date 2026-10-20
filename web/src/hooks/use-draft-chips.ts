import { useLayoutEffect, useRef, type RefObject } from "react";

import { draftChips, editChips } from "@/lib/message-images";

// Editing a draft whose pictures are chips (ADR 0104), for any textarea that holds one: the composer
// and the queue editor. An edit goes through editChips, so a chip is kept whole and names one
// picture; a cursor put inside a chip moves to its end, so nothing is typed into one; and when the
// edit changed the text React writes back, the cursor goes where the edit left it instead of the end.

export function useDraftChips(field: RefObject<HTMLTextAreaElement | null>) {
  /** Where the cursor last stood: where a picture picked from a menu goes. */
  const caret = useRef<number | null>(null);
  const pending = useRef<number | null>(null);
  useLayoutEffect(() => {
    const at = pending.current;
    const el = field.current;
    if (at === null || !el) return;
    pending.current = null;
    if (document.activeElement === el) el.setSelectionRange(at, at);
  });

  /** Put the cursor at `at` once React has written the value it belongs to. */
  function place(at: number) {
    caret.current = at;
    pending.current = at;
  }

  return {
    caret,
    place,
    /** One edit of a draft holding `count` pictures; `removed` are the pictures it took. */
    edit(before: string, value: string, at: number, count: number) {
      const kept = editChips(before, value, at, count);
      if (kept.text !== value) place(kept.caret);
      caret.current = kept.caret;
      return kept;
    },
    /** The cursor inside a chip goes to its end. Returns where it stands. */
    select(el: HTMLTextAreaElement): number {
      const { selectionStart: start, selectionEnd: end } = el;
      caret.current = end;
      const inside = start === end ? draftChips(el.value).find((chip) => chip.start < start && start < chip.end) : undefined;
      if (inside) {
        el.setSelectionRange(inside.end, inside.end);
        caret.current = inside.end;
      }
      return el.selectionStart;
    },
  };
}
