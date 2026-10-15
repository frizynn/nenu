import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { checkForUpdate } from "@/lib/pwa";
import { __resetServerBuild, observeServerBuild } from "./server-build";
import { __resetReloadGuard, holdReload, releaseReload } from "./reload-guard";
import {
  __resetSelfUpdate,
  __setReloadImpl,
  startSelfUpdate,
  useUpdateNotice,
} from "./self-update";

// self-update's default update path calls lib/pwa's checkForUpdate (which reloads onto the fresh
// bundle on both SW and no-SW origins). Mock it so we never touch the real registration side effect
// or jsdom's throwing window.location.reload, and can assert the update path fired.
vi.mock("@/lib/pwa", () => ({
  checkForUpdate: vi.fn(),
}));

// BUILD.id under vitest is "test" (vitest.config `define`). Any other id reads as "stale".
const STALE = "0.13.0+new.1";

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** The app goes to the background and comes back, as iOS resumes a frozen home-screen app. */
function leaveAndReturn() {
  setHidden(true);
  setHidden(false);
}

function confirm() {
  observeServerBuild(STALE);
  observeServerBuild(STALE);
}

let stop: () => void;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  sessionStorage.clear();
  __resetServerBuild();
  __resetReloadGuard();
  __resetSelfUpdate();
  fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: STALE }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  stop = startSelfUpdate();
});
afterEach(() => {
  stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
});

