import type { ShouldRevalidateFunctionArgs } from "react-router";

/**
 * Whether a route's loader re-runs on a revalidation. The router asks this for the root and pane
 * routes; deciding by what changed (a live event's topic, a poll, a navigation) lets one reader
 * refresh without re-pulling the others. For now it keeps React Router's default: every active
 * loader re-runs, exactly as before.
 */
export function shouldRevalidate({ defaultShouldRevalidate }: ShouldRevalidateFunctionArgs): boolean {
  return defaultShouldRevalidate;
}
