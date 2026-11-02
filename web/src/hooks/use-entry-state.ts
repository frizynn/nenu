import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { useLocation } from "react-router";

// What each page left on screen, by history entry and name, for as long as the app runs.
const kept = new Map<string, unknown>();

/**
 * State a page keeps for its history entry: a step back to the entry (the back control, the system's
 * Back) draws the page as it was left, the way a phone's back shows the list you came from, with the
 * same rows open and in the same order; useKeptScroll then puts the scroll back on that same page. An
 * entry the app pushes or replaces has a new key, so it starts from `initial`. A page that stays mounted
 * through a navigation keeps its state and files it under the new entry. `name` tells apart two of
 * these on one page; null keeps nothing, plain state for a caller that keeps only sometimes.
 */
export function useEntryState<T>(name: string | null, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const { key } = useLocation();
  const id = name === null ? null : `${key}\0${name}`;
  const [value, setValue] = useState<T>(() => id !== null && kept.has(id) ? kept.get(id) as T : typeof initial === "function" ? (initial as () => T)() : initial);
  useEffect(() => {
    if (id !== null) kept.set(id, value);
  }, [id, value]);
  return [value, setValue];
}

/** Tests only: every test's router starts on the same entry key. */
export function __resetEntryStates(): void {
  kept.clear();
}
