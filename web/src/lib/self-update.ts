import { useEffect } from "react";

import { BUILD, isStaleBuild } from "@/lib/build";
import { getServerBuild, subscribeServerBuild } from "@/lib/server-build";
import { isReloadHeld, subscribeReloadHeld } from "@/lib/reload-guard";
import { checkForUpdate } from "@/lib/pwa";

// Discover builds from API responses. Two matching observations confirm an update; each build
// gets one automatic attempt after open-session and unsent-work holds clear. Settings provides
// the manual retry. Discovery never renders a notification over the user's conversation.

// sessionStorage key: keyed by build id so a genuinely newer build gets its own fresh guard.
const reloadedKey = (id: string): string => `collie:auto-reloaded-for=${id}`;

// Injectable update trigger — the default is the same path the footer button uses (checkForUpdate,
// which reloads onto the fresh bundle on both SW and no-SW origins). Tests swap in a spy (jsdom's
// window.location.reload throws) and assert the auto-update fires.
let reloadImpl: () => void = () => void checkForUpdate({ automatic: true });

/** Test seam — replace the reload implementation. */
export function __setReloadImpl(fn: () => void): void {
  reloadImpl = fn;
}

// Hysteresis state: a stale id seen once is `pendingStale` (awaiting a confirming second sighting);
// once seen twice it becomes `confirmedStale` and drives the action.
let pendingStale: string | undefined;
let confirmedStale: string | undefined;

function reloadedFor(id: string): boolean {
  try {
    return sessionStorage.getItem(reloadedKey(id)) !== null;
  } catch {
    return false; // storage disabled (private mode) — don't let that block a needed reload
  }
}

function markReloadedFor(id: string): void {
  try {
    sessionStorage.setItem(reloadedKey(id), String(Date.now()));
  } catch {
    /* storage disabled — the reload still happens; we just can't guard against a re-loop */
  }
}

// Decide what to do about a CONFIRMED-stale build id. Re-run whenever the observation confirms OR a
// hold changes (a cleared hold may now allow the deferred update). Acts regardless of service-worker
// presence — checkForUpdate() picks the right reload path for the origin.
function act(id: string): void {
  // Already attempted this build: leave any further attempt to Settings.
  if (reloadedFor(id)) {
    return;
  }
  // Session and draft holds are re-evaluated when the last hold clears.
  if (isReloadHeld()) {
    return;
  }
  // Safe + not yet updated for this id → update exactly once. reloadImpl defaults to checkForUpdate(),
  // which reloads onto the fresh bundle on both SW (update→activate→reload, with the unregister
  // fallback for a wedged precache) and no-SW (plain reload from the bridge) origins.
  markReloadedFor(id);
  reloadImpl();
}

// Run the hysteresis on each server-build observation.
function onServerBuild(): void {
  const server = getServerBuild();
  if (!isStaleBuild(BUILD.id, server)) {
    // Current (or unknown) — clear any pending/confirmed staleness.
    pendingStale = undefined;
    confirmedStale = undefined;
    return;
  }
  const id = server as string; // isStaleBuild guarantees a defined, non-"unknown" id here
  if (id === confirmedStale) {
    act(id); // already confirmed — re-evaluate (a hold or the SW state may have changed)
    return;
  }
  if (id === pendingStale) {
    // Second consecutive sighting of the same stale id → confirm and act.
    confirmedStale = id;
    pendingStale = undefined;
    act(id);
    return;
  }
  // First sighting of this stale id (or the id changed since the last poll) → hold one more poll.
  // Drop any prior confirmation: the server moved on, so the old confirmed id is void until this new
  // one confirms — otherwise onReloadGuard could act on a build the server no longer serves.
  pendingStale = id;
  confirmedStale = undefined;
}

function onReloadGuard(): void {
  // A hold just changed. If we're confirmed-stale, re-run the decision — clearing the last hold flips
  // act() from waiting to one automatic update.
  if (confirmedStale !== undefined) act(confirmedStale);
}

let started = false;

/**
 * Subscribe the controller to the server-build and reload-guard stores. Idempotent (guarded by
 * `started`); returns a disposer that unsubscribes. Mounted via useSelfUpdate below.
 */
export function startSelfUpdate(): () => void {
  if (started) return () => {};
  started = true;
  const unsubBuild = subscribeServerBuild(onServerBuild);
  const unsubHold = subscribeReloadHeld(onReloadGuard);
  onServerBuild(); // evaluate once in case a build was observed before we subscribed
  return () => {
    unsubBuild();
    unsubHold();
    started = false;
  };
}

/** Keep update discovery active without interrupting the page with a notice. */
export function useSelfUpdate(): void {
  useEffect(() => startSelfUpdate(), []);
}

/** Test helper — reset controller state (not subscriptions; those are disposer-managed). */
export function __resetSelfUpdate(): void {
  pendingStale = undefined;
  confirmedStale = undefined;
  reloadImpl = () => void checkForUpdate({ automatic: true });
}
