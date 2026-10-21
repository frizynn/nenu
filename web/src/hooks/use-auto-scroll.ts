import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

interface UseAutoScrollOptions {
  /** Px distance from the bottom still considered "at bottom". */
  offset?: number;
  /** Any value that changes when new content is appended — drives the auto-scroll effect. */
  dep?: unknown;
  /** Fires when the at-bottom state changes — lets a parent follow live output or freeze it. */
  onAtBottomChange?: (atBottom: boolean) => void;
}

/** At or past the bottom (an iOS bounce overshoots it), within `offset` px. */
export function atTail(el: HTMLElement, offset = 24): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= offset;
}

/**
 * The list can no longer reach where it last stood: it grew (the phone keyboard going down) or its
 * content shrank, so the browser clamped scrollTop. The move up its scroll event reports is the
 * layout's, and it may arrive after the list changed again: the closed keyboard's composer rows come
 * back in between, so the event lands short of the tail. A reader's own scroll never changes the range.
 */
export function clamped(el: HTMLElement, lastTop: number): boolean {
  return el.scrollHeight - el.clientHeight < lastTop;
}

/** Where the list stands, short of an iOS bounce past the bottom, which no clamp can follow. */
export function standing(el: HTMLElement): number {
  return Math.min(el.scrollTop, el.scrollHeight - el.clientHeight);
}

/** A field the operator types in: keys there edit text, they do not scroll a list. */
export function isTextField(node: EventTarget | null): node is HTMLElement {
  return node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement || (node instanceof HTMLElement && node.isContentEditable === true);
}

/** How long after an edit a move up can still be the layout settling rather than the reader. */
const EDIT_SETTLE_MS = 500;

/**
 * Whether a move up was the layout's, not the reader's. Editing a textarea can resize it and back
 * within one layout (replacing a selection empties the composer first): the list beside it grows, the
 * browser clamps its scrollTop, the list shrinks back, and no ResizeObserver runs because nothing
 * ended up a different size. Geometry alone can't tell that event from the reader scrolling up the
 * same distance. The reader moves a list with their own input on it (a wheel, a touch, a pointer, a
 * key outside a field), so a move up soon after an edit with none of that since is the layout's. Long
 * after an edit, a move up stays the reader's: a screen reader or the browser's find moves the list
 * without touching it. Only a textarea counts: its height follows its text, while a one-line input
 * (the mirror's Find, the History search) never resizes, and the jump to a match it starts is a move
 * up the list has to make.
 */
export function useEditShift(scrollRef: RefObject<HTMLElement | null>): () => boolean {
  const lastEdit = useRef(Number.NEGATIVE_INFINITY);
  const lastReader = useRef(Number.NEGATIVE_INFINITY);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const edit = (event: Event) => {
      if (event.target instanceof HTMLTextAreaElement) lastEdit.current = performance.now();
    };
    const reader = () => { lastReader.current = performance.now(); };
    const key = (event: KeyboardEvent) => {
      if (!isTextField(event.target) && (event.target === document.body || el.contains(event.target as Node))) reader();
    };
    const pointer = ["wheel", "touchstart", "touchmove", "pointerdown"] as const;
    document.addEventListener("input", edit, true);
    document.addEventListener("keydown", key, true);
    for (const type of pointer) el.addEventListener(type, reader, { passive: true });
    return () => {
      document.removeEventListener("input", edit, true);
      document.removeEventListener("keydown", key, true);
      for (const type of pointer) el.removeEventListener(type, reader);
    };
  }, [scrollRef]);
  return useCallback(() => lastEdit.current > lastReader.current && performance.now() - lastEdit.current < EDIT_SETTLE_MS, []);
}

// Keeps a scroll container pinned to the bottom as content grows, but yields control the moment
// the user scrolls up to read backscroll (and offers a button to jump back down).
//
// Only a move UP leaves the tail. A pin queues a scroll event the browser dispatches a frame later,
// and output that grows meanwhile makes that event report a gap nobody scrolled; read as the user
// leaving, it froze the view at the bottom behind the arrow. So `lastTop` keeps where the list last
// stood, set by every pin, and an event that did not move above it re-pins instead. A move up an edit
// caused (useEditShift) or a clamp (clamped) re-pins too.
export function useAutoScroll<T extends HTMLElement = HTMLDivElement>(
  options: UseAutoScrollOptions = {},
) {
  const { offset = 24, dep, onAtBottomChange } = options;
  const scrollRef = useRef<T>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const autoScroll = useRef(true);
  const lastTop = useRef(0);
  const editShift = useEditShift(scrollRef);

  const pin = useCallback((el: HTMLElement) => {
    el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
    lastTop.current = el.scrollTop;
  }, []);

  const pinToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !autoScroll.current) return;
    pin(el);
  }, [pin]);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    autoScroll.current = true;
    pin(el);
    setIsAtBottom(true);
    onAtBottomChange?.(true);
  }, [onAtBottomChange, pin]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = lastTop.current;
    const up = el.scrollTop < top;
    lastTop.current = standing(el);
    const bottom = atTail(el, offset);
    if (!bottom && (!up || (autoScroll.current && (editShift() || clamped(el, top))))) {
      if (autoScroll.current) pin(el);
      return;
    }
    autoScroll.current = bottom;
    setIsAtBottom(bottom);
    onAtBottomChange?.(bottom);
  }, [offset, onAtBottomChange, pin, editShift]);

  // Re-pin before paint when new content arrives — opening a pane / switching tabs must land on
  // the live tail without a flash of the oldest scrollback. Yields if the user has scrolled away.
  useLayoutEffect(() => {
    pinToBottom();
  }, [dep, pinToBottom]);

  // Re-pin when the container OR its content resizes while we're following.
  // - Container: a shrinking viewport (keys dock, on-screen keyboard) pushes the tail below the fold.
  // - Content: opening a pane paints the flex-sized scroller first; AnsiOutput then grows inside it.
  //   That does not change the container's border box, so observing only `el` leaves you stuck at the
  //   top of scrollback. Keyed on the captured `autoScroll` intent, NOT a recomputed at-bottom (a
  //   shrink already moved the view off bottom); a scrolled-up user is left in place.
  // Guarded for jsdom, which has no ResizeObserver.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    const ro = new ResizeObserver(() => {
      pinToBottom();
    });
    ro.observe(el);
    for (const child of Array.from(el.children)) {
      ro.observe(child);
    }

    // React replaces/grows children across polls and pane opens — keep observing new nodes and
    // re-pin when the child list changes while following.
    const mo = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof Element) ro.observe(node);
        }
      }
      pinToBottom();
    });
    mo.observe(el, { childList: true });

    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [pinToBottom]);

  return { scrollRef, isAtBottom, scrollToBottom, onScroll };
}
