import type { SubagentsResponse, SubagentHistoryResponse } from "./types";
import type { TakenBack } from "./local-sends";
// Thin REST client for the bridge. Everything is same-origin, so credentials/headers are
// minimal. Each call throws on a non-2xx so callers (route loaders / action handlers) surface errors.

import { trackBusy } from "./busy";
import { markLive } from "./connection-health";
import { observeServerBuild, SERVER_BUILD_HEADER } from "./server-build";
import type {
  ActionResponse,
  AnswerOutcome,
  AnswerRequest,
  BridgeConfig,
  CreateResponse,
  DeliveryMode,
  Interaction,
  InterruptResponse,
  MachineView,
  NativeQueueState,
  NotifyPrefs,
  DiffScope,
  PaneDiff,
  PaneHistoryResponse,
  PaneSkillsResponse,
  PaneReadResponse,
  PullRequestView,
  QueueWaitReason,
  SendOutcome,
  SendRequest,
  SnapshotResponse,
  UpdateInfo,
  UploadResponse,
  UsageResponse,
} from "./types";

export type { NotifyPrefs, UpdateInfo };

/**
 * Marks every API request as XHR so a fronting identity proxy answers it with a status we can read.
 *
 * The refusal banner (components/connection-banner.tsx) is reached only through `isAuthError`
 * (lib/loaders.ts), which matches 401/403 on an {@link ApiError}. A proxy that answers an
 * unauthenticated request with a REDIRECT never produces one: `fetch` follows the 302 to the
 * identity provider's origin, that response carries no CORS headers, and the call rejects as a
 * `TypeError` — a transport failure with no status. The user then gets the connection banner
 * ("can't reach Nenu") and, worse, loses the Sign-in link that would have fixed it, since a
 * missing session is precisely the thing it recovers from.
 *
 * Measured against Cloudflare Access with no session: a plain request, `Accept: application/json`
 * and `Sec-Fetch-Mode: cors` all still redirect; only this header flips the answer to a same-origin
 * 401. `X-Requested-With: XMLHttpRequest` is the conventional "this is XHR, don't redirect me"
 * signal rather than one vendor's feature — oauth2-proxy and Authelia read it too — so it stays a
 * single unconditional header with no proxy-specific branching, in keeping with a bridge that gates
 * on vendor-neutral headers and manages nobody else's front door (ADR 0001).
 *
 * Some forward-auth deployments still turn that 401 back into a 3xx at the reverse-proxy layer.
 * Every API fetch therefore uses `redirect: "manual"`; a returned redirect is normalised to a local
 * 401 below so the same refusal banner appears instead of a CORS/transport failure. Nenu never
 * follows or discovers the proxy's login flow itself — the banner's ordinary `/auth/` link remains
 * the operator-owned recovery path.
 *
 * Costs nothing against the bridge itself: it is same-origin by design, so no preflight in practice,
 * and the bridge ignores headers it does not read.
 */
export const XHR_HEADER = "x-requested-with";
export const XHR_HEADER_VALUE = "XMLHttpRequest";

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** True when an API request failed with the given HTTP status. */
export function isApiErrorStatus(error: unknown, status: number): boolean {
  return error instanceof ApiError && error.status === status;
}

/**
 * True when the server answered a request with a definite no (a 4xx other than a timeout), so the
 * write did not happen. A network error, a timeout or a 5xx leaves the outcome unknown: the request
 * may have run before its answer was lost.
 */
export function isDefiniteRefusal(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408;
}

/** What a failed request says to a person: the bridge's `error` when it answered with one, else the transport's own words. */
export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Request failed.";
  const start = error.message.indexOf("{");
  if (start >= 0) {
    try {
      const body: unknown = JSON.parse(error.message.slice(start));
      if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") return body.error;
    } catch {
      // Keep the transport's original message when its response was not JSON.
    }
  }
  return error.message;
}

// Every request gets a deadline so a black-holed connection (phone sleep/wake, a Tailscale route
// that goes dark) can't leave a fetch pending forever — which would zombify the app: the poller
// gates on `revalidator.state === "idle"` and never fires again, and route navigations wait on a
// loader that never settles. On timeout the fetch rejects ("TimeoutError", or "AbortError" in WebKit);
// the loaders rethrow only when their own request was aborted (a superseded revalidation), so a
// timeout falls into their catch → stale-data-with-error, and the poller/nav can retry. Budgets by request class:
//   - GET reads (snapshot/pane polls) are small and frequent — a short leash surfaces a dead link
//     fast so the UI can show "reconnecting…" and retry on the next tick.
const GET_TIMEOUT_MS = 10_000;
//   - Mutations drive a real terminal on the host, which can legitimately take a beat — more slack.
const MUTATION_TIMEOUT_MS = 20_000;
//   - A send waits for a loaded agent's box and log: its pictures until 55 s into the send
//     (bridge/guarded-send.ts PICTURES_BY_MS), then at most three 15 s waits on any path; under
//     Bun's 120 s idle timeout.
const SEND_TIMEOUT_MS = 110_000;
//   - Uploads carry a whole file over the phone's uplink — the most generous budget.
const UPLOAD_TIMEOUT_MS = 60_000;

/**
 * Compose the caller's abort signal (a loader's `request.signal`, used to supersede a stale poll)
 * with a fresh timeout signal, so a fetch aborts on EITHER cause. Returns the timeout signal alone
 * when there's no caller signal. Runtime-guarded: on an older WebView missing `AbortSignal.timeout`
 * or `AbortSignal.any` we return the caller's signal unchanged rather than crash — degrading to the
 * old no-timeout behaviour instead of taking the app down.
 *
 * Exported for unit tests (the timeout wiring is otherwise unobservable).
 */
