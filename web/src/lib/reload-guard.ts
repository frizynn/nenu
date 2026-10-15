import { useEffect } from "react";

// A registry of reasons the page must NOT be auto-reloaded right now — unsent composer text, an
// in-flight upload, an open action sheet. The self-updater (lib/self-update.ts) and the service-worker
// wiring (lib/pwa.ts) check isReloadHeld() before they reload onto a fresh build and, when the last
// hold clears, reload then instead (if still stale). Module-scoped like lib/busy so any component
// participates without prop-drilling. Keyed (not a counter) so a double-hold / double-release on the
// same key is idempotent, and distinct holders (composer, upload, a sheet) coexist.
//
// Two kinds. "work" is something a reload would lose: a draft, an upload, a message without its
// answer, a form. Nothing waives it but the work itself. "view" is something a reload would only
// interrupt: an open chat or preview, where someone may be reading. Coming back to the app is the
// moment nobody is reading yet, so for a short grace after that views stop holding and a waiting
// update applies (ADR 0083).

export type HoldKind = "work" | "view";

/** How long views stop holding after the app returns to the foreground. */
export const RESUME_GRACE_MS = 15_000;

const holds = new Map<string, HoldKind>();
const listeners = new Set<() => void>();
let viewsWaivedUntil = 0;

function emit(): void {
  for (const fn of listeners) fn();
}

/** Register a reason the page must not auto-reload. Idempotent per key. */
export function holdReload(key: string, kind: HoldKind = "work"): void {
  if (holds.get(key) === kind) return;
  holds.set(key, kind);
  emit();
}

/** Clear a previously-registered hold. Idempotent (unknown/duplicate keys are no-ops). */
export function releaseReload(key: string): void {
  if (!holds.delete(key)) return;
  emit();
}

/** True while unsent work is on the page: no automatic reload, even right after a return. */
export function isWorkHeld(): boolean {
  for (const kind of holds.values()) if (kind === "work") return true;
  return false;
}

/** True while any hold is active — the self-updater defers its auto-reload. */
export function isReloadHeld(): boolean {
  return isWorkHeld() || (holds.size > 0 && Date.now() >= viewsWaivedUntil);
}

/** The app just came back to the foreground: open views stop holding for a moment. */
export function waiveViewHolds(): void {
  viewsWaivedUntil = Date.now() + RESUME_GRACE_MS;
  emit();
}

export function subscribeReloadHeld(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Hold the reload for the lifetime of `active` under `key`. The convenience hook components use: a
 * composer holds while it has unsent text, an upload holds while in flight, an action sheet holds
 * while open. The hold releases on `active` going false OR on unmount, so a hold can never leak.
 */
export function useHoldReload(key: string, active: boolean, kind: HoldKind = "work"): void {
  useEffect(() => {
    if (!active) return;
    holdReload(key, kind);
    return () => releaseReload(key);
  }, [key, active, kind]);
}

/** Test helper — clear every hold between cases. */
export function __resetReloadGuard(): void {
  holds.clear();
  viewsWaivedUntil = 0;
}
