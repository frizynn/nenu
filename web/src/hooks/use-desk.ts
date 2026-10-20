import { useMediaQuery } from "@/hooks/use-media-query";

/** Where workbench.css shows the desk's sidebar instead of the phone's tab bar. */
export const DESK = "(min-width: 1024px)";

/** Whether the app is drawn as a desk: its pages differ there from a phone's (ADR 0102). */
export function useDesk(): boolean {
  return useMediaQuery(DESK);
}