describe("hysteresis — two consecutive stale observations required", () => {
  it("does NOT act on one differing observation, DOES on the second", () => {
    const reload = vi.fn();
    __setReloadImpl(reload);
    observeServerBuild("test"); // matches BUILD.id → not stale
    observeServerBuild(STALE); // 1st stale sighting → pending, no action
    expect(reload).not.toHaveBeenCalled();
    observeServerBuild(STALE); // 2nd consecutive → confirmed → auto-reload (no SW, no hold)
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("a single transient flip mid-deploy (id changes between polls) never triggers", () => {
    const reload = vi.fn();
    __setReloadImpl(reload);
    observeServerBuild(STALE); // pending B
    observeServerBuild("0.13.0+other.2"); // a DIFFERENT stale id → pending resets, no confirm
    observeServerBuild("test"); // settles back to the current build → cleared
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("bounded retries — a failed attempt is not the last one", () => {
  it("retries a failed update on a later observation, after a pause", async () => {
    const reload = vi.fn().mockResolvedValue(false); // the download failed; the page is unchanged
    __setReloadImpl(reload);
    confirm();
    await vi.advanceTimersByTimeAsync(0);
    expect(reload).toHaveBeenCalledTimes(1);
    observeServerBuild(STALE); // the next poll, seconds later: too soon to try again
    expect(reload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    observeServerBuild(STALE);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("stops after three attempts in ten minutes, then tries again once they age out", async () => {
    const reload = vi.fn().mockResolvedValue(false);
    __setReloadImpl(reload);
    confirm();
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(20_000);
      observeServerBuild(STALE);
    }
    expect(reload).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    observeServerBuild(STALE);
    expect(reload).toHaveBeenCalledTimes(4);
  });

  it("counts attempts across reloads, so a page that comes back stale cannot loop", () => {
    const reload = vi.fn();
    __setReloadImpl(reload);
    const now = Date.now();
    sessionStorage.setItem("collie:update-attempts", JSON.stringify({ id: STALE, at: [now - 3_000, now - 2_000, now - 1_000] }));
    confirm();
    expect(reload).not.toHaveBeenCalled();
  });

  it("starts a fresh count for a newer build", () => {
    const reload = vi.fn();
    __setReloadImpl(reload);
    const now = Date.now();
    sessionStorage.setItem("collie:update-attempts", JSON.stringify({ id: "0.12.0+old.1", at: [now - 3_000, now - 2_000, now - 1_000] }));
    confirm();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("safety gate — never reload over unsent work", () => {
  it("waits while a hold is active, then updates when it clears", () => {
    const reload = vi.fn();
    __setReloadImpl(reload);
    holdReload("composer:w1:p1"); // e.g. unsent composer text
    confirm(); // confirmed but held → no reload
    expect(reload).not.toHaveBeenCalled();

    releaseReload("composer:w1:p1"); // hold clears while still stale → reload now
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("coming back to the foreground", () => {
  it("reads the served build once, cheaply, each time the app returns", async () => {
    leaveAndReturn();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/build-info.json", { cache: "no-store" });
    setHidden(false); // iOS may fire "visible" twice on one resume: one return
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    leaveAndReturn();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("counts a resume that never said it was hidden", () => {
    const reload = vi.fn();
    __setReloadImpl(reload);
    holdReload("open-agent-session", "view");
    confirm();
    setHidden(false); // suspended without a "hidden" event, resumed with "visible"
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("applies a waiting update in an open chat with nothing unsent", async () => {
    const reload = vi.fn();
    __setReloadImpl(reload);
    holdReload("open-agent-session", "view");
    confirm();
    expect(reload).not.toHaveBeenCalled(); // someone may be reading the chat
    leaveAndReturn();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("discovers the build from its own read when no poll has seen it", async () => {
    const reload = vi.fn();
    __setReloadImpl(reload);
    holdReload("open-agent-session", "view");
    leaveAndReturn(); // reads STALE once
    await vi.advanceTimersByTimeAsync(0);
    observeServerBuild(STALE); // the poll the return kicks
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("still waits for a draft", () => {
    const reload = vi.fn();
    __setReloadImpl(reload);
    holdReload("open-agent-session", "view");
    holdReload("composer:w1:p1");
    confirm();
    leaveAndReturn();
    expect(reload).not.toHaveBeenCalled();
  });

  it("returns from the back-forward cache the same way", () => {
    const reload = vi.fn();
    __setReloadImpl(reload);
    holdReload("open-agent-session", "view");
    confirm();
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not wait out the retry pause on a return", async () => {
    const reload = vi.fn().mockResolvedValue(false);
    __setReloadImpl(reload);
    confirm();
    await vi.advanceTimersByTimeAsync(1_000);
    leaveAndReturn();
    expect(reload).toHaveBeenCalledTimes(2);
  });
});

describe("the update notice", () => {
  it("shows while unsent work holds a confirmed update, and not before it is confirmed", () => {
    __setReloadImpl(vi.fn());
    holdReload("composer:w1:p1");
    const { result } = renderHook(() => useUpdateNotice());
    expect(result.current).toBe(false);
    act(() => observeServerBuild(STALE));
    expect(result.current).toBe(false);
    act(() => observeServerBuild(STALE));
    expect(result.current).toBe(true);
  });

  it("shows in an open chat, where the update would otherwise wait for the next return", () => {
    __setReloadImpl(vi.fn());
    holdReload("open-agent-session", "view");
    const { result } = renderHook(() => useUpdateNotice());
    act(() => confirm());
    expect(result.current).toBe(true);
  });

  it("stays hidden while an automatic update runs, and shows when it fails", async () => {
    let finish!: (ok: boolean) => void;
    __setReloadImpl(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const { result } = renderHook(() => useUpdateNotice());
    act(() => confirm());
    expect(result.current).toBe(false);
    await act(async () => finish(false));
    expect(result.current).toBe(true);
  });

  it("is never shown for a current page", () => {
    holdReload("composer:w1:p1");
    const { result } = renderHook(() => useUpdateNotice());
    act(() => { observeServerBuild("test"); observeServerBuild("test"); });
    expect(result.current).toBe(false);
  });
});

describe("update path — fires regardless of service-worker presence (checkForUpdate handles both)", () => {
  it("invokes checkForUpdate exactly once on confirmation (the default, SW-agnostic update path)", () => {
    // No injected reloadImpl here — exercise the real default (() => checkForUpdate()).
    confirm();
    expect(vi.mocked(checkForUpdate)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(checkForUpdate)).toHaveBeenCalledWith({ automatic: true });
  });
});
