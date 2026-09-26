import { registerSW } from "virtual:pwa-register";
import { isReloadHeld, subscribeReloadHeld } from "@/lib/reload-guard";

// Service-worker registration + update wiring, in one place so the `virtual:pwa-register` import
// (a build-time virtual module) stays isolated and easy to stub in tests.
//
// The bridge serves a freshly-rebuilt bundle the instant it's built, but a browser only adopts it
// when the service worker runs an update check. We don't trust vite-plugin-pwa's own auto-reload
// (its `activated` handler wasn't firing — the manual button hung on "updating…"); instead we watch
// the worker lifecycle ourselves and reload once a new worker activates and unsent work is safe. Two entry
// points share that watcher:
//   1. a periodic update check, so a tab left open discovers and auto-applies a new build on its own;
//   2. checkForUpdate(), so Settings' "Reload interface" can force the check on demand.

// How often an open tab re-checks for a newer service worker. Frequent enough to feel automatic,
// cheap enough to ignore (a conditional GET of sw.js that 304s when nothing changed).
const UPDATE_CHECK_MS = 60_000;

// Bound the update attempt without navigating back onto an incomplete or offline build.
const UPDATE_TIMEOUT_MS = 60_000;
let updateInFlight: Promise<boolean> | undefined;

let registration: ServiceWorkerRegistration | undefined;
let reloaded = false;
let manualUpdate = false;
let forceReloading: Promise<void> | undefined;
let pendingReload: "plain" | "force" | undefined;
let stopWaiting: (() => void) | undefined;

// Was a service worker already controlling this page when we loaded? On a first-ever visit it
// isn't: `immediate` registration + the SW's clientsClaim then fire ONE `controllerchange` that is
// *initial* control, not an update — reloading on it is the spurious first-load flash. We ignore
// that first event (and mark ourselves controlled from then on), so only a *subsequent*
// controllerchange — a new SW replacing the old one — reloads. On a return visit a controller
// already exists, so every change requests a guarded reload.
let hadController = "serviceWorker" in navigator && Boolean(navigator.serviceWorker.controller);

function requestReload(force = false) {
  if (reloaded) return;
  if (!manualUpdate && isReloadHeld()) {
    if (force || !pendingReload) pendingReload = force ? "force" : "plain";
    stopWaiting ??= subscribeReloadHeld(() => {
      if (isReloadHeld()) return;
      const force = pendingReload === "force";
      stopWaiting?.();
      stopWaiting = undefined;
      pendingReload = undefined;
      requestReload(force);
    });
    return;
  }
  stopWaiting?.();
  stopWaiting = undefined;
  pendingReload = undefined;
  if (force) {
    void forceReload();
    return;
  }
  reloaded = true;
  window.location.reload();
}

// Last-resort reload that BYPASSES a wedged service worker: unregister every registration first, so
// the ensuing navigation fetches straight from the bridge instead of being answered from the stale
// precache (a plain reload stays controlled by the active worker and would re-serve the SAME old
// bundle — the "keeps saying new build, won't update" trap). The SW re-registers clean on the fresh
// load. Used ONLY when the normal worker-swap didn't confirm a newly-activated worker — never on the
// happy path, where the new precache is already in place and a plain reload is correct and lighter.
function forceReload(): Promise<void> {
  if (reloaded) return Promise.resolve();
  forceReloading ??= (async () => {
    try {
      const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
      await Promise.all(regs.map((r) => r.unregister()));
    } catch {
      // An explicit reload can still recover if the browser refused worker removal.
    }
    requestReload();
  })();
  return forceReloading;
}

function onControllerChange() {
  if (hadController) requestReload();
  else hadController = true;
}

// Request a guarded reload when a freshly-installed worker reaches "activated". Used by the periodic
// auto-check and the manual button, so neither depends on vite-plugin-pwa's (unreliable) auto-reload.
function watchWorker(worker: ServiceWorker | null) {
  if (!worker) return;
  // Capture this before initial clientsClaim changes hadController: installing the first worker
  // must not flash/reload an already-current first visit, regardless of lifecycle event order.
  const shouldReload = hadController;
  if (worker.state === "activated") {
    if (shouldReload) requestReload();
    return;
  }
  worker.addEventListener("statechange", () => {
    // skipWaiting is set in the generated SW, but if a worker still parks in "installed" (waiting),
    // nudge it through so it activates instead of stranding us.
    if (worker.state === "installed") registration?.waiting?.postMessage({ type: "SKIP_WAITING" });
    if (worker.state === "activated" && shouldReload) requestReload();
  });
}

registerSW({
  immediate: true,
  // autoUpdate's Workbox handler otherwise calls location.reload() directly, bypassing our guard.
  onNeedReload: () => requestReload(),
  onRegisteredSW(_swUrl, r) {
    registration = r;
    if (!r) return;
    // Any newly-found worker (from the poll below or a manual check) → reload when it activates.
    r.addEventListener("updatefound", () => watchWorker(r.installing));
    // A new SW taking control is the other reliable "we're updated now" signal — but only when it
    // *replaces* a prior controller (see onControllerChange); the first-visit initial claim is not
    // an update and must not reload.
    navigator.serviceWorker?.addEventListener("controllerchange", onControllerChange);
    setInterval(() => {
      if (!document.hidden && !updateInFlight) void r.update().catch(() => {});
    }, UPDATE_CHECK_MS);
  },
});

/** One update attempt at a time. A failed download leaves the current page intact. */
export function checkForUpdate({ automatic = false }: { automatic?: boolean } = {}): Promise<boolean> {
  if (updateInFlight) return updateInFlight;
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise<boolean>((resolve) => {
    timeout = setTimeout(() => { controller.abort(); resolve(false); }, UPDATE_TIMEOUT_MS);
  });
  updateInFlight = Promise.race([applyUpdate(automatic, controller.signal), deadline]).finally(() => {
    clearTimeout(timeout);
    controller.abort();
    manualUpdate = false;
    updateInFlight = undefined;
  });
  return updateInFlight;
}

async function applyUpdate(automatic: boolean, signal: AbortSignal): Promise<boolean> {
  if (!automatic) manualUpdate = true;
  if (!("serviceWorker" in navigator) || !registration) {
    requestReload();
    return true;
  }
  const reg = registration;
  try {
    await reg.update();
    if (signal.aborted) return false;
    const worker = reg.installing ?? reg.waiting;
    if (worker) {
      const activated = await waitForActivation(worker, signal);
      if (!activated) return false;
      requestReload();
    } else {
      // An online check found no replacement. Bypass a stale precache on the next navigation.
      // Automatic attempts still wait for all open-session/draft holds before unregistering.
      if (automatic) requestReload(true);
      else { await forceReload(); requestReload(); }
    }
    return true;
  } catch {
    return false;
  }
}

function waitForActivation(worker: ServiceWorker, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (ready: boolean) => {
      worker.removeEventListener("statechange", changed);
      signal.removeEventListener("abort", cancelled);
      resolve(ready);
    };
    const cancelled = () => finish(false);
    const changed = () => {
      if (signal.aborted || worker.state === "redundant") finish(false);
      else if (worker.state === "activated") finish(true);
      else if (worker.state === "installed") worker.postMessage({ type: "SKIP_WAITING" });
    };
    worker.addEventListener("statechange", changed);
    signal.addEventListener("abort", cancelled, { once: true });
    changed();
  });
}
