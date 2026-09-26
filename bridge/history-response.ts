import { computeEtag, gzipJsonResponse, notModified } from "./http-cache.ts";
import type { TranscriptPage } from "./journal/types.ts";
import type { PaneHistoryResponse } from "./types.ts";

type Page = Omit<TranscriptPage, "paneId">;
type Representation = { etag: string; data: PaneHistoryResponse };
// Journal pages retain identity until their log changes. A weak cache cannot retain an evicted log.
// Pane id remains part of the representation: two panes can point at one agent session's journal.
const representations = new WeakMap<Page, Map<string, Representation>>();

/** Called only AFTER access checks, live pane resolution, and the contained journal stat/read. */
export function historyResponse(page: Page, paneId: string, ifNoneMatch: string | null, acceptEncoding: string | null, sessionKey?: string): Response {
  let panes = representations.get(page);
  if (!panes) { panes = new Map(); representations.set(page, panes); }
  const key = `${paneId}\0${sessionKey ?? ""}`;
  let representation = panes.get(key);
  if (!representation) {
    const data: PaneHistoryResponse = { paneId, available: true, ...page, ...(sessionKey ? { sessionKey } : {}) };
    representation = { data, etag: computeEtag(JSON.stringify(data)) };
    panes.set(key, representation);
    if (panes.size > 8) panes.delete(panes.keys().next().value!);
  }
  const { etag, data } = representation;
  if (notModified(ifNoneMatch, etag)) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": "no-store" } });
  }
  return gzipJsonResponse(data, acceptEncoding, { etag });
}
