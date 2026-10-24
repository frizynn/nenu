import { onTestFinished } from "vitest";
import { delay, http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { fixtureAgents, fixtureSnapshot, paneTextWithDraft } from "@/test/handlers";

// loaders.ts keeps a module-level "last good" cache, so each test re-imports the module fresh
// (via vi.resetModules) to start from an empty cache and stay independent of run order.
//
// The write-through cache (lib/last-seen.ts) outlives a module reset by design — it lives in
// sessionStorage precisely so a discarded page can read it back. Clearing it here is what makes each
// case a genuinely cold tab; the cases that WANT a warm one prime it themselves.
beforeEach(() => {
  vi.resetModules();
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const failSnapshot = () =>
  server.use(http.get("/api/snapshot", () => new HttpResponse(null, { status: 500 })));

const rejectSnapshot = (status: 401 | 403) =>
  server.use(http.get("/api/snapshot", () => new HttpResponse(null, { status })));

const failPane = () =>
  server.use(http.get(/\/api\/pane\/[^/]+$/, () => new HttpResponse(null, { status: 500 })));

const rejectPane = (status: 401 | 403) =>
  server.use(http.get(/\/api\/pane\/[^/]+$/, () => new HttpResponse(null, { status })));

describe("rootLoader", () => {
  it("returns the live snapshot on success", async () => {
    const { rootLoader } = await import("./loaders");
    const data = await rootLoader();
    expect(data.error).toBe(false);
    expect(data.authError).toBe(false);
    expect(data.bridge).toBe("connected");
    expect(data.agents).toHaveLength(2);
  });

  it("hands back the same herd object when the bridge answers 304", async () => {
    server.use(
      http.get("/api/snapshot", ({ request }) =>
        request.headers.get("if-none-match") === '"h1"'
          ? new HttpResponse(null, { status: 304, headers: { etag: '"h1"' } })
          : HttpResponse.json(fixtureSnapshot, { headers: { etag: '"h1"' } }),
      ),
    );
    const { rootLoader } = await import("./loaders");
    const first = await rootLoader({ request: new Request("http://localhost/") });
    const second = await rootLoader({ request: new Request("http://localhost/") });
    expect(second).toBe(first);
    expect(second.error).toBe(false);
  });

  it.each([401, 403] as const)("marks a %i response as an auth error", async (status) => {
    rejectSnapshot(status);
    const { rootLoader } = await import("./loaders");
    const data = await rootLoader();
    expect(data.error).toBe(true);
    expect(data.authError).toBe(true);
  });

  it("keeps the last-good herd (flagged error) when a refresh fails", async () => {
    const { rootLoader } = await import("./loaders");
    await rootLoader(); // prime the cache with a good snapshot

    failSnapshot();
    const stale = await rootLoader();

    expect(stale.error).toBe(true);
    expect(stale.authError).toBe(false);
    expect(stale.bridge).toBe("connected"); // from the cached snapshot
    expect(stale.agents).toHaveLength(2);
    expect(stale.agents[0]!.paneId).toBe(fixtureAgents[0]!.paneId);
  });

  it("does not mark a network error as an auth error", async () => {
    const { rootLoader } = await import("./loaders");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network failed"));
    const data = await rootLoader();
    expect(data.error).toBe(true);
    expect(data.authError).toBe(false);
  });

  it("returns empty + error when there is no last-good snapshot", async () => {
    failSnapshot();
    const { rootLoader } = await import("./loaders");
    const data = await rootLoader();
    expect(data.error).toBe(true);
    expect(data.agents).toEqual([]);
    expect(data.bridge).toBeUndefined();
  });

  it("treats a cold-start TimeoutError as an error snapshot, NOT a rethrow to the error boundary", async () => {
    // The cold-start-against-a-dead-host case: the first snapshot fetch aborts at its timeout with a
    // DOMException named "TimeoutError" (distinct from the "AbortError" of a superseded revalidation).
    // The loader must fall into the error-snapshot branch so RootLayout + the escalation prompt handle
    // it uniformly — it must NOT bubble to RootError's generic "Something went wrong" screen.
    const { rootLoader } = await import("./loaders");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    const data = await rootLoader();
    expect(data.error).toBe(true);
    expect(data.authError).toBe(false);
    expect(data.bridge).toBeUndefined();
    expect(data.agents).toEqual([]);
  });

  it("surfaces the snapshot's optional update field onto the loader data", async () => {
    const update = {
      current: "0.11.0",
      latest: "0.12.0",
      releaseAvailable: true,
      bridgeStale: false,
      checkedAt: 123,
    };
    server.use(
      http.get("/api/snapshot", () => HttpResponse.json({ ...fixtureSnapshot, update })),
    );
    const { rootLoader } = await import("./loaders");
    const data = await rootLoader();
    expect(data.update).toEqual(update);
  });

  it("leaves update undefined when the snapshot omits it (older bridge)", async () => {
    const { rootLoader } = await import("./loaders");
    const data = await rootLoader();
    expect(data.update).toBeUndefined();
  });
});

describe("rootLoader — pull requests", () => {
  const pr = (number: number) => ({ repo: "a/b", number, title: `PR ${number}`, url: `https://github.com/a/b/pull/${number}`, branch: `b${number}`, draft: false, paneIds: [] });

  // The snapshot names the list's version; the list is read only when that version moves.
  function serve(lists: Record<string, ReturnType<typeof pr>[]>) {
    let version = Object.keys(lists)[0]!;
    let ts = 0;
    const reads: Array<string | null> = [];
    server.use(
      http.get("/api/snapshot", () => HttpResponse.json({ ...fixtureSnapshot, ts: ++ts, pullRequestsEtag: version })),
      http.get("/api/pull-requests", ({ request }) => {
        reads.push(request.headers.get("if-none-match"));
        return HttpResponse.json(lists[version], { headers: { etag: version } });
      }),
    );
    return { reads, move: (to: string) => { version = to; } };
  }

  it("reads the list once per version and keeps its identity while the herd moves", async () => {
    const bridge = serve({ '"v1"': [pr(1)], '"v2"': [pr(1), pr(2)] });
    const { rootLoader } = await import("./loaders");
    const first = await rootLoader({ request: new Request("http://localhost/") });
    const second = await rootLoader({ request: new Request("http://localhost/") });
    expect(first.pullRequests?.map((p) => p.number)).toEqual([1]);
    expect(second).not.toBe(first);
    expect(second.pullRequests).toBe(first.pullRequests);
    expect(bridge.reads).toEqual([null]);

    bridge.move('"v2"');
    const third = await rootLoader({ request: new Request("http://localhost/") });
    expect(third.pullRequests?.map((p) => p.number)).toEqual([1, 2]);
    expect(bridge.reads).toEqual([null, '"v1"']);
  });

  it("keeps the list without flagging the herd when its read fails, and asks again", async () => {
    const bridge = serve({ '"v1"': [pr(1)], '"v2"': [pr(2)] });
    const { rootLoader } = await import("./loaders");
    const first = await rootLoader({ request: new Request("http://localhost/") });
    bridge.move('"v2"');
    server.use(http.get("/api/pull-requests", () => new HttpResponse(null, { status: 500 })));
    const failed = await rootLoader({ request: new Request("http://localhost/") });
    expect(failed.error).toBe(false);
    expect(failed.pullRequests).toBe(first.pullRequests);
    server.resetHandlers();
    serve({ '"v2"': [pr(2)] });
    const recovered = await rootLoader({ request: new Request("http://localhost/") });
    expect(recovered.pullRequests?.map((p) => p.number)).toEqual([2]);
  });

  it("shows the last list on a cold stale render", async () => {
    serve({ '"v1"': [pr(7)] });
    const first = await (await import("./loaders")).rootLoader({ request: new Request("http://localhost/") });
    expect(first.pullRequests?.map((p) => p.number)).toEqual([7]);
    vi.resetModules();
    failSnapshot();
    const cold = await (await import("./loaders")).rootLoader({ request: new Request("http://localhost/") });
    expect(cold.error).toBe(true);
    expect(cold.pullRequests?.map((p) => p.number)).toEqual([7]);
  });

  it("shows none for a snapshot that names no list (another machine)", async () => {
    const { rootLoader } = await import("./loaders");
    const data = await rootLoader();
    expect(data.pullRequests).toEqual([]);
  });
});

describe("paneLoader", () => {
  it("returns pane text on success", async () => {
    const { paneLoader } = await import("./loaders");
    const data = await paneLoader({ params: { paneId: "w1:p1" } });
    expect(data.error).toBe(false);
    expect(data.authError).toBe(false);
    expect(data.paneId).toBe("w1:p1");
    expect(data.text).toBe(paneTextWithDraft());
  });

  it("carries whether a shell sits at its prompt, and drops it on a stale read", async () => {
    server.use(http.get(/\/api\/pane\/[^/]+$/, () => HttpResponse.json({ paneId: "w1:p1", text: "$ vpn", truncated: false, revision: 4, atPrompt: false })));
    const { paneLoader } = await import("./loaders");
    expect((await paneLoader({ params: { paneId: "w1:p1" } })).atPrompt).toBe(false);
    failPane();
    expect((await paneLoader({ params: { paneId: "w1:p1" } })).atPrompt).toBeUndefined();
  });

  it.each([401, 403] as const)("marks a %i response as an auth error", async (status) => {
    rejectPane(status);
    const { paneLoader } = await import("./loaders");
    const data = await paneLoader({ params: { paneId: "w1:p1" } });
    expect(data.error).toBe(true);
    expect(data.authError).toBe(true);
  });

  it("keeps the last-good pane text (flagged error) when a refresh fails", async () => {
    const { paneLoader } = await import("./loaders");
    await paneLoader({ params: { paneId: "w1:p1" } }); // prime per-pane cache

    failPane();
    const stale = await paneLoader({ params: { paneId: "w1:p1" } });

    expect(stale.error).toBe(true);
    expect(stale.authError).toBe(false);
    expect(stale.text).toBe(paneTextWithDraft());
    expect(stale.paneId).toBe("w1:p1");
  });

  it("returns empty text + error when no last-good exists for that pane", async () => {
    failPane();
    const { paneLoader } = await import("./loaders");
    const data = await paneLoader({ params: { paneId: "wX:p9" } });
    expect(data.error).toBe(true);
    expect(data.text).toBe("");
    expect(data.paneId).toBe("wX:p9");
  });

  it("treats a TimeoutError from fetchPane as degraded (stale text + error), NOT a rethrow", async () => {
    // A request that times out aborts with a DOMException named "TimeoutError" — distinct from the
    // "AbortError" of a superseded revalidation. The loader rethrows only AbortError, so a timeout
    // must fall into the stale-data branch (keep the last-good text on screen, flagged) and not
    // bubble up as if the run were superseded.
    const { paneLoader } = await import("./loaders");
    await paneLoader({ params: { paneId: "w1:p1" } }); // prime the per-pane stale cache (via MSW)

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    const stale = await paneLoader({ params: { paneId: "w1:p1" } });

    expect(stale.error).toBe(true);
    expect(stale.authError).toBe(false);
    expect(stale.text).toBe(paneTextWithDraft());
    expect(stale.paneId).toBe("w1:p1");
  });

  it("throws on a missing :paneId param (fail-loud to the error boundary)", async () => {
    const { paneLoader } = await import("./loaders");
    await expect(paneLoader({ params: {} })).rejects.toThrow(/paneId/);
  });
});

describe("requested-lines bookkeeping (Load older)", () => {
  // The cap is 1000 because HERDR clamps `pane.read` there (live-probed: 2000 and 6000 both return
  // 1001 lines against a 6895-line buffer). With a 600-line base window that means exactly ONE
  // useful tap — which is the honest ceiling, not a shortfall in the stepping.
  it("defaults to the base window and grows to Herdr's real ceiling in one tap", async () => {
    const { getRequestedLines, growRequestedLines, canGrowRequestedLines, DETAIL_HISTORY_MAX } =
      await import("./loaders");
    expect(DETAIL_HISTORY_MAX).toBe(1000);
    expect(getRequestedLines("w1:p1")).toBe(600);
    expect(canGrowRequestedLines("w1:p1")).toBe(true);

    // A 600 step would overshoot the cap, so the first tap lands exactly on it.
    expect(growRequestedLines("w1:p1")).toBe(DETAIL_HISTORY_MAX);
    expect(getRequestedLines("w1:p1")).toBe(DETAIL_HISTORY_MAX);

    // Further taps clamp rather than climb, and the affordance switches off.
    expect(growRequestedLines("w1:p1")).toBe(DETAIL_HISTORY_MAX);
    expect(canGrowRequestedLines("w1:p1")).toBe(false);
  });

  it("tracks each pane independently", async () => {
    const { getRequestedLines, growRequestedLines } = await import("./loaders");
    growRequestedLines("w1:p1");
    expect(getRequestedLines("w1:p1")).toBe(1000);
    expect(getRequestedLines("w2:p1")).toBe(600); // untouched
  });

  it("the loader fetches with (and reports) the pane's requested window", async () => {
    const { paneLoader, growRequestedLines } = await import("./loaders");
    growRequestedLines("w1:p1"); // 600 → 1000 (the cap)
    const data = await paneLoader({ params: { paneId: "w1:p1" } });
    expect(data.requestedLines).toBe(1000);
  });

  it("resetRequestedLines clears back to the base window", async () => {
    const { getRequestedLines, growRequestedLines, resetRequestedLines } = await import("./loaders");
    growRequestedLines("w1:p1");
    resetRequestedLines("w1:p1");
    expect(getRequestedLines("w1:p1")).toBe(600);
  });
});

// The session in the request URL's `?s=` must reach the API as `session=` and be exposed on the
// loader data so components don't re-derive it — and each session's keep-previous-data cache is
// independent, so a failed refresh in one never surfaces another session's herd/pane.
describe("loaders — session scoping", () => {
  it("rootLoader threads ?s= to the API as session= and surfaces it on the data", async () => {
    let captured: string | null = "MISSING";
    server.use(
      http.get("/api/snapshot", ({ request }) => {
        captured = new URL(request.url).searchParams.get("session");
        return HttpResponse.json(fixtureSnapshot);
      }),
    );
    const { rootLoader } = await import("./loaders");
    const data = await rootLoader({ request: new Request("http://localhost/?s=collie-demo") });
    expect(captured).toBe("collie-demo");
    expect(data.session).toBe("collie-demo");
    expect(data.sessions).toHaveLength(2);
  });

  it("rootLoader omits the param on the primary session (no ?s=)", async () => {
    let captured: string | null = "MISSING";
    server.use(
      http.get("/api/snapshot", ({ request }) => {
        captured = new URL(request.url).searchParams.get("session");
        return HttpResponse.json(fixtureSnapshot);
      }),
    );
    const { rootLoader } = await import("./loaders");
    const data = await rootLoader({ request: new Request("http://localhost/") });
    expect(captured).toBeNull();
    expect(data.session).toBeUndefined();
  });

  it("paneLoader threads the session through to the pane read", async () => {
    let captured: string | null = "MISSING";
    server.use(
      http.get(/\/api\/pane\/[^/]+$/, ({ request }) => {
        captured = new URL(request.url).searchParams.get("session");
        return HttpResponse.json({ paneId: "w1:p1", text: "hi", truncated: false, revision: 1 });
      }),
    );
    const { paneLoader } = await import("./loaders");
    const data = await paneLoader({
      params: { paneId: "w1:p1" },
      request: new Request("http://localhost/?s=collie-demo"),
    });
    expect(captured).toBe("collie-demo");
    expect(data.session).toBe("collie-demo");
  });

  it("keeps a per-session stale cache — a failed refresh in one session shows no other's herd", async () => {
    const { rootLoader } = await import("./loaders");
    await rootLoader({ request: new Request("http://localhost/") }); // prime the primary session

    failSnapshot(); // now every snapshot 500s
    const stale = await rootLoader({ request: new Request("http://localhost/?s=collie-demo") });

    expect(stale.error).toBe(true);
    expect(stale.session).toBe("collie-demo");
    expect(stale.agents).toEqual([]); // NOT the primary session's cached herd
    expect(stale.bridge).toBeUndefined();
  });

  it("tracks requested scrollback per (session, pane) so ids can't collide across sessions", async () => {
    const { getRequestedLines, growRequestedLines } = await import("./loaders");
    growRequestedLines("w1:p1", "collie-demo");
    expect(getRequestedLines("w1:p1", "collie-demo")).toBe(1000);
    expect(getRequestedLines("w1:p1")).toBe(600); // the primary session's same id is untouched
  });
});

// A PWA must navigate INSTANTLY to last-known data while offline. During a KNOWN, escalated outage
// (the shared connection-health store has latched "lost"), a NAVIGATION (loader run at a NEW url) skips
// the doomed fetch and returns cache immediately (flagged error); a REVALIDATION (same url — the poll)
// still really fetches, so recovery is discovered and the stale data swapped out. connection-health is
// imported AFTER vi.resetModules() alongside loaders so both share one fresh module instance (the latch
// the test sets is the one the loader reads).
describe("loaders — offline navigation fast path", () => {
  it("a navigation during a known outage returns the cached snapshot INSTANTLY (error, no fetch)", async () => {
    const { rootLoader } = await import("./loaders");
    const { latchLost } = await import("./connection-health");

    await rootLoader({ request: new Request("http://localhost/") }); // prime the last-good snapshot
    latchLost(); // escalated outage

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    // Different url ⇒ navigation ⇒ fast path: cache returned without touching the network.
    const data = await rootLoader({ request: new Request("http://localhost/space/w1") });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(data.error).toBe(true); // flagged stale
    expect(data.bridge).toBe("connected"); // last-known herd
    expect(data.agents).toHaveLength(2);
  });

  it("keeps the last auth classification on the navigation fast path", async () => {
    rejectSnapshot(401);
    const { rootLoader } = await import("./loaders");
    const { latchLost } = await import("./connection-health");

    const rejected = await rootLoader({ request: new Request("http://localhost/") });
    expect(rejected.authError).toBe(true);
    latchLost();

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const data = await rootLoader({ request: new Request("http://localhost/space/w1") });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(data.error).toBe(true);
    expect(data.authError).toBe(true);
  });

  it("a revalidation (same url) still really fetches while latched — polls keep probing", async () => {
    const { rootLoader } = await import("./loaders");
    const { latchLost } = await import("./connection-health");

    await rootLoader({ request: new Request("http://localhost/") }); // sets lastRootUrl = "/"
    latchLost();

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await rootLoader({ request: new Request("http://localhost/") }); // same url ⇒ revalidation
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("recovery: the next successful revalidation clears the latch and returns fresh, live data", async () => {
    const { rootLoader } = await import("./loaders");
    const { latchLost, isLostLatched } = await import("./connection-health");

    await rootLoader({ request: new Request("http://localhost/") });
    latchLost();
    expect(isLostLatched()).toBe(true);

    const data = await rootLoader({ request: new Request("http://localhost/") }); // lands (MSW success)
    expect(data.error).toBe(false);
    expect(isLostLatched()).toBe(false); // markLive cleared the latch
  });

  it("navigating to an UNVISITED pane during an outage returns a degraded pane INSTANTLY (no fetch)", async () => {
    const { paneLoader } = await import("./loaders");
    const { latchLost } = await import("./connection-health");
    latchLost();

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const data = await paneLoader({
      params: { paneId: "wX:p9" },
      request: new Request("http://localhost/pane/wX:p9"),
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(data.error).toBe(true);
    expect(data.text).toBe(""); // never fetched → empty mirror, but instant (no 10s hang)
    expect(data.revision).toBe(0);
  });

  it("returning to a PREVIOUSLY-VISITED pane during an outage shows its stale mirror INSTANTLY", async () => {
    const { rootLoader, paneLoader } = await import("./loaders");
    const { latchLost } = await import("./connection-health");

    // Visit the pane (healthy) so its text is cached, then leave to the dashboard — rootLoader clears
    // the pane discriminator so a RETURN reads as a fresh navigation, not a poll.
    await paneLoader({
      params: { paneId: "w1:p1" },
      request: new Request("http://localhost/pane/w1:p1"),
    });
    await rootLoader({ request: new Request("http://localhost/") });

    latchLost();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const data = await paneLoader({
      params: { paneId: "w1:p1" },
      request: new Request("http://localhost/pane/w1:p1"),
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(data.error).toBe(true);
    expect(data.text).toBe(paneTextWithDraft()); // the stale mirror
  });

  it("polling within a pane during an outage keeps fetching (same url ⇒ revalidation)", async () => {
    const { paneLoader } = await import("./loaders");
    const { latchLost } = await import("./connection-health");

    await paneLoader({
      params: { paneId: "w1:p1" },
      request: new Request("http://localhost/pane/w1:p1"),
    });
    latchLost();

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await paneLoader({
      params: { paneId: "w1:p1" },
      request: new Request("http://localhost/pane/w1:p1"), // same url ⇒ poll ⇒ must fetch
    });
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("does NOT fast-path when the connection is not latched (a brief blip still fetches)", async () => {
    const { rootLoader } = await import("./loaders");
    // No latchLost(): a transient blip must keep really fetching on navigation, not serve stale.
    await rootLoader({ request: new Request("http://localhost/") });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await rootLoader({ request: new Request("http://localhost/space/w1") }); // navigation, but not latched
    expect(fetchSpy).toHaveBeenCalled();
  });
});

// A superseded revalidation aborts the in-flight fetch via request.signal. The loaders must
// RETHROW that AbortError (so React Router discards the stale run) rather than swallow it into the
// stale-data/error-banner branch — otherwise a fast poll would flash a spurious "reconnecting…".
describe("loaders — aborted request", () => {
  function abortedRequest(): Request {
    const controller = new AbortController();
    controller.abort();
    return new Request("http://localhost/", { signal: controller.signal });
  }

  it("rootLoader rethrows the abort instead of returning stale/error data", async () => {
    const { rootLoader } = await import("./loaders");
    await expect(rootLoader({ request: abortedRequest() })).rejects.toThrow();
  });

  it("paneLoader rethrows the abort instead of returning stale/error data", async () => {
    const { paneLoader } = await import("./loaders");
    await expect(
      paneLoader({ params: { paneId: "w1:p1" }, request: abortedRequest() }),
    ).rejects.toThrow();
  });
});

// WebKit (every iPhone browser) rejects a fetch whose AbortSignal.timeout fired with an "AbortError"
// ("Fetch is aborted"), not the "TimeoutError" other engines use. Only the request's own signal
// tells a superseded run from a slow host, so a timeout on a live request must stay stale data
// instead of replacing the open chat with the error screen.
describe("loaders — WebKit-shaped request timeout", () => {
  const liveRequest = (path: string) => new Request(`http://localhost${path}`);
  // WebKit's DOMException is an Error subclass; jsdom's is not, so build the Error it really is.
  const webkitTimeout = () =>
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      Object.assign(new Error("Fetch is aborted"), { name: "AbortError" }),
    );

  it("rootLoader keeps the last good herd", async () => {
    const { rootLoader } = await import("./loaders");
    await rootLoader({ request: liveRequest("/") });
    webkitTimeout();
    const data = await rootLoader({ request: liveRequest("/") });
    expect(data.error).toBe(true);
    expect(data.agents.length).toBeGreaterThan(0);
  });

  it("paneLoader keeps the last good text", async () => {
    const { paneLoader } = await import("./loaders");
    await paneLoader({ params: { paneId: "w1:p1" }, request: liveRequest("/pane/w1:p1") });
    webkitTimeout();
    const data = await paneLoader({ params: { paneId: "w1:p1" }, request: liveRequest("/pane/w1:p1") });
    expect(data.error).toBe(true);
    expect(data.text).toBe(paneTextWithDraft());
  });

  it("historyLoader reports an unavailable history", async () => {
    const { historyLoader } = await import("./loaders");
    webkitTimeout();
    const data = await historyLoader({ params: { paneId: "w1:p1" }, request: liveRequest("/pane/w1:p1") });
    expect(data.unavailable).toBe("error");
  });
});

// historyLoader reads the agent's OWN transcript — the only conversation history a Claude pane can
// have, since its terminal runs on the alternate screen and keeps no scrollback ring. Every
// "unavailable" answer is an ordinary state the view explains, never an error banner.
describe("historyLoader", () => {
  const failHistory = (status: number) =>
    server.use(http.get(/\/api\/pane\/[^/]+\/history/, () => new HttpResponse(null, { status })));

  const unavailable = (reason: string) =>
    server.use(
      http.get(/\/api\/pane\/[^/]+\/history/, () =>
        HttpResponse.json({ paneId: "w1:p1", available: false, reason }),
      ),
    );

  it("returns the newest page of turns", async () => {
    const { historyLoader } = await import("./loaders");
    const data = await historyLoader({ params: { paneId: "w1:p1" } });
    expect(data.unavailable).toBeUndefined();
    expect(data.entries.map((e) => e.uuid)).toEqual(["t1", "t2"]);
    expect(data.total).toBe(2);
    expect(data.hasMore).toBe(false);
  });

  it("asks for a bounded first page rather than the whole transcript", async () => {
    let seen = "";
    server.use(
      http.get(/\/api\/pane\/[^/]+\/history/, ({ request }) => {
        seen = new URL(request.url).searchParams.get("limit") ?? "";
        return HttpResponse.json({
          paneId: "w1:p1",
          available: true,
          entries: [],
          hasMore: false,
          total: 0,
          fileTruncated: false,
        });
      }),
    );
    const { historyLoader, HISTORY_PAGE_SIZE } = await import("./loaders");
    await historyLoader({ params: { paneId: "w1:p1" } });
    expect(seen).toBe(String(HISTORY_PAGE_SIZE));
  });

  it.each([["disabled"], ["no-session"], ["no-log"]])(
    "passes through the %s reason so the view can explain it",
    async (reason) => {
      unavailable(reason);
      const { historyLoader } = await import("./loaders");
      const data = await historyLoader({ params: { paneId: "w1:p1" } });
      expect(data.unavailable).toBe(reason);
      expect(data.entries).toEqual([]);
    },
  );

  it("degrades to an error state (not a throw) when the fetch fails", async () => {
    failHistory(500);
    const { historyLoader } = await import("./loaders");
    const data = await historyLoader({ params: { paneId: "w1:p1" } });
    expect(data.unavailable).toBe("error");
    expect(data.entries).toEqual([]);
  });

  it("throws on a missing :paneId route param (a misconfigured route, not a user state)", async () => {
    const { historyLoader } = await import("./loaders");
    await expect(historyLoader({ params: {} })).rejects.toThrow(/paneId/);
  });

  it("scopes the request to the session in the request url", async () => {
    let seen: string | null = "unset";
    server.use(
      http.get(/\/api\/pane\/[^/]+\/history/, ({ request }) => {
        seen = new URL(request.url).searchParams.get("session");
        return HttpResponse.json({
          paneId: "w1:p1",
          available: true,
          entries: [],
          hasMore: false,
          total: 0,
          fileTruncated: false,
        });
      }),
    );
    const { historyLoader } = await import("./loaders");
    await historyLoader({
      params: { paneId: "w1:p1" },
      request: new Request("http://localhost/pane/w1:p1/history?s=demo"),
    });
    expect(seen).toBe("demo");
  });

  it("rethrows an abort instead of returning an error state", async () => {
    const controller = new AbortController();
    controller.abort();
    const { historyLoader } = await import("./loaders");
    await expect(
      historyLoader({
        params: { paneId: "w1:p1" },
        request: new Request("http://localhost/", { signal: controller.signal }),
      }),
    ).rejects.toThrow();
  });
});

// ── Surviving a cold boot with no network (lib/last-seen.ts) ──────────────────
//
// The case: a phone leaves Nenu for the Tailscale app, the browser DISCARDS the hidden page, and
// the operator comes back before the tunnel is up. The module caches above are gone with the process,
// so everything here re-imports the loaders (a fresh page) and asserts against what a fresh page can
// still read: the write-through cache in sessionStorage.
describe("cold boot with no network", () => {
  const PANE_KEY = "collie:last-pane: w1:p1";
  const SNAPSHOT_KEY = "collie:last-snapshot:";

  it("writes the snapshot through on a successful fetch", async () => {
    const { rootLoader } = await import("./loaders");
    await rootLoader();
    expect(sessionStorage.getItem(SNAPSHOT_KEY)).not.toBeNull();
  });

  it("writes the pane mirror through on a successful fetch", async () => {
    const { paneLoader } = await import("./loaders");
    await paneLoader({ params: { paneId: "w1:p1" } });
    expect(sessionStorage.getItem(PANE_KEY)).toContain("hello from the pane");
  });

  it("renders the cached herd — dated — when a fresh page can't reach the bridge", async () => {
    const warm = await import("./loaders");
    await warm.rootLoader(); // the session before the page was discarded

    // A brand-new page: module caches empty, first fetch fails.
    vi.resetModules();
    failSnapshot();
    const { rootLoader } = await import("./loaders");
    const data = await rootLoader();

    expect(data.error).toBe(true);
    expect(data.bridge).toBe("connected"); // from the restored snapshot
    expect(data.agents).toHaveLength(2);
    expect(data.lastSeenAt).toBeTypeOf("number");
  });

  it("renders the cached pane mirror — dated — on a fresh page", async () => {
    const warm = await import("./loaders");
    await warm.paneLoader({ params: { paneId: "w1:p1" } });

    vi.resetModules();
    failPane();
    const { paneLoader } = await import("./loaders");
    const data = await paneLoader({ params: { paneId: "w1:p1" } });

    expect(data.error).toBe(true);
    expect(data.text).toContain("hello from the pane");
    expect(data.lastSeenAt).toBeTypeOf("number");
  });

  it("says disconnected, not empty, when a fresh page has nothing cached", async () => {
    failSnapshot();
    const { rootLoader } = await import("./loaders");
    const data = await rootLoader();

    // `error` is the flag the empty state keys off: an empty herd here means "we don't know", and
    // no view may read it as "nothing is running".
    expect(data.error).toBe(true);
    expect(data.agents).toEqual([]);
    expect(data.lastSeenAt).toBeUndefined();
  });

  it("keeps the cache per session", async () => {
    const warm = await import("./loaders");
    await warm.rootLoader(); // primary only

    vi.resetModules();
    failSnapshot();
    const { rootLoader } = await import("./loaders");
    const data = await rootLoader({ request: new Request("http://localhost/?s=collie-demo") });
    expect(data.agents).toEqual([]);
    expect(data.lastSeenAt).toBeUndefined();
  });

  it("survives a store that refuses to answer", async () => {
    const boom = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    failSnapshot();
    const { rootLoader } = await import("./loaders");
    const data = await rootLoader();
    expect(data.error).toBe(true);
    expect(data.agents).toEqual([]);
    boom.mockRestore();
  });

  // ADR 0017: recognising a password prompt changes what Nenu says — and this, the one other thing
  // it changes. The pane the operator is answering `sudo` in is not left in the browser's store.
  describe("a pane at a password prompt (ADR 0017)", () => {
    const sudoPane = () =>
      server.use(
        http.get(/\/api\/pane\/[^/]+$/, () =>
          HttpResponse.json({
            paneId: "w1:p1",
            text: "$ sudo -v\n[sudo] password for altan:",
            truncated: false,
            revision: 2,
          }),
        ),
      );

    it("is never written to the cache", async () => {
      sudoPane();
      const { paneLoader } = await import("./loaders");
      await paneLoader({ params: { paneId: "w1:p1" } });
      expect(sessionStorage.getItem(PANE_KEY)).toBeNull();
    });

    it("drops what an earlier read had already cached", async () => {
      const { paneLoader } = await import("./loaders");
      await paneLoader({ params: { paneId: "w1:p1" } }); // ordinary screen, cached
      expect(sessionStorage.getItem(PANE_KEY)).not.toBeNull();

      sudoPane();
      await paneLoader({ params: { paneId: "w1:p1" } });
      expect(sessionStorage.getItem(PANE_KEY)).toBeNull();
    });

    it("still caches the snapshot — the exclusion is the pane's text, not the herd", async () => {
      sudoPane();
      const { paneLoader, rootLoader } = await import("./loaders");
      await paneLoader({ params: { paneId: "w1:p1" } });
      await rootLoader();
      expect(sessionStorage.getItem(SNAPSHOT_KEY)).not.toBeNull();
    });
  });
});

describe("loaders — narrowed revalidation", () => {
  it("a pane-only revalidation hands back the same herd without fetching the snapshot", async () => {
    const { rootLoader, paneLoader } = await import("./loaders");
    const { narrowRevalidation, widenRevalidation } = await import("./revalidation");
    // React Router hands every loader of one run the same Request.
    const run = () => new Request("http://localhost/pane/w1%3Ap1");
    const first = run();
    const home = await rootLoader({ request: first });
    await paneLoader({ params: { paneId: "w1:p1" }, request: first });

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const urls = () => fetchSpy.mock.calls.map(([input]) => String(input instanceof Request ? input.url : input));
    narrowRevalidation("pane");
    const narrowed = run();
    expect(await rootLoader({ request: narrowed })).toBe(home);
    expect(urls().some((url) => url.includes("/api/snapshot"))).toBe(false);
    const pane = await paneLoader({ params: { paneId: "w1:p1" }, request: narrowed });
    expect(urls().some((url) => url.includes("/api/pane/"))).toBe(true);

    widenRevalidation();
    narrowRevalidation("root");
    fetchSpy.mockClear();
    const herdOnly = run();
    await rootLoader({ request: herdOnly });
    expect(await paneLoader({ params: { paneId: "w1:p1" }, request: herdOnly })).toBe(pane);
    expect(urls().some((url) => url.includes("/api/pane/"))).toBe(false);
  });

  it("a revalidation nobody narrowed re-reads both loaders, even one that interrupts a narrowed run", async () => {
    const { createMemoryRouter } = await import("react-router");
    const { narrowRevalidation, needsFetch } = await import("./revalidation");
    const fetched: string[] = [];
    const loader = (scope: "root" | "pane") => ({ request }: { request: Request }) => {
      if (needsFetch(scope, request)) fetched.push(scope);
      return new Promise((resolve) => setTimeout(() => resolve(scope), 5));
    };
    const router = createMemoryRouter(
      [{ path: "/", loader: loader("root"), children: [{ path: "pane/:paneId", loader: loader("pane") }] }],
      { initialEntries: ["/pane/w1%3Ap1"] },
    );
    router.initialize();
    await vi.waitFor(() => expect(router.state.initialized).toBe(true));
    fetched.length = 0;

    narrowRevalidation("pane");
    void router.revalidate();
    // A mutation's own revalidate() lands while the narrowed run is still loading.
    await router.revalidate();
    expect(fetched).toEqual(["pane", "root", "pane"]);
    router.dispose();
  });

  it("a navigation always fetches, narrowed or not", async () => {
    const { rootLoader } = await import("./loaders");
    const { narrowRevalidation } = await import("./revalidation");
    await rootLoader({ request: new Request("http://localhost/") });
    narrowRevalidation("pane");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await rootLoader({ request: new Request("http://localhost/space/w1") });
    expect(fetchSpy).toHaveBeenCalled();
  });
});

// Opening a pane must not wait on its read (SYS-17): the bench held a 6 s read and the tap left Home
// on screen for all of it. A navigation gives the read a moment, then opens the chat on what the page
// already has, and the read lands through the revalidation the route asks for: one read, not two.
describe("loaders — a pane opens before its read lands", () => {
  const slowPane = (text: string, ms: number) => {
    let reads = 0;
    server.use(http.get(/\/api\/pane\/[^/]+$/, async () => {
      reads++;
      await delay(ms);
      return HttpResponse.json({ paneId: "w1:p1", text, truncated: false, revision: 9 });
    }));
    return () => reads;
  };
  const within = <T,>(promise: Promise<T>, ms: number) =>
    Promise.race([promise, new Promise<"late">((resolve) => setTimeout(() => resolve("late"), ms))]);
  // Measured against the navigation's own budget: the read outlasts it well, and the chat opens soon after.
  let slowRead = 0;
  let openBy = 0;
  beforeAll(async () => {
    const { PANE_FIRST_PAINT_MS } = await import("./loaders");
    slowRead = PANE_FIRST_PAINT_MS * 5;
    openBy = PANE_FIRST_PAINT_MS * 3;
  });

  it("opens a pane read before on its last text at once, and the next run brings the fresh read without asking again", async () => {
    const { paneLoader, rootLoader } = await import("./loaders");
    await paneLoader({ params: { paneId: "w1:p1" }, request: new Request("http://localhost/pane/w1:p1") });
    await rootLoader({ request: new Request("http://localhost/") });
    const reads = slowPane("fresh text", slowRead);

    const opened = await within(paneLoader({ params: { paneId: "w1:p1" }, request: new Request("http://localhost/pane/w1:p1") }), openBy);
    expect(opened).not.toBe("late");
    if (opened === "late") return;
    expect(opened.pending).toBe(true);
    expect(opened.text).toBe(paneTextWithDraft());

    const settled = await paneLoader({ params: { paneId: "w1:p1" }, request: new Request("http://localhost/pane/w1:p1") });
    expect(settled.pending).toBeFalsy();
    expect(settled.text).toBe("fresh text");
    expect(reads()).toBe(1);
  });

  it("opens a pane never read on an empty mirror that says it is on its way", async () => {
    const { paneLoader } = await import("./loaders");
    slowPane("fresh text", slowRead);
    const opened = await within(paneLoader({ params: { paneId: "w1:p1" }, request: new Request("http://localhost/pane/w1:p1") }), openBy);
    expect(opened).not.toBe("late");
    if (opened === "late") return;
    expect(opened).toMatchObject({ pending: true, text: "", error: false, revision: 0 });
  });

  // Quick taps on a slow link left one read per pane running to its 10 s timeout. A read the reader
  // walked away from is dropped; the pane they are on keeps its own.
  const paneReads = (fetchSpy: { mock: { calls: Parameters<typeof fetch>[] } }) => fetchSpy.mock.calls
    .filter(([input]) => /\/api\/pane\/[^/?]+(\?|$)/.test(String(input)))
    .map(([input, init]) => ({ pane: decodeURIComponent(String(input).split("/api/pane/")[1]!.split("?")[0]!), signal: init?.signal }));
  const open = async (paneId: string) => {
    const { paneLoader } = await import("./loaders");
    return paneLoader({ params: { paneId }, request: new Request(`http://localhost/pane/${encodeURIComponent(paneId)}`) });
  };

  it("drops the read of a pane the reader left for another, and keeps the one they are on", async () => {
    slowPane("fresh text", slowRead);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await open("w1:p1");
    await open("w2:p1");
    const reads = paneReads(fetchSpy);
    expect(reads.map((read) => read.pane)).toEqual(["w1:p1", "w2:p1"]);
    expect(reads[0]!.signal?.aborted).toBe(true);
    expect(reads[1]!.signal?.aborted).toBe(false);
  });

  it("drops it when the reader leaves the panes altogether, but not for the pane's own history", async () => {
    const { rootLoader } = await import("./loaders");
    slowPane("fresh text", slowRead);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await open("w1:p1");
    await rootLoader({ request: new Request("http://localhost/pane/w1%3Ap1/history") });
    expect(paneReads(fetchSpy)[0]!.signal?.aborted).toBe(false);
    await rootLoader({ request: new Request("http://localhost/") });
    expect(paneReads(fetchSpy)[0]!.signal?.aborted).toBe(true);
  });

  // iOS 16.0 to 17.3 have AbortSignal.timeout but not AbortSignal.any, and there fetchPane can't join
  // a stop with its timeout. The read keeps the 10 s bound rather than the early stop.
  it("keeps the read's timeout on a WebView that can't join two signals", async () => {
    const any = AbortSignal.any;
    Object.defineProperty(AbortSignal, "any", { value: undefined, configurable: true, writable: true });
    onTestFinished(() => { Object.defineProperty(AbortSignal, "any", { value: any, configurable: true, writable: true }); });
    slowPane("fresh text", slowRead);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await open("w1:p1");
    expect(paneReads(fetchSpy)[0]!.signal).toBe(timeout.mock.results[0]!.value);
  });

  it("keeps a quick read on the navigation itself, with nothing pending", async () => {
    const { paneLoader } = await import("./loaders");
    const data = await paneLoader({ params: { paneId: "w1:p1" }, request: new Request("http://localhost/pane/w1:p1") });
    expect(data.pending).toBeFalsy();
    expect(data.text).toBe(paneTextWithDraft());
  });
});

// Opening a pane asks for its chat's conversation beside the pane's own read, and only where the chat
// will read one: on the way into the pane, for an agent Nenu reads, not shown as its raw terminal.
describe("paneLoader's conversation read", () => {
  const counted = () => {
    const reads: string[] = [];
    server.use(http.get("/api/pane/:id/history", ({ params }) => {
      reads.push(String(params.id));
      return HttpResponse.json({ available: true, entries: [], hasMore: false, total: 0, fileTruncated: false });
    }));
    return reads;
  };
  const open = async (paneId: string, search = "") => {
    const { paneLoader } = await import("./loaders");
    await paneLoader({ params: { paneId }, request: new Request(`http://localhost/pane/${encodeURIComponent(paneId)}${search}`) });
  };

  it("starts on the way into an agent's pane, and not when only the search changes", async () => {
    const reads = counted();
    const { rootLoader } = await import("./loaders");
    await rootLoader();
    await open("w1:p1");
    await vi.waitFor(() => expect(reads).toEqual(["w1:p1"]));
    await open("w1:p1", "?view=changes");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads).toEqual(["w1:p1"]);
  });

  it("does not start for a shell, nor for a pane shown as its raw terminal", async () => {
    const reads = counted();
    const { rootLoader } = await import("./loaders");
    const { paneDisplayScope, saveRawTerminal } = await import("./raw-terminal");
    await rootLoader();
    saveRawTerminal(paneDisplayScope(undefined, "w1:p1"), true);
    onTestFinished(() => saveRawTerminal(paneDisplayScope(undefined, "w1:p1"), false));
    await open("w2:p2");
    await open("w1:p1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads).toEqual([]);
  });
});
