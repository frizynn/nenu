import { http, HttpResponse } from "msw";
import { server } from "@/test/setup";
import { fetchHistory } from "./api";
import type { PaneHistoryResponse } from "./types";

const payload = (paneId: string): PaneHistoryResponse => ({
  paneId, available: true, entries: [], total: 0, hasMore: false, fileTruncated: false,
});
const route = /\/api\/pane\/[^/]+\/history$/;

it("returns the exact cached object on a no-body 304", async () => {
  let calls = 0;
  server.use(http.get(route, ({ request }) => {
    calls++;
    if (calls > 1) {
      expect(request.headers.get("if-none-match")).toBe('"same"');
      return new HttpResponse(null, { status: 304, headers: { etag: '"same"' } });
    }
    return HttpResponse.json(payload("cache-same"), { headers: { etag: '"same"' } });
  }));
  const first = await fetchHistory("cache-same", { limit: 60 });
  expect(await fetchHistory("cache-same", { limit: 60 })).toBe(first);
});

it("isolates sessions, panes, limits and older cursors", async () => {
  const headers: Array<string | null> = [];
  server.use(http.get(route, ({ request }) => {
    headers.push(request.headers.get("if-none-match"));
    return HttpResponse.json(payload("scoped"), { headers: { etag: '"scoped"' } });
  }));
  await fetchHistory("scope-a", { limit: 60 }, "one");
  await fetchHistory("scope-a", { limit: 60 }, "two");
  await fetchHistory("scope-b", { limit: 60 }, "one");
  await fetchHistory("scope-a", { limit: 40 }, "one");
  await fetchHistory("scope-a", { limit: 60, before: "older" }, "one");
  expect(headers).toEqual([null, null, null, null, null]);
});

it("auth rejection discards private bodies and refuses an orphan 304", async () => {
  let calls = 0;
  server.use(http.get(route, ({ request }) => {
    calls++;
    if (calls === 1) return HttpResponse.json(payload("auth-cache"), { headers: { etag: '"private"' } });
    if (calls === 2) return new HttpResponse("Forbidden", { status: 403 });
    expect(request.headers.get("if-none-match")).toBeNull();
    return new HttpResponse(null, { status: 304 });
  }));
  await fetchHistory("auth-cache", { limit: 60 });
  await expect(fetchHistory("auth-cache", { limit: 60 })).rejects.toMatchObject({ status: 403 });
  await expect(fetchHistory("auth-cache", { limit: 60 })).rejects.toMatchObject({ status: 304 });
});

it("an aborted request cannot populate the next poll's cache", async () => {
  const controller = new AbortController();
  server.use(http.get(route, () => {
    controller.abort();
    return HttpResponse.json(payload("abort-cache"), { headers: { etag: '"aborted"' } });
  }));
  await expect(fetchHistory("abort-cache", { limit: 60 }, undefined, controller.signal)).rejects.toThrow();
  server.use(http.get(route, ({ request }) => {
    expect(request.headers.get("if-none-match")).toBeNull();
    return HttpResponse.json(payload("abort-cache"));
  }));
  await fetchHistory("abort-cache", { limit: 60 });
});

it.each([200, 304])("does not resurrect history from a delayed %s after another request loses authorization", async (lateStatus) => {
  let call = 0;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  server.use(http.get(route, async ({ request }) => {
    call++;
    if (call === 1) return HttpResponse.json(payload("auth-race"), { headers: { etag: '"private-race"' } });
    if (call === 2) {
      entered(); await pending;
      return lateStatus === 304 ? new HttpResponse(null, { status: 304 }) : HttpResponse.json(payload("auth-race"), { headers: { etag: '"late-private"' } });
    }
    if (call === 3) return new HttpResponse("Forbidden", { status: 403 });
    expect(request.headers.get("if-none-match")).toBeNull();
    return HttpResponse.json(payload("auth-race"));
  }));
  const id = `auth-race-${lateStatus}`;
  await fetchHistory(id, { limit: 60 });
  const old = fetchHistory(id, { limit: 60 });
  await started;
  await expect(fetchHistory("other-auth-request", { limit: 60 })).rejects.toMatchObject({ status: 403 });
  release();
  await expect(old).rejects.toThrow(/authorization changed/);
  await fetchHistory(id, { limit: 60 });
});

it("a slower old success cannot overwrite a newer unavailable response", async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const unavailable: PaneHistoryResponse = { paneId: "ordering", available: false, reason: "no-session" };
  server.use(http.get(route, async ({ request }) => {
    calls++;
    if (calls === 1) {
      entered(); await pending;
      return HttpResponse.json(payload("ordering"), { headers: { etag: '"old-session"' } });
    }
    if (calls === 3) expect(request.headers.get("if-none-match")).toBeNull();
    return HttpResponse.json(unavailable);
  }));
  const old = fetchHistory("ordering", { limit: 60 });
  await started;
  const current = await fetchHistory("ordering", { limit: 60 });
  release();
  expect(await old).toBe(current);
  expect(await fetchHistory("ordering", { limit: 60 })).toEqual(unavailable);
});
