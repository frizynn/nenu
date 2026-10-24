import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** The type scale's steps, as index.css names them (`--text-body` gives `text-body`). */
export const TYPE_SCALE = ["micro", "caption", "footnote", "subhead", "body", "headline", "title", "large-title", "code", "control"] as const;

// Told about the scale, so text-body counts as a size: it then replaces text-sm and sits beside a
// text colour, where an unknown text-* would be taken for a colour and dropped.
const twMerge = extendTailwindMerge({
  extend: { classGroups: { "font-size": [{ text: [...TYPE_SCALE] }] } },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * `next` unless it says exactly what `prev` already says, in which case `prev` — so a polled read that
 * found nothing new keeps the object React holds and re-renders nothing. Meant for small JSON bodies.
 */
export function keepUnchanged<T>(prev: T | null | undefined, next: T): T {
  return prev != null && JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
}

/** `next` with every item that says what the same place in `prev` says kept as that item, and `prev` itself when all are. */
export function keepItems<T>(prev: T[] | undefined, next: T[]): T[] {
  if (!prev) return next;
  const kept = next.map((item, index) => keepUnchanged(prev[index], item));
  return kept.length === prev.length && kept.every((item, index) => item === prev[index]) ? prev : kept;
}
