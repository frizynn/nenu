import { useLayoutEffect, type RefObject } from "react";

/**
 * Grows a textarea with its text where the browser can't do it from CSS: `field-sizing: content`
 * reached Safari only in 26.2, and without it a four-line draft sat in a one-line box. On every value
 * change the height comes from scrollHeight (the field's own max-height still caps it, and the field
 * scrolls past that); an empty field goes back to its stylesheet height.
 */
export function useAutosize(ref: RefObject<HTMLTextAreaElement | null>, value: unknown): void {
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field || nativeFieldSizing()) return;
    if (!field.value) {
      field.style.removeProperty("height");
      return;
    }
    field.style.height = "auto";
    // scrollHeight leaves out the border, which a border-box height includes.
    field.style.height = `${field.scrollHeight + field.offsetHeight - field.clientHeight}px`;
  }, [ref, value]);
}

function nativeFieldSizing(): boolean {
  return typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("field-sizing", "content");
}