export function withTimeout(
  signal: AbortSignal | null | undefined,
  ms: number,
): AbortSignal | undefined {
  if (typeof AbortSignal.timeout !== "function") return signal ?? undefined;
  const timeoutSignal = AbortSignal.timeout(ms);
  if (!signal) return timeoutSignal;
  if (typeof AbortSignal.any !== "function") return signal;
  return AbortSignal.any([signal, timeoutSignal]);
}

// Append the `session=<name>` query param to an API path, composing with any query already present
// (fetchPane carries `?lines=`). The browser URL uses the short `?s=`; on the wire it's `session=`.
// Blank / absent session → the primary session, so the path is returned untouched (no param).
function withSession(path: string, session?: string): string {
  const s = session?.trim();
  if (!s) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}session=${encodeURIComponent(s)}`;
}

/** The session's live-invalidation stream (bridge/live-events.ts). */
export function liveEventsUrl(session?: string): string {
  return withSession("/api/events", session);
}

export function paneFileUrl(paneId: string, path: string, session?: string): string {
  return withSession(`/api/pane/${encodeURIComponent(paneId)}/file?path=${encodeURIComponent(path)}`, session);
}

/**
 * A file read the bridge refused. `outside` is the bridge's `x-file-state: outside-project`: the
 * path is beyond the pane's folder and was not delivered by the agent, so retrying cannot help.
 */
export class PaneFileError extends ApiError {
  readonly outside: boolean;
  constructor(message: string, status: number, outside: boolean) {
    super(message, status);
    this.name = "PaneFileError";
    this.outside = outside;
  }
}

/** The refusal a failed /file or /html-preview response describes. */
export async function paneFileError(res: Response): Promise<PaneFileError> {
  return new PaneFileError(refusalMessage(res.status, await errorDetail(res)), res.status,
    res.headers.get("x-file-state") === "outside-project");
}

/** A single-use link to open a file outside the preview (bridge/file-open.ts, ADR 0063). */
export interface FileOpenGrant { url: string; name: string; size: number; type: string }

/**
 * Ask the bridge for a two-minute, single-use link to `path` (absolute, or relative to the pane's
 * folder). A refusal (private, missing, too large) comes back as `{ error }`, not a throw.
 */
export function grantFileOpen(paneId: string, path: string, session?: string): Promise<FileOpenGrant | { error: string }> {
  return req<FileOpenGrant | { error: string }>(withSession("/api/files/grant", session), {
    method: "POST",
    body: JSON.stringify({ paneId, path }),
  }, (status, detail) => {
    if (status < 400 || status >= 500) return null;
    try {
      const body = JSON.parse(detail) as { error?: unknown };
      return typeof body.error === "string" ? { error: body.error } : null;
    } catch {
      return null;
    }
  // The link is the minting Nenu's: on another machine it has to go back there.
  }).then((answer) => ("url" in answer && session ? { ...answer, url: withSession(answer.url, session) } : answer));
}

export async function fetchPaneFile(paneId: string, path: string, session: string | undefined, signal: AbortSignal): Promise<Response> {
  const res = await apiFetch(paneFileUrl(paneId, path, session), {
    signal: withTimeout(signal, UPLOAD_TIMEOUT_MS), cache: "no-store",
    headers: { [XHR_HEADER]: XHR_HEADER_VALUE },
  });
  if (!res.ok) throw await paneFileError(res);
  return res;
}

const STATUS_MESSAGES: Record<number, string> = {
  400: "Nenu couldn't use that request. Refresh and try again.",
  401: "Your sign-in expired. Sign in again.",
  403: "This device isn't allowed to do that.",
  404: "That's no longer there. Refresh and try again.",
  409: "Something changed meanwhile. Refresh and try again.",
  413: "That's too large to send.",
  415: "Nenu can't show this kind of file.",
  429: "Too many requests. Wait a moment and try again.",
};

/**
 * A refusal as the operator reads it: the bridge's own sentence when its JSON body carries one
 * (`{ error }`), else what the status means. Never the route, the status code or a raw body.
 */
function refusalMessage(status: number, detail: string): string {
  try {
    const body: unknown = JSON.parse(detail);
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string" && body.error.trim()) return body.error;
  } catch {
    // Not JSON: the status speaks for it.
  }
  return STATUS_MESSAGES[status] ?? (status >= 500 ? "Nenu couldn't finish that. Try again in a moment." : "Nenu refused that request. Refresh and try again.");
}

async function apiError(res: Response): Promise<ApiError> {
  return new ApiError(refusalMessage(res.status, await errorDetail(res)), res.status);
}

// The response body if present, else the status text.
async function errorDetail(res: Response): Promise<string> {
  try {
    return (await res.text()) || res.statusText;
  } catch {
    return res.statusText;
  }
}

// `redirect: "manual"` is intentionally local to the API client rather than a global fetch patch.
// Browsers expose a manual redirect as `opaqueredirect` (status 0); test/runtime implementations may
// expose the actual 3xx. Nenu's own API has no redirect contract, and 304 is a normal pane ETag hit,
// so only these redirect statuses are authentication-front-door territory.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function normaliseProxyRedirect(res: Response): Response {
  if (res.type !== "opaqueredirect" && !REDIRECT_STATUSES.has(res.status)) return res;
  return new Response("fronting identity proxy requires sign-in", {
    status: 401,
    statusText: "Unauthorized",
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return normaliseProxyRedirect(await fetch(input, { ...init, redirect: "manual" }));
}

/**
 * The recover handler for the two endpoints that accept `expected_prompt`: reply and keys. A
 * rejected binding is their normal answer, not a transport failure. The bridge refuses the write
 * because the prompt moved, and the caller renders "the dialog changed". Both must share it, or one
 * of them starts throwing where the other returns a value.
 */
const recoverPromptChanged = (status: number, detail: string): ActionResponse | null =>
  status === 409 ? promptChangedResponse(detail) : null;

function promptChangedResponse(detail: string): ActionResponse | null {
  try {
    const body = JSON.parse(detail) as {
      ok?: unknown;
      code?: unknown;
      error?: unknown;
    };
    if (
      body.ok === false &&
      body.code === "prompt_changed" &&
      typeof body.error === "string"
    ) {
      return { ok: false, error: body.error, code: "prompt_changed" };
    }
  } catch {
    // A non-JSON error body follows the existing ApiError path below.
  }
  return null;
}

// Capture the bridge's build id off any response that carries it. Every poll (snapshot/pane) — and
// config + mutations — funnels through the two fetch sites below, so the store stays current for
// free, powering the no-service-worker self-updater (lib/self-update.ts). Absent header (older
// bridge) → no-op, so nothing activates.
function captureBuild(res: Response): void {
  observeServerBuild(res.headers.get(SERVER_BUILD_HEADER));
}

/**
 * Lets ONE caller claim a non-ok response instead of having it thrown. The transport stays generic:
 * it knows a caller may recognise a refusal and turn it into a normal value, but nothing about which
 * status or which body shape. Return null to fall through to the usual {@link ApiError}.
 */
type Recover<T> = (status: number, detail: string) => T | null;

async function doReq<T>(path: string, init?: RequestInit, recover?: Recover<T>, timeoutOverride?: number): Promise<T> {
  // GET reads get the short leash; anything mutating gets the longer mutation budget.
  const method = init?.method?.toUpperCase() ?? "GET";
  const timeoutMs = timeoutOverride ?? (method === "GET" ? GET_TIMEOUT_MS : MUTATION_TIMEOUT_MS);
  const res = await apiFetch(path, {
    ...init,
    signal: withTimeout(init?.signal, timeoutMs),
    headers: {
      "content-type": "application/json",
      [XHR_HEADER]: XHR_HEADER_VALUE,
      ...init?.headers,
    },
  });
  captureBuild(res);
  if (!res.ok) {
    const detail = await errorDetail(res);
    const recovered = recover?.(res.status, detail);
    if (recovered !== null && recovered !== undefined) return recovered;
    throw new ApiError(refusalMessage(res.status, detail), res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// Every mutating request (non-GET) feeds the app-wide busy signal so the top progress bar shows
// while it's in flight; GET reads (snapshot/config polling) don't, or the bar would never rest.
// trackBusy increments synchronously, so a caller sees `isBusy()` true the instant it fires.
function req<T>(path: string, init?: RequestInit, recover?: Recover<T>, timeoutOverride?: number): Promise<T> {
  const op = doReq<T>(path, init, recover, timeoutOverride);
  const method = init?.method?.toUpperCase() ?? "GET";
  return method === "GET" ? op : trackBusy(op);
}

// The last snapshot per session with its ETag, under the same two invariants as the pane cache below.
// The bridge answers an unchanged herd 304, and the caller then gets this very object back.
const snapshotCache = new Map<string, { etag: string; snap: SnapshotResponse }>();

export async function fetchSnapshot(
  session?: string,
  signal?: AbortSignal,
): Promise<SnapshotResponse> {
  const cached = snapshotCache.get(session ?? "");
  const res = await apiFetch(withSession("/api/snapshot", session), {
    signal: withTimeout(signal, GET_TIMEOUT_MS),
    headers: { [XHR_HEADER]: XHR_HEADER_VALUE, ...(cached ? { "if-none-match": cached.etag } : {}) },
  });
  captureBuild(res);
  let snap: SnapshotResponse;
  if (res.status === 304 && cached) snap = cached.snap;
  else {
    if (!res.ok) throw await apiError(res);
    snap = (await res.json()) as SnapshotResponse;
    const etag = res.headers.get("etag");
    if (etag) snapshotCache.set(session ?? "", { etag, snap });
  }
  // A snapshot whose herd link is UP is a provably-live moment — stamp the shared connection-health
  // anchor so escalation is measured from here. A snapshot that 200s but reports `bridge:
  // "disconnected"` is NOT live (the pill/banner still escalate on it), so it must NOT reset the
  // clock, or the "Herdr is down" escalation could never surface.
  if (snap.bridge !== "disconnected") markLive();
  return snap;
}

