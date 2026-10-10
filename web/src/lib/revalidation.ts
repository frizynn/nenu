// A revalidation re-runs every active loader, so a live event that names only the herd used to
// re-read the open pane's 600-line mirror too, and a mirror change re-fetched the whole snapshot.
// The poller says which loader a live event needs; the other one hands back what it last returned.
// React Router's route-level shouldRevalidate cannot see which live event started the run, so the
// loaders ask `needsFetch` themselves.

/** The two polled loaders: the herd snapshot and the open pane's mirror. */
export type RevalidationScope = "root" | "pane";

type Wanted = Record<RevalidationScope, boolean>;

// A narrowed scope belongs to the one run it was asked for. It waits in `pending` until that run's
// first loader picks it up and binds it to the run's request (React Router hands every loader of a
// run the same Request). A loader on any other request, such as a mutation's own `revalidate()`
// interrupting the narrowed run, re-reads.
let pending: Wanted | null = null;
let narrowed: { request: Request | undefined; wanted: Wanted } | null = null;

/**
 * Ask the next revalidation to re-read only `scope`. While a narrowed run has not settled the scope
 * joins it, so a run superseded by a narrower one never loses what the first one was asked for.
 */
export function narrowRevalidation(scope: RevalidationScope): void {
  const joined = pending ?? narrowed?.wanted ?? { root: false, pane: false };
  pending = { ...joined, [scope]: true };
}

/** A timer tick, a resume, a reconnect or a settled revalidator: every loader re-reads. */
export function widenRevalidation(): void {
  pending = null;
  narrowed = null;
}

/** Whether `scope`'s loader must fetch on the run `request` belongs to. Navigations always fetch. */
export function needsFetch(scope: RevalidationScope, request?: Request): boolean {
  if (pending) {
    narrowed = { request, wanted: pending };
    pending = null;
  }
  if (narrowed?.request !== request) narrowed = null;
  return narrowed?.wanted[scope] ?? true;
}
