import { useEffect, useSyncExternalStore } from "react";

import { BUILD, isStaleBuild } from "@/lib/build";
import { getServerBuild, observeServerBuild, subscribeServerBuild } from "@/lib/server-build";
import { isReloadHeld, subscribeReloadHeld, waiveViewHolds } from "@/lib/reload-guard";
import { checkForUpdate } from "@/lib/pwa";

// Discover builds from API responses, and from one read of build-info.json each time the app comes
// back to the foreground: an installed phone app is frozen in the background and resumes without a
// load, so a return is the moment to look. Two matching observations confirm an update. It applies on
// its own once nothing holds the reload; an open chat stops holding for a moment after a return
// (lib/reload-guard). A failed attempt is retried, a bounded number of times. While an update has to
// wait, or cannot finish, the update banner offers it (ADR 0083).

// Attempts per build survive a reload, so a page that comes back still stale cannot loop.
const ATTEMPTS_KEY = "collie:update-attempts";
const MAX_ATTEMPTS = 3;
const ATTEMPT_WINDOW_MS = 10 * 60_000;
/** A failed attempt waits this long for the next one, unless the app comes back in between. */
const RETRY_AFTER_MS = 15_000;
/** Visibility events closer than this are one return. */
const RETURN_DEBOUNCE_MS = 2_000;

// Injectable update trigger — the default is the path Settings' button uses (checkForUpdate, which
// reloads onto the fresh bundle on both SW and no-SW origins). It resolves false when the update could
// not finish and the page is unchanged. Tests swap in a spy (jsdom's window.location.reload throws).
type UpdateImpl = () => void | Promise<boolean>;
const DEFAULT_UPDATE: UpdateImpl = () => checkForUpdate({ automatic: true });
let reloadImpl: UpdateImpl = DEFAULT_UPDATE;

/** Test seam — replace the reload implementation. */
export function __setReloadImpl(fn: UpdateImpl): void {
  reloadImpl = fn;
}

// Hysteresis state: a stale id seen once is `pendingStale` (awaiting a confirming second sighting);
// once seen twice it becomes `confirmedStale` and drives the action.
let pendingStale: string | undefined;
let confirmedStale: string | undefined;
let applying = false;
let failed = false;
let returnedAt = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

function attemptsFor(id: string): number[] {
  try {
    const saved = JSON.parse(sessionStorage.getItem(ATTEMPTS_KEY) ?? "null") as { id?: unknown; at?: unknown } | null;
    if (saved?.id !== id || !Array.isArray(saved.at)) return [];
    return saved.at.filter((t): t is number => typeof t === "number" && Date.now() - t < ATTEMPT_WINDOW_MS);
  } catch {
    return []; // storage disabled (private mode): the in-flight guard and the retry pause still apply
  }
}

function recordAttempt(id: string, at: number[]): void {
  try {
    sessionStorage.setItem(ATTEMPTS_KEY, JSON.stringify({ id, at: [...at, Date.now()] }));
  } catch {
    /* storage disabled — the attempt still runs */
  }
}

// Decide what to do about a CONFIRMED-stale build id. Re-run whenever the observation confirms, a
// hold changes or the app returns.
function act(id: string): void {
  if (applying || isReloadHeld()) return;
  const at = attemptsFor(id);
  if (at.length >= MAX_ATTEMPTS) return;
  const last = at[at.length - 1];
  if (last !== undefined && last > returnedAt && Date.now() - last < RETRY_AFTER_MS) return;
  recordAttempt(id, at);
  applying = true;
  notify();
  void Promise.resolve(reloadImpl())
    .then((ok) => { failed = ok === false; }, () => { failed = true; })
    .finally(() => {
      applying = false;
      notify();
    });
}

// Run the hysteresis on each server-build observation.
function onServerBuild(): void {
  const server = getServerBuild();
  if (server === undefined || !isStaleBuild(BUILD.id, server)) {
    // Current (or unknown) — clear any pending/confirmed staleness.
    pendingStale = undefined;
    confirmedStale = undefined;
    failed = false;
  } else if (server === confirmedStale) {
    act(server); // already confirmed — re-evaluate (a hold or the SW state may have changed)
  } else if (server === pendingStale) {
    // Second consecutive sighting of the same stale id → confirm and act.
    confirmedStale = server;
    pendingStale = undefined;
    failed = false;
    act(server);
  } else {
    // First sighting of this stale id (or the id changed since the last poll) → hold one more poll.
    // Drop any prior confirmation: the server moved on, so the old confirmed id is void until this
    // new one confirms — otherwise onReloadGuard could act on a build the server no longer serves.
    pendingStale = server;
    confirmedStale = undefined;
  }
  notify();
}

function onReloadGuard(): void {
  // A hold just changed. If we're confirmed-stale, re-run the decision — clearing the last hold flips
  // act() from waiting to an automatic update.
  if (confirmedStale !== undefined) act(confirmedStale);
  notify();
}

// The served build, read straight from the bridge. Not in the precache, so the worker passes it
// through; a failed read is left to the polls.
async function readServedBuild(): Promise<void> {
  try {
    const res = await fetch("/build-info.json", { cache: "no-store" });
    if (!res.ok) return;
    const info = (await res.json()) as { id?: unknown };
    if (typeof info.id === "string") observeServerBuild(info.id);
  } catch {
    /* offline or a proxy's sign-in page: the next poll observes the build */
  }
}

// Back in the foreground: a fresh chance for a failed attempt, a moment in which an open chat does not
// hold the update, and a look at the served build.
function onReturn(): void {
  returnedAt = Date.now();
  waiveViewHolds();
  void readServedBuild();
}

let started = false;

/**
 * Subscribe the controller to the server-build and reload-guard stores and to the app's returns.
 * Idempotent (guarded by `started`); returns a disposer. Mounted via useSelfUpdate below.
 */
export function startSelfUpdate(): () => void {
  if (started) return () => {};
  started = true;
  const unsubBuild = subscribeServerBuild(onServerBuild);
  const unsubHold = subscribeReloadHeld(onReloadGuard);
  // Any visibilitychange that ends visible is a return. iOS may suspend a home-screen app before
  // telling the page it is hidden, then fire "visible" on resume, sometimes twice (WebKit bug
  // 207256): requiring a hidden first would miss the return, so the pair counts once.
  const onVisibility = () => {
    if (!document.hidden && Date.now() - returnedAt >= RETURN_DEBOUNCE_MS) onReturn();
  };
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) onReturn();
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pageshow", onPageShow);
  onServerBuild(); // evaluate once in case a build was observed before we subscribed
  return () => {
    unsubBuild();
    unsubHold();
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pageshow", onPageShow);
    started = false;
  };
}

/** Keep update discovery active. */
export function useSelfUpdate(): void {
  useEffect(() => startSelfUpdate(), []);
}

/** A confirmed update that is not applying on its own: held by the page, failed, or out of tries. */
function noticeShown(): boolean {
  if (confirmedStale === undefined || applying) return false;
  return failed || isReloadHeld() || attemptsFor(confirmedStale).length >= MAX_ATTEMPTS;
}

function subscribeNotice(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Whether the update banner offers the new build (components/update-banner.tsx). */
export function useUpdateNotice(): boolean {
  return useSyncExternalStore(subscribeNotice, noticeShown, () => false);
}

/** Test helper — reset controller state (not subscriptions; those are disposer-managed). */
export function __resetSelfUpdate(): void {
  pendingStale = undefined;
  confirmedStale = undefined;
  applying = false;
  failed = false;
  returnedAt = 0;
  reloadImpl = DEFAULT_UPDATE;
}
