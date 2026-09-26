import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { registerSW } = vi.hoisted(() => ({ registerSW: vi.fn() }));
vi.mock("virtual:pwa-register", () => ({ registerSW }));

class Worker extends EventTarget {
  state = "installing";
  postMessage = vi.fn();
  activate() {
    this.state = "activated";
    this.dispatchEvent(new Event("statechange"));
  }
}

let reload: ReturnType<typeof vi.fn>;
let unregister: ReturnType<typeof vi.fn>;
let serviceWorker: EventTarget & { controller: Worker | null; getRegistrations: ReturnType<typeof vi.fn> };
let registration: EventTarget & {
  installing: Worker | null;
  waiting: Worker | null;
  update: ReturnType<typeof vi.fn>;
};
let guard: typeof import("./reload-guard");
let pwa: typeof import("./pwa");

async function register(controlled = true) {
  serviceWorker.controller = controlled ? new Worker() : null;
  pwa = await import("./pwa");
  registerSW.mock.calls[0][0].onRegisteredSW("/sw.js", registration);
}

function discoverWorker() {
  const worker = new Worker();
  registration.installing = worker;
  registration.dispatchEvent(new Event("updatefound"));
  return worker;
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  reload = vi.fn();
  unregister = vi.fn().mockResolvedValue(true);
  serviceWorker = Object.assign(new EventTarget(), {
    controller: null as Worker | null,
    getRegistrations: vi.fn().mockResolvedValue([{ unregister }]),
  });
  registration = Object.assign(new EventTarget(), {
    installing: null as Worker | null,
    waiting: null as Worker | null,
    update: vi.fn().mockResolvedValue(undefined),
  });
  vi.stubGlobal("navigator", { serviceWorker });
  vi.stubGlobal("window", { location: { reload } });
  guard = await import("./reload-guard");
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("background service-worker updates", () => {
  it("routes the plugin's own autoUpdate callback through the same safety gate", async () => {
    await register();
    guard.holdReload("draft");
    registerSW.mock.calls[0][0].onNeedReload();
    expect(reload).not.toHaveBeenCalled();
    guard.releaseReload("draft");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("defers activation and controller-change reloads until every unsent-work hold clears", async () => {
    await register();
    guard.holdReload("draft");
    guard.holdReload("upload");
    vi.advanceTimersByTime(60_000);
    expect(registration.update).toHaveBeenCalledTimes(1);
    const worker = discoverWorker();
    worker.activate();
    serviceWorker.dispatchEvent(new Event("controllerchange"));
    expect(reload).not.toHaveBeenCalled();
    guard.releaseReload("draft");
    expect(reload).not.toHaveBeenCalled();
    guard.releaseReload("upload");
    expect(reload).toHaveBeenCalledTimes(1);
    worker.activate();
    serviceWorker.dispatchEvent(new Event("controllerchange"));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("does not flash on initial installation (controller claim first: %s)", async (claimFirst) => {
    await register(false);
    const worker = discoverWorker();
    if (claimFirst) serviceWorker.dispatchEvent(new Event("controllerchange"));
    worker.activate();
    if (!claimFirst) serviceWorker.dispatchEvent(new Event("controllerchange"));
    expect(reload).not.toHaveBeenCalled();
    discoverWorker().activate();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("respects a draft created after an automatic update starts, including its timeout", async () => {
    await register();
    registration.installing = new Worker();
    await pwa.checkForUpdate({ automatic: true });
    guard.holdReload("draft");
    registration.installing.activate();
    vi.advanceTimersByTime(8_000);
    expect(reload).not.toHaveBeenCalled();
    guard.releaseReload("draft");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("defers an automatic wedged-worker recovery until the open sheet closes", async () => {
    await register();
    guard.holdReload("sheet");
    await pwa.checkForUpdate({ automatic: true });
    expect(unregister).not.toHaveBeenCalled();
    guard.releaseReload("sheet");
    await vi.advanceTimersByTimeAsync(0);
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("checks new holds again after asynchronous worker removal", async () => {
    await register();
    let finishRemoval!: () => void;
    unregister.mockImplementation(() => new Promise<void>((resolve) => { finishRemoval = resolve; }));
    await pwa.checkForUpdate({ automatic: true });
    guard.holdReload("upload");
    finishRemoval();
    await vi.advanceTimersByTimeAsync(0);
    expect(reload).not.toHaveBeenCalled();
    guard.releaseReload("upload");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("also defers automatic navigation without a service-worker registration", async () => {
    pwa = await import("./pwa");
    guard.holdReload("draft");
    await pwa.checkForUpdate({ automatic: true });
    expect(reload).not.toHaveBeenCalled();
    guard.releaseReload("draft");
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("explicit update click", () => {
  it("preserves the deliberate navigation override and does not reload twice", async () => {
    await register();
    guard.holdReload("draft");
    await pwa.checkForUpdate();
    await vi.advanceTimersByTimeAsync(0);
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(8_000);
    guard.releaseReload("draft");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("keeps the precache when an update check fails offline", async () => {
    await register();
    registration.update.mockRejectedValue(new Error("offline"));
    await pwa.checkForUpdate();
    expect(unregister).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

it("does not reload the old app while an update check is still downloading", async () => {
  await register();
  let finish!: () => void;
  registration.update.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  const pending = pwa.checkForUpdate();
  await vi.advanceTimersByTimeAsync(9_000);
  expect(reload).not.toHaveBeenCalled();
  finish();
  await pending;
});

it("keeps the current page when the update cannot be downloaded", async () => {
  await register();
  registration.update.mockRejectedValue(new Error("weak signal"));
  await pwa.checkForUpdate();
  expect(reload).not.toHaveBeenCalled();
  expect(unregister).not.toHaveBeenCalled();
});
