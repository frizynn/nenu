import type { ShouldRevalidateFunctionArgs } from "react-router";

// A revalidation re-runs every active loader, so a live event that names only the herd used to
// re-read the open pane's 600-line mirror too, and a mirror change re-fetched the whole snapshot.
// The poller says which loader a live event needs; the other one hands back what it last returned.
// React Router's shouldRevalidate cannot tell the root route from the pane route (both share this
// module's function), so the loaders ask `needsFetch` themselves.

/** The two polled loaders: the herd snapshot and the open pane's mirror. */
export type RevalidationScope = "root" | "pane";

const ALL: Record<RevalidationScope, boolean> = { root: true, pane: true };
let wanted = { ...ALL };
let settled = true;

/**
 * Ask the next revalidation to re-read only `scope`. While one is already running the scope joins
 * it, so a run superseded by a narrower one never loses what the first one was asked for.
 */
export function narrowRevalidation(scope: RevalidationScope): void {
  wanted = settled ? { root: false, pane: false, [scope]: true } : { ...wanted, [scope]: true };
  settled = false;
}

/** A timer tick, a resume or a reconnect: every loader re-reads. */
export function widenRevalidation(): void {
  wanted = { ...ALL };
  settled = false;
}

/**
 * The revalidator came to rest. Anything that revalidates without asking first (a mutation's own
 * `revalidate()`) then re-reads everything, as before.
 */
export function revalidationSettled(): void {
  wanted = { ...ALL };
  settled = true;
}

/** Whether `scope`'s loader must fetch on this revalidation run. Navigations always fetch. */
export function needsFetch(scope: RevalidationScope): boolean {
  return wanted[scope];
}

/** Test-only. */
export function resetRevalidation(): void {
  revalidationSettled();
}

/** Route-level hook kept at React Router's default; the per-loader decision is `needsFetch`. */
export function shouldRevalidate({ defaultShouldRevalidate }: ShouldRevalidateFunctionArgs): boolean {
  return defaultShouldRevalidate;
}