// The last pull request list per session with its ETag, under the snapshot cache's invariants.
const pullRequestCache = new Map<string, { etag: string; list: PullRequestView[] }>();
const NO_PULL_REQUESTS: PullRequestView[] = [];
// The herd waits for this read when the list moved, so it gives up sooner than other reads; the list on
// screen stays until the next try.
const PULL_REQUESTS_TIMEOUT_MS = 4_000;

/**
 * The session's open pull requests at the version `etag` a snapshot named. The same list object comes
 * back while the version holds, without a request; a snapshot with no version has none to show.
 */
export async function fetchPullRequests(
  session: string | undefined,
  etag: string | undefined,
  signal?: AbortSignal,
): Promise<PullRequestView[]> {
  if (etag === undefined) return NO_PULL_REQUESTS;
  const cached = pullRequestCache.get(session ?? "");
  if (cached?.etag === etag) return cached.list;
  const res = await apiFetch(withSession("/api/pull-requests", session), {
    signal: withTimeout(signal, PULL_REQUESTS_TIMEOUT_MS),
    headers: { [XHR_HEADER]: XHR_HEADER_VALUE, ...(cached ? { "if-none-match": cached.etag } : {}) },
  });
  if (res.status === 304 && cached) return cached.list;
  if (!res.ok) throw await apiError(res);
  const list = (await res.json()) as PullRequestView[];
  const current = res.headers.get("etag");
  if (current) pullRequestCache.set(session ?? "", { etag: current, list });
  return list;
}

// Per-pane cache of the last ETag AND the body it belongs to, kept together on purpose. We send
// If-None-Match on the next poll to skip re-transferring unchanged scrollback; on a 304 we return
// the cached body (with its text) so the mirror stays populated. Two invariants make this safe:
//   1. The ETag is recorded ONLY together with its response — never on its own.
//   2. It is recorded only AFTER the body parses successfully, so a transient parse/abort (e.g. a
//      bridge restart truncating an in-flight read) can't leave an ETag with no text behind — which
//      would otherwise make every later poll 304 into an empty mirror (a permanent blank pane).
// Entirely client-managed — we never rely on the browser HTTP cache (the server sends
// cache-control: no-store for privacy). Module-scoped, so it lives for the page's lifetime.
interface PaneCacheEntry {
  etag: string;
  response: PaneReadResponse;
}
const paneCache = new Map<string, PaneCacheEntry>();
// Bound the cache so it can't grow forever across a long session of opening many panes. Evict the
// oldest (insertion-order) entry beyond the cap — a plain FIFO is fine here (each entry is one
// pane's last body). 20 comfortably covers any panes in flight on a phone.
const PANE_CACHE_MAX = 20;

export async function fetchPane(
  paneId: string,
  lines?: number,
  session?: string,
  signal?: AbortSignal,
): Promise<PaneReadResponse> {
  const q = lines ? `?lines=${lines}` : "";
  const url = withSession(`/api/pane/${encodeURIComponent(paneId)}${q}`, session);
  // Pane ids are per-session (each session is a separate Herdr server), so the ETag/body cache must
  // be keyed by session too — otherwise a "w1:p1" in one session would 304 into another's mirror.
  const cacheKey = `${session ?? ""}\u0000${paneId}`;

  const cached = paneCache.get(cacheKey);
  // SEEN_HEADER is what tells the bridge this read came from our own page and may mark the pane
  // seen. A cross-site no-cors GET can't set a custom header, so it can't clear your alerts by
  // guessing pane ids (bridge/routes/index.ts → marksPaneSeen).
  const headers: Record<string, string> = {
    "x-collie-seen": "1",
    [XHR_HEADER]: XHR_HEADER_VALUE,
  };
  if (cached) headers["if-none-match"] = cached.etag;

  const res = await apiFetch(url, { signal: withTimeout(signal, GET_TIMEOUT_MS), headers });
  captureBuild(res); // pane polls carry the build header too (incl. 304s) — keep the store fresh

  if (res.status === 304 && cached) {
    // Unchanged — hand back the cached body (text included) so the mirror keeps its content. An
    // unchanged poll is still a live poll: stamp the connection-health anchor (a 304 counts as live).
    markLive();
    return { ...cached.response, notModified: true };
  }

  if (!res.ok) throw await apiError(res);

  // Parse the body BEFORE recording the ETag, so the cache only ever holds an (etag, text) pair
  // that actually arrived intact.
  const data = (await res.json()) as PaneReadResponse;
  const etag = res.headers.get("etag");
  if (etag) {
    paneCache.set(cacheKey, { etag, response: data });
    if (paneCache.size > PANE_CACHE_MAX) {
      const oldest = paneCache.keys().next().value;
      if (oldest !== undefined) paneCache.delete(oldest);
    }
  }

  // A pane body served from Herdr is provably-live data — stamp the connection-health anchor.
  markLive();
  return data;
}

/**
 * Fetch a page of the pane's conversation history — the scrollback its terminal can't hold (a Claude
 * pane runs on the alternate screen, which has no scrollback ring). Newest-anchored: no cursor gives
 * the most recent turns; `before` walks backwards from a turn already on screen.
 *
 * Small live windows use a bounded memory-only ETag cache. Full history and older pages are not
 * retained here; the history route owns those larger bodies. HTTP storage stays disabled.
 */
export function fetchModelCatalog(paneId: string, session?: string, signal?: AbortSignal): Promise<{ available: boolean; models: Array<{ name: string; description: string }>; source?: string }> {
  return req(withSession(`/api/pane/${encodeURIComponent(paneId)}/models`, session), { signal });
}

export function fetchSkills(paneId: string, session?: string, signal?: AbortSignal): Promise<PaneSkillsResponse> {
  return req<PaneSkillsResponse>(withSession(`/api/pane/${encodeURIComponent(paneId)}/skills`, session), { signal });
}

const historyCache = new Map<string, { etag: string | null; response: PaneHistoryResponse; sequence: number }>();
let historySequence = 0;
let historyAuthEpoch = 0;

/** The newest turns a chat reads on open and on every poll after (use-live-conversation.ts). */
export const CONVERSATION_WINDOW = 60;
// A chat's first read started before the chat mounts (its pane's loader), so the chat's first read takes
// it over instead of asking only after its first render. Taken once, only while fresh, and never across a
// change of read access.
const warmHistory = new Map<string, { at: number; read: Promise<PaneHistoryResponse> }>();
const WARM_MS = 4_000;

/** Start reading a pane's newest conversation window now, for its chat's first read to take over. */
export function warmConversation(paneId: string, session?: string): void {
  const url = historyUrl(paneId, { limit: CONVERSATION_WINDOW }, session);
  const warm = warmHistory.get(url);
  if (warm && Date.now() - warm.at < WARM_MS) return;
  const read = fetchHistory(paneId, { limit: CONVERSATION_WINDOW }, session);
  read.catch(() => {});
  warmHistory.delete(url);
  warmHistory.set(url, { at: Date.now(), read });
  if (warmHistory.size > 8) warmHistory.delete(warmHistory.keys().next().value!);
}

/**
 * The read `warmConversation` started for this pane, for a chat's first read only: undefined when there
 * is none or it is older than WARM_MS (a change of read access clears them all). Given up when `signal` aborts.
 */
export function takeWarmConversation(paneId: string, session: string | undefined, signal?: AbortSignal): Promise<PaneHistoryResponse> | undefined {
  const url = historyUrl(paneId, { limit: CONVERSATION_WINDOW }, session);
  const warm = warmHistory.get(url);
  warmHistory.delete(url);
  if (!warm || Date.now() - warm.at >= WARM_MS) return undefined;
  return untilAborted(warm.read, signal);
}

function historyUrl(paneId: string, opts: { limit?: number; before?: string }, session: string | undefined): string {
  const q = new URLSearchParams();
  if (opts.limit) q.set("limit", String(opts.limit));
  if (opts.before) q.set("before", opts.before);
  const qs = q.toString();
  return withSession(`/api/pane/${encodeURIComponent(paneId)}/history${qs ? `?${qs}` : ""}`, session);
}

/** `read`, given up as soon as `signal` aborts; the read itself runs on for whoever else holds it. */
function untilAborted<T>(read: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return read;
  if (signal.aborted) return Promise.reject(signal.reason);
  return Promise.race([read, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
}

export async function fetchHistory(
  paneId: string,
  opts: { limit?: number; before?: string } = {},
  session?: string,
  signal?: AbortSignal,
): Promise<PaneHistoryResponse> {
  const url = historyUrl(paneId, opts, session);
  const cacheable = opts.limit !== undefined && opts.limit > 0 && opts.limit <= 120 && !opts.before;
  const sequence = ++historySequence;
  const authEpoch = historyAuthEpoch;
  const assertCurrentAuthorization = () => {
    if (authEpoch !== historyAuthEpoch) throw new ApiError("History authorization changed during this request; retry", 401);
  };
  const cached = cacheable ? historyCache.get(url) : undefined;
  const headers: Record<string, string> = { "x-collie-seen": "1", [XHR_HEADER]: XHR_HEADER_VALUE };
  if (cached?.etag) headers["if-none-match"] = cached.etag;
  const requestSignal = withTimeout(signal, GET_TIMEOUT_MS);
  const res = await apiFetch(url, { signal: requestSignal, headers, cache: "no-store" });
  captureBuild(res);
  // A superseded pane must never populate the cache, even if a transport delivered after abort.
  requestSignal?.throwIfAborted();
  if (res.status === 304 && cached?.etag) {
    assertCurrentAuthorization();
    return historyCache.get(url)?.response ?? cached.response;
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      historyAuthEpoch++;
      historyCache.clear();
      warmHistory.clear();
    } else assertCurrentAuthorization();
    throw await apiError(res);
  }
  assertCurrentAuthorization();
  const data = await res.json() as PaneHistoryResponse;
  requestSignal?.throwIfAborted();
  assertCurrentAuthorization();
  if (cacheable) {
    const newer = historyCache.get(url);
    if (newer && newer.sequence > sequence) return newer.response;
    // Keep the latest response even without a validator, to stop an older overlapping success
    // reviving a superseded page. Only a valid available-page ETag can drive a conditional GET.
    const etag = data.available ? res.headers.get("etag") : null;
    historyCache.set(url, { etag, response: data, sequence });
    if (historyCache.size > 8) historyCache.delete(historyCache.keys().next().value!);
  }
  return data;
}

export function sendReply(
  paneId: string,
  text: string,
  submit = true,
  session?: string,
  expectedPrompt?: string,
  requestId?: string,
  paste?: boolean,
): Promise<ActionResponse> {
  return req<ActionResponse>(
    withSession(`/api/pane/${encodeURIComponent(paneId)}/reply`, session),
    {
      method: "POST",
      body: JSON.stringify({
        text,
        submit,
        ...(expectedPrompt !== undefined ? { expected_prompt: expectedPrompt } : {}),
        ...(requestId !== undefined ? { request_id: requestId } : {}),
        ...(paste ? { paste: true } : {}),
      }),
    },
    recoverPromptChanged,
  );
}

/**
 * The whole guarded send in one request: the bridge types, verifies and submits (or queues, per
 * `deliveryMode`). A refused send is an answer, not a transport failure: the bridge replies with a
 * SendOutcome body on its error status, and that body is returned instead of thrown.
 */
export function sendMessage(paneId: string, request: SendRequest, session?: string): Promise<SendOutcome> {
  return req<SendOutcome>(
    withSession(`/api/pane/${encodeURIComponent(paneId)}/send`, session),
    { method: "POST", body: JSON.stringify(request) },
    (_status, detail) => refusedSend(detail),
    SEND_TIMEOUT_MS,
  );
}

function refusedSend(detail: string): SendOutcome | null {
  try {
    const body = JSON.parse(detail) as Partial<Extract<SendOutcome, { ok: false }>>;
    if (body.ok === false && typeof body.error === "string" && typeof body.stage === "string") return body as SendOutcome;
  } catch {
    // A non-JSON error body follows the usual ApiError path.
  }
  return null;
}

/** Every pane's detected dialog in this session (bridge/interactions.ts). */
export function fetchInteractions(session?: string, signal?: AbortSignal): Promise<{ interactions: Interaction[] }> {
  return req(withSession("/api/interactions", session), { signal });
}

/**
 * Answer a pane's dialog by option. The bridge re-reads the screen and refuses a stale signature, so
 * a card that outlived its dialog gets `interaction_changed` back rather than pressing a key.
 */
export function answerInteraction(paneId: string, answer: AnswerRequest, session?: string): Promise<AnswerOutcome> {
  return req<AnswerOutcome>(
    withSession(`/api/interactions/${encodeURIComponent(paneId)}/answer`, session),
    { method: "POST", body: JSON.stringify(answer) },
    (status, detail) => (status === 409 ? refusedAnswer(detail) : null),
  );
}

function refusedAnswer(detail: string): AnswerOutcome | null {
  try {
    const body = JSON.parse(detail) as { ok?: unknown; error?: unknown };
    if (body.ok === false && typeof body.error === "string") return body as AnswerOutcome;
  } catch {
    // A non-JSON error body follows the usual ApiError path.
  }
  return null;
}

/** An image the pane's journal holds inline, addressed by entry and index — never by path. */
export function journalImageUrl(paneId: string, entry: string, index: number, session?: string): string {
  return withSession(`/api/pane/${encodeURIComponent(paneId)}/journal-image?entry=${encodeURIComponent(entry)}&n=${index}`, session);
}

export function sendKeys(
  paneId: string,
  keys: string[],
  session?: string,
  expectedPrompt?: string,
): Promise<ActionResponse> {
  return req<ActionResponse>(
    withSession(`/api/pane/${encodeURIComponent(paneId)}/keys`, session),
    {
      method: "POST",
      body: JSON.stringify({
        keys,
        ...(expectedPrompt !== undefined ? { expected_prompt: expectedPrompt } : {}),
      }),
    },
    recoverPromptChanged,
  );
}

/** Paste a file Nenu saved (`uploadImage`) into the pane while typing into it: its path, as the terminal takes a paste. */
export function pasteFile(paneId: string, path: string, session?: string): Promise<ActionResponse> {
  return req<ActionResponse>(withSession(`/api/pane/${encodeURIComponent(paneId)}/paste-file`, session), {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

/**
 * Act on the agent's input box while it still holds `draft`: take it over into the composer (ADR
 * 0112), discard it, or send it with Enter (ADR 0114).
 */
export function settleTerminalDraft(paneId: string, draft: string, session: string | undefined, action: "take" | "discard" | "send"): Promise<ActionResponse> {
  return req<ActionResponse>(withSession(`/api/pane/${encodeURIComponent(paneId)}/clear-draft`, session), {
    method: "POST",
    body: JSON.stringify({ draft, action }),
  });
}

/**
 * Take back what waits in the agent's own queue (ADR 0118): the bridge pulls it into the agent's box,
 * reads it, clears the box and recalls the rows it held, and answers with the words and those rows.
 */
export function takeBackQueue(paneId: string, session: string | undefined): Promise<({ ok: true } & Pick<TakenBack, "text"> & Partial<TakenBack>) | { ok: false; error: string }> {
  return req(withSession(`/api/pane/${encodeURIComponent(paneId)}/take-back`, session), { method: "POST", body: "{}" });
}

/**
 * Stop the agent's running turn (ADR 0066). The bridge picks the CLI's key and presses it only while
 * the live screen shows a turn; `confirm` accepts that the CLI sends its queued messages on stopping.
 */
export function interruptPane(paneId: string, session?: string, confirm = false): Promise<InterruptResponse> {
  return req<InterruptResponse>(
    withSession(`/api/pane/${encodeURIComponent(paneId)}/interrupt`, session),
    { method: "POST", body: JSON.stringify(confirm ? { confirm } : {}) },
  );
}

/** Close a pane ("kill the agent"). */
export function closePane(paneId: string, session?: string): Promise<ActionResponse> {
  return req<ActionResponse>(withSession(`/api/pane/${encodeURIComponent(paneId)}/close`, session), {
    method: "POST",
  });
}

/** Set (or clear) a pane's label. An empty/blank `label` clears it (the bridge sends `null` on). */
export function renamePane(
  paneId: string,
  label: string,
  session?: string,
): Promise<ActionResponse> {
  return req<ActionResponse>(withSession(`/api/pane/${encodeURIComponent(paneId)}/rename`, session), {
    method: "POST",
    body: JSON.stringify({ label }),
  });
}

/** Set a tab's label. Non-empty required — a tab has no "clear" (the bridge 400s a blank label). */
export function renameTab(
  tabId: string,
  label: string,
  session?: string,
): Promise<ActionResponse> {
  return req<ActionResponse>(withSession(`/api/tab/${encodeURIComponent(tabId)}/rename`, session), {
    method: "POST",
    body: JSON.stringify({ label }),
  });
}

/** Close a tab, killing every pane inside it. */
export function closeTab(tabId: string, session?: string): Promise<ActionResponse> {
  return req<ActionResponse>(withSession(`/api/tab/${encodeURIComponent(tabId)}/close`, session), {
    method: "POST",
  });
}

/** Move a tab within its space so it sits before `before` (null: last). The bridge resolves the
 *  anchor against Herdr's order when it writes, so a poll-old order can't misplace it. */
export function moveTab(tabId: string, before: string | null, session?: string): Promise<ActionResponse> {
  return req<ActionResponse>(withSession(`/api/tab/${encodeURIComponent(tabId)}/move`, session), {
    method: "POST",
    body: JSON.stringify({ before }),
  });
}

/** Create a new tab in a space, opening a fresh shell pane. `cwd` omitted = inherits the space dir. */
export function createTab(
  workspaceId: string,
  opts: { label?: string; cwd?: string } = {},
  session?: string,
): Promise<CreateResponse> {
  return req<CreateResponse>(withSession("/api/tab", session), {
    method: "POST",
    body: JSON.stringify({ workspaceId, ...opts }),
  });
}

/** `permission` is a choice from the bridge's table (lib/spawn's PERMISSIONS); omitted = the CLI's default. */
export function startAgent(paneId: string, agent: "codex" | "claude", session?: string, permission?: string): Promise<ActionResponse> {
  return req<ActionResponse>(withSession(`/api/pane/${encodeURIComponent(paneId)}/start`, session), {
    method: "POST", body: JSON.stringify({ agent, permission }),
  });
}

/** Folder names under the bridge host's home directory, for the new-chat picker. */
export interface HomeDirs { path: string; home: string; entries: string[]; truncated: boolean }
export function fetchHomeDirs(path: string, hidden: boolean, signal?: AbortSignal, session?: string): Promise<HomeDirs> {
  return doReq(withSession(`/api/dirs?path=${encodeURIComponent(path)}${hidden ? "&hidden=1" : ""}`, session), { signal });
}

/** Create a new space (workspace) with a fresh shell pane. `cwd` omitted = the host's home dir. */
export function createWorkspace(
  opts: { label?: string; cwd?: string } = {},
  session?: string,
): Promise<CreateResponse> {
  return req<CreateResponse>(withSession("/api/workspace", session), {
    method: "POST",
    body: JSON.stringify(opts),
  });
}

export function fetchConfig(): Promise<BridgeConfig> {
  return req<BridgeConfig>("/api/config");
}

/**
 * Set (or clear) the global notification snooze. `snoozedUntil` is an epoch-ms deadline; `null`
 * resumes immediately. Affects every device — it's a quiet-hours switch, not a per-device toggle.
 */
export function setSnooze(snoozedUntil: number | null): Promise<{ snoozedUntil: number | null }> {
  return req<{ snoozedUntil: number | null }>("/api/notifications/snooze", {
    method: "POST",
    body: JSON.stringify({ snoozedUntil }),
  });
}

/** Settings → other machines: whether this Nenu shows them, and Herdr's saved machines with their state. */
export interface MachineSettings {
  on: boolean;
  machines: MachineView[];
}

export function getMachineSettings(): Promise<MachineSettings> {
  return req<MachineSettings>("/api/machines");
}

/** Bridge-wide: on, the bridge dials every machine Herdr saved; off, it dials none. */
export function setMachinesOn(on: boolean): Promise<MachineSettings> {
  return req<MachineSettings>("/api/machines", { method: "POST", body: JSON.stringify({ on }) });
}

/**
 * Settings → Usage (bridge/usage/). Bridge-wide, off by default. A read may start a scan of only the
 * new log lines when the last one is over a minute old; `fresh` starts one regardless, and `account`
 * narrows the numbers to one account while Split by account is on.
 */
export function getUsage(account?: string, fresh?: boolean): Promise<UsageResponse> {
  const query = [account && `account=${encodeURIComponent(account)}`, fresh && "fresh=1"].filter(Boolean).join("&");
  return req<UsageResponse>(`/api/usage${query && `?${query}`}`);
}

export function setUsage(patch: { on?: boolean; splitByAccount?: boolean }): Promise<UsageResponse> {
  return req<UsageResponse>("/api/usage", { method: "POST", body: JSON.stringify(patch) });
}

/** Fetch the bridge-wide notification-type preferences (which agent statuses push). */
export function getNotifyPrefs(): Promise<NotifyPrefs> {
  return req<NotifyPrefs>("/api/notifications/prefs");
}

/**
 * Update the notification-type preferences with a partial patch (only the keys you send change).
 * Bridge-wide — it affects every device, like the snooze. Returns the merged prefs.
 */
export function setNotifyPrefs(patch: Partial<NotifyPrefs>): Promise<NotifyPrefs> {
  return req<NotifyPrefs>("/api/notifications/prefs", {
    method: "POST",
    body: JSON.stringify(patch),
  });
}

/**
 * Force an immediate upstream update check and return the fresh UpdateInfo. Read-level gated (same
 * auth basis as the prefs/snooze POSTs) and takes no body. The bridge otherwise only checks every
 * few hours, so this can take a beat — it rides the mutation timeout budget like the other POSTs.
 */
export function checkForUpdates(): Promise<UpdateInfo> {
  return req<UpdateInfo>("/api/update/check", { method: "POST" });
}

/**
 * Upload an image; the bridge saves it to a host file and returns the path to reference in a
 * message. Uses multipart/form-data (NOT the JSON `req` helper — the browser sets the boundary).
 */
export function uploadImage(paneId: string, file: File, session?: string): Promise<UploadResponse> {
  // Multipart, so it bypasses `req` (the browser sets the boundary) — track it explicitly instead.
  return trackBusy(
    (async () => {
      const fd = new FormData();
      fd.append("file", file);
      const res = await apiFetch(withSession(`/api/pane/${encodeURIComponent(paneId)}/upload`, session), {
        method: "POST",
        body: fd,
        // No content-type: the browser sets the multipart boundary. The XHR marker still applies —
        // an upload refused by a lapsed proxy session must surface as a status, not a redirect.
        headers: { [XHR_HEADER]: XHR_HEADER_VALUE },
        signal: withTimeout(undefined, UPLOAD_TIMEOUT_MS),
      });
      if (!res.ok) throw await apiError(res);
      return (await res.json()) as UploadResponse;
    })(),
  );
}

export function fetchConversations(paneId: string, session?: string, signal?: AbortSignal): Promise<{ conversations: Array<{ id: string; title: string }> }> {
  return req(withSession(`/api/pane/${encodeURIComponent(paneId)}/conversations`, session), { signal });
}

export function connectConversation(paneId: string, id: string, session?: string): Promise<ActionResponse> {
  return req(withSession(`/api/pane/${encodeURIComponent(paneId)}/connect`, session), { method: "POST", body: JSON.stringify({ id }) });
}

export function fetchSubagents(paneId: string, session?: string, signal?: AbortSignal): Promise<SubagentsResponse> {
  return doReq(withSession(`/api/pane/${encodeURIComponent(paneId)}/subagents`, session), { signal });
}
export function fetchSubagentHistory(paneId: string, id: string, session?: string, signal?: AbortSignal): Promise<SubagentHistoryResponse> {
  return doReq(withSession(`/api/pane/${encodeURIComponent(paneId)}/subagent-history?id=${encodeURIComponent(id)}`, session), { signal });
}

export interface ProjectFilesPage { path: string; files: Array<{ name: string; path: string; kind: "file" | "directory"; size: number; updatedAt: string }>; truncated: boolean }
export function fetchProjectFiles(paneId: string, path: string, session?: string, signal?: AbortSignal): Promise<ProjectFilesPage> {
  return doReq(withSession(`/api/pane/${encodeURIComponent(paneId)}/files?path=${encodeURIComponent(path)}`, session), { signal });
}

export interface QueueMessage {
  id: string;
  text: string;
  state: "queued" | "sending" | "paused";
  createdAt: number;
  revision: number;
  error?: string;
  deliveryMode?: DeliveryMode;
  /** Why the row is still waiting, e.g. a dialog the operator has to answer first. */
  waitingFor?: QueueWaitReason;
  /** With `limit`: when the usage limit holding it resets (epoch ms). */
  until?: number;
  /** The row's pane or conversation went away; it waits for the operator. */
  stranded?: { reason: string; since: number };
  native?: NativeQueueState;
  /** The device that queued it. */
  device?: string | null;
}
export type MessageQueuePage = { available: false; messages: [] } | { available: true; scope: string; messages: QueueMessage[] };
export function fetchMessageQueue(paneId: string, session?: string, signal?: AbortSignal): Promise<MessageQueuePage> {
  return doReq(withSession(`/api/pane/${encodeURIComponent(paneId)}/queue`,session),{signal});
}
export function changeMessageQueue(paneId:string, body:{scope:string;action:"add"|"edit"|"remove"|"send";id:string;text?:string;revision?:number;deliveryMode?:DeliveryMode},session?:string):Promise<MessageQueuePage>{
  return req(withSession(`/api/pane/${encodeURIComponent(paneId)}/queue`,session),{method:"POST",body:JSON.stringify(body)});
}

/**
 * Where a file name in the chat leads (bridge/artifact-metadata.ts): `preview` opens in the viewer,
 * `outside` only through the confirmed Open, `missing` reaches nothing. `resolved` is the absolute
 * file when the name alone would not find it.
 */
export type ArtifactMetadata = { path: string } & (
  | { state: "preview"; resolved?: string; designboard?: string }
  | { state: "outside"; resolved?: string }
  | { state: "missing" });
export function fetchArtifactMetadata(paneId: string, paths: string[], session?: string, signal?: AbortSignal): Promise<ArtifactMetadata[]> {
  const query = new URLSearchParams();
  paths.forEach(path => query.append("inspect", path));
  return doReq(withSession(`/api/pane/${encodeURIComponent(paneId)}/files?${query}`, session), { signal });
}

/**
 * What pull request `pr` of `repo` (`owner/name`) changes, read from the pane's folder
 * (bridge/pane-diff.ts); asked for when the viewer opens. `repo` tells a fork's PR from its upstream's.
 */
export function fetchPaneDiff(paneId: string, pr: number, repo: string | undefined, session?: string, signal?: AbortSignal): Promise<PaneDiff> {
  const query = new URLSearchParams({ pr: String(pr), ...(repo ? { repo } : {}) });
  return doReq(withSession(`/api/pane/${encodeURIComponent(paneId)}/diff?${query}`, session), { signal });
}

/** What the pane's session changed, `scope` deep, with or without a pull request (bridge/pane-diff.ts `sessionDiff`). */
export function fetchSessionDiff(paneId: string, scope: DiffScope, session?: string, signal?: AbortSignal): Promise<PaneDiff> {
  return doReq(withSession(`/api/pane/${encodeURIComponent(paneId)}/diff?scope=${scope}`, session), { signal });
}
