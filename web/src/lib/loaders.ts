// React Router data loaders are the data layer — there is intentionally no separate data-fetching
// library. The home/detail routes declare these as `loader`s; polling is just
// `useRevalidator().revalidate()` re-running them (see hooks/use-polling.ts). Each loader keeps the
// last good result in a module cache so a transient fetch failure shows stale-but-present data
// (flagged) instead of flashing empty — i.e. keep-previous-data while a refetch is in flight.
//
// Offline fast path (a PWA should navigate instantly to last-known data): during a KNOWN, escalated
// outage (the shared connection-health store has latched "lost"), a NAVIGATION must not block on a
// fetch that will only time out — it returns cached data immediately (flagged error). A REVALIDATION
// (the poll) must keep really fetching so recovery is discovered and the stale data swapped out. React
// Router never tells a loader which kind of run it is, but the request URL does: a revalidation re-runs
// a loader at the SAME url; a navigation runs it at a DIFFERENT one (see isNavigation below). No timer,
// no flag, no race — and because a navigation aborts any in-flight revalidation, the nav is instant
// even while a poll's doomed fetch is still hanging.

import { fetchHistory, fetchPane, fetchPullRequests, fetchSnapshot, isApiErrorStatus, warmConversation } from "@/lib/api";
import { parseAnsi } from "@/lib/ansi";
import { splitLines } from "@/lib/blocks";
import { isLostLatched } from "@/lib/connection-health";
import { preloadDeskChunks } from "@/lib/desk-chunks";
import { readsConversation } from "@/lib/harness/registry";
import { loadRawTerminal, paneDisplayScope } from "@/lib/raw-terminal";
import {
  dropLastPaneText,
  loadLastPaneText,
  loadLastPullRequests,
  loadLastSnapshot,
  saveLastPaneText,
  saveLastPullRequests,
  saveLastSnapshot,
} from "@/lib/last-seen";
import { detectNoEchoPrompt } from "@/lib/no-echo";
import { needsFetch } from "@/lib/revalidation";
import { SESSION_PARAM, normalizeSession } from "@/lib/session";
import { keepItems } from "@/lib/utils";
import type {
  AgentView,
  BridgeStatus,
  DeviceAuth,
  MachineView,
  PaneHistoryResponse,
  PaneReadResponse,
  PullRequestView,
  SessionSummary,
  SnapshotResponse,
  TabView,
  TranscriptEntry,
  UpdateInfo,
  WorkspaceView,
} from "@/lib/types";

// A superseded revalidation is aborted via the loader's request.signal; that rejection must be
// RETHROWN so React Router discards the stale run — swallowing it into the stale-data/error-banner
// path would flash a spurious "reconnecting…" on every fast poll. Supersession is read off the
// request's own signal, never the error's name: WebKit rejects a fetch whose timeout fired with an
// "AbortError" too, and rethrowing that replaced the open chat with the error screen on iPhones.
function isSuperseded(request: Request | undefined): boolean {
  return request?.signal.aborted === true;
}

function rethrowIfSuperseded(request: Request | undefined): void {
  if (isSuperseded(request)) throw request!.signal.reason ?? new DOMException("The run was superseded", "AbortError");
}

// The root route's id, paired with rootLoader. Children read its data via
// `useRouteLoaderData(ROOT_ROUTE_ID)`; keeping it a constant means a rename is a single edit, not a
// silent runtime `undefined` from a stale string literal.
export const ROOT_ROUTE_ID = "root";

// The pane route's id, paired with paneLoader. Named for the same reason ROOT_ROUTE_ID is — and used
// by exactly one thing: RootLayout reads this route's data (undefined unless a pane is the active
// route) so the connection bar can date the MIRROR on screen rather than the herd behind it.
export const PANE_ROUTE_ID = "pane";

// The session a loader run was scoped to, read from the request URL's `?s=`. Extracted once per run
// and threaded into every fetch + cache key so a session switch (a plain URL change picked up by the
// revalidator) is automatically correct. Undefined = primary.
function sessionFromRequest(request?: Request): string | undefined {
  if (!request) return undefined;
  try {
    return normalizeSession(new URL(request.url).searchParams.get(SESSION_PARAM));
  } catch {
    return undefined;
  }
}

export interface HomeData {
  bridge: BridgeStatus | undefined;
  /** Per-device authorisation; undefined when the feature is off or not yet known. */
  device: DeviceAuth | undefined;
  agents: AgentView[];
  shellPanes: AgentView[];
  workspaces: WorkspaceView[];
  tabs: TabView[];
  /** Open pull requests from GitHub in the repos agents work in, read apart from the snapshot. */
  pullRequests?: PullRequestView[];
  /** The bridge's session registry (primary-first); empty on a single-session / older bridge. */
  sessions: SessionSummary[];
  /** The session this snapshot was fetched for (undefined = primary) — so children don't re-derive. */
  session: string | undefined;
  /** Active notification snooze deadline (epoch ms), or null when not snoozed. */
  snoozedUntil: number | null;
  /** Version / upgrade status for the footer update banner; undefined on an older bridge. */
  update: UpdateInfo | undefined;
  /** True when this render is the last-good snapshot after a failed refresh. */
  error: boolean;
  /** True when the failed refresh was rejected with HTTP 401 or 403. */
  authError: boolean;
  /** Herdr's saved machines, this one first; absent with only one (lib/machines.ts). */
  machines?: MachineView[];
  /**
   * When this herd was actually fetched — set ONLY on a stale render, and only when the write-through
   * cache can date it (lib/last-seen.ts). It is what lets the UI say "last seen 14:32" instead of
   * showing an undated old screen; absent means live data, or stale data we cannot date.
   */
  lastSeenAt?: number;
}

export interface PaneData {
  nativeTelemetry?: PaneReadResponse["nativeTelemetry"];
  paneId: string;
  /** The session this pane was fetched for (undefined = primary) — threaded into every write. */
  session: string | undefined;
  text: string;
  /** True when the buffer was cut off at the requested line count — older scrollback still exists. */
  truncated: boolean;
  /** The scrollback window this result was fetched with — lets the UI tell a grown fetch from a
   * stale in-flight poll (a "Load older" tap raises this; see growRequestedLines). */
  requestedLines: number;
  /** Herdr's monotonic revision for `text` — the prompt-select race guard checks against it. 0 on
   * the degraded (stale-text) path, where the guard's fresh fetch will reject a mismatch anyway. */
  revision: number;
  /** A shell at its prompt (true) or running a command (false); absent when unknown, a stale read included. */
  atPrompt?: boolean;
  error: boolean;
  /** True when the failed refresh was rejected with HTTP 401 or 403. */
  authError: boolean;
  /** When this mirror was actually fetched — set only on a datable stale render, as on HomeData. */
  lastSeenAt?: number;
  /** The read is still on its way: this is what the page already had (empty for a pane never read),
   *  handed over so the chat opens at once. DetailRoute asks for the read as soon as the chat shows. */
  pending?: boolean;
}

// Keep-previous-data cache is now PER-SESSION: switching sessions must not show the other session's
// herd flagged as stale. Keyed by session name ("" = primary).
const lastSnapshot = new Map<string, SnapshotResponse>();

// A latched navigation skips the network, so retain whether the last real outcome for each session
// was an auth rejection. Store only rejected sessions; every other real outcome removes the marker.
const authErrorSessions = new Set<string>();

function rememberAuthError(session: string | undefined, authError: boolean): void {
  const key = session ?? "";
  if (authError) authErrorSessions.add(key);
  else authErrorSessions.delete(key);
}

function hasAuthError(session: string | undefined): boolean {
  return authErrorSessions.has(session ?? "");
}

function isAuthError<TThrown>(error: TThrown): boolean {
  return isApiErrorStatus(error, 401) || isApiErrorStatus(error, 403);
}

// The URL each loader last RAN for — the nav-vs-revalidate discriminator for the offline fast path (see
// the header comment). Module-scoped so it survives revalidations (the loader re-runs every poll) and
// resets on a full reload — same lifetime as the caches. `lastRootUrl` is enough for the root loader
// because it runs on EVERY navigation (it's the parent of all routes); the pane loader only runs while
// a pane is mounted, so `lastRootUrl` also CLEARS `lastPaneUrl` whenever we're on a non-pane URL — that
// way re-entering the same pane (pane → home → same pane) reads as a fresh navigation, not a poll.
let lastRootUrl: string | undefined;
let lastPaneUrl: string | undefined;

function isPaneUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).pathname.startsWith("/pane/");
  } catch {
    return url.includes("/pane/");
  }
}

function toHomeData(
  snap: SnapshotResponse,
  pullRequests: PullRequestView[],
  session: string | undefined,
  error: boolean,
  lastSeenAt?: number,
): HomeData {
  return {
    lastSeenAt,
    bridge: snap.bridge,
    device: snap.device,
    agents: snap.agents,
    shellPanes: snap.shellPanes ?? [],
    workspaces: snap.workspaces ?? [],
    tabs: snap.tabs ?? [],
    pullRequests,
    sessions: snap.sessions ?? [],
    session,
    snoozedUntil: snap.notifications?.snoozedUntil ?? null,
    update: snap.update,
    error,
    authError: error && hasAuthError(session),
    ...(snap.machines ? { machines: snap.machines } : {}),
  };
}

// Last-known home for a session, flagged stale — the cached snapshot if we have one, else an empty
// error snapshot. Shared by BOTH the failed-refresh catch and the offline navigation fast path, so the
// two return byte-identical shapes (the UI can't tell "fetch just failed" from "navigated while known-
// offline" — both are "stale-but-present, flagged").
//
// Two tiers, in this order: the module cache (this page's own last good fetch), then the write-through
// sessionStorage cache (lib/last-seen.ts). The second tier is what a COLD boot reads — a discarded and
// restored PWA has an empty module cache and a failing first fetch, and without it the operator gets an
// empty herd instead of the screen they left. A restored snapshot is promoted into the module cache so
// the rest of this page session behaves exactly as if we had fetched it.
function staleHome(session: string | undefined): HomeData {
  const restored = loadLastSnapshot(session);
  const cached = lastSnapshot.get(session ?? "") ?? restored?.value;
  if (cached) {
    lastSnapshot.set(session ?? "", cached);
    const pullRequests = lastHomeData.get(session ?? "")?.pullRequests ?? loadLastPullRequests(session) ?? cached.pullRequests ?? [];
    return toHomeData(cached, pullRequests, session, true, restored?.at);
  }
  // Nothing cached at all — an outage on a tab that never saw a good snapshot. `error: true` is what
  // keeps this apart from a genuinely empty herd downstream: the empty state is only allowed to say
  // "No agents running" when the bridge really answered.
  return {
    lastSeenAt: undefined,
    bridge: undefined,
    device: undefined,
    agents: [],
    shellPanes: [],
    workspaces: [],
    tabs: [],
    sessions: [],
    session,
    snoozedUntil: null,
    update: undefined,
    error: true,
    authError: hasAuthError(session),
  };
}

export async function rootLoader({ request }: { request?: Request } = {}): Promise<HomeData> {
  const session = sessionFromRequest(request);
  // Nav-vs-revalidate: a revalidation (poll) re-runs at the SAME url; a navigation runs at a different
  // one. Cold start (lastRootUrl undefined) reads as a navigation too, but the latch gate below is
  // never set that early, so the first run always really fetches (BootSplash + escalation, as today).
  const url = request?.url;
  const isNavigation = lastRootUrl !== url;
  lastRootUrl = url;
  // Leaving the panes clears the pane loader's discriminator so a later return to it reads as a fresh
  // nav, and stops a pane read nothing will show now.
  if (!isPaneUrl(url)) {
    lastPaneUrl = undefined;
    dropReads();
  }

  // Fast path: a navigation during a known, escalated outage returns last-known data INSTANTLY rather
  // than hanging on a doomed fetch. Revalidations fall through and really fetch (so recovery lands and
  // markLive clears the latch → the next run fetches live and replaces the stale herd).
  if (isNavigation && isLostLatched()) return staleHome(session);
  // A live event that named only the open pane: hand back the very same herd object (lib/revalidation.ts).
  const previous = lastHomeData.get(session ?? "");
  if (!isNavigation && previous && !needsFetch("root", request)) return previous;

  const home = await loadHome(session, request);
  lastHomeData.set(session ?? "", home);
  return home;
}

// What rootLoader last returned per session, so a narrowed revalidation can return it unchanged.
const lastHomeData = new Map<string, HomeData>();

async function loadHome(session: string | undefined, request: Request | undefined): Promise<HomeData> {
  try {
    const snap = await fetchSnapshot(session, request?.signal);
    const previous = lastHomeData.get(session ?? "");
    const pullRequests = shownPullRequests(session, await readPullRequests(session, snap, previous, request));
    if (pullRequests !== previous?.pullRequests) saveLastPullRequests(session, pullRequests);
    // A 304 hands back the snapshot already on screen; the same herd object then keeps every view's
    // memoised work. The write-through below still runs, so its date stays the last confirmed read.
    const unchanged = snap === lastSnapshot.get(session ?? "") && previous && !previous.error && pullRequests === previous.pullRequests;
    lastSnapshot.set(session ?? "", snap);
    // Write-through: the same body, dated, in a store that outlives this page (lib/last-seen.ts).
    saveLastSnapshot(session, snap);
    rememberAuthError(session, false);
    return unchanged ? previous : keepUnchangedRows(previous, toHomeData(snap, pullRequests, session, false));
  } catch (e) {
    if (isSuperseded(request)) throw e; // superseded revalidation — let React Router drop it
    rememberAuthError(session, isAuthError(e));
    // Keep the last good herd on screen, flagged so the ConnectionBanner can say "reconnecting…".
    return staleHome(session);
  }
}

// The pull requests the snapshot names, the same list object while its version holds. A failed read
// keeps the list on screen without flagging the herd, and the next run asks again.
async function readPullRequests(
  session: string | undefined,
  snap: SnapshotResponse,
  previous: HomeData | undefined,
  request: Request | undefined,
): Promise<PullRequestView[]> {
  try {
    return snap.pullRequests ?? await fetchPullRequests(session, snap.pullRequestsEtag, request?.signal);
  } catch (e) {
    if (isSuperseded(request)) throw e;
    return previous?.pullRequests ?? loadLastPullRequests(session) ?? [];
  }
}

// What each session's page shows of the list it read last: while the read hands back the same list (its
// version held), the same rows; when the list moved, the rows that say what they said keep their objects.
const lastPullRequests = new Map<string, { read: PullRequestView[]; shown: PullRequestView[] }>();

function shownPullRequests(session: string | undefined, read: PullRequestView[]): PullRequestView[] {
  const last = lastPullRequests.get(session ?? "");
  if (last?.read === read) return last.shown;
  const shown = keepItems(last?.shown, read);
  lastPullRequests.set(session ?? "", { read, shown });
  return shown;
}

// A changed snapshot rarely changes every row: the rows that say what they said keep their objects,
// so memoised rows (the desk's chats, the open chat) skip the redraw.
function keepUnchangedRows(previous: HomeData | undefined, next: HomeData): HomeData {
  if (!previous) return next;
  return {
    ...next,
    agents: keepItems(previous.agents, next.agents),
    shellPanes: keepItems(previous.shellPanes, next.shellPanes),
    workspaces: keepItems(previous.workspaces, next.workspaces),
    tabs: keepItems(previous.tabs, next.tabs),
    sessions: keepItems(previous.sessions, next.sessions),
  };
}

// Pane ids are per-session, so every per-pane cache is keyed by (session, paneId) — a NUL joiner
// keeps the two fields unambiguous. "" session = primary.
function paneKey(paneId: string, session?: string): string {
  return `${session ?? ""}\u0000${paneId}`;
}

const lastPaneText = new Map<string, string>();
// Cap the per-pane stale-text cache so it can't grow without bound over a long session of opening
// many panes. Evict the oldest (insertion-order) entry beyond the cap — dumb FIFO is plenty for a
// phone that views one pane at a time.
const PANE_TEXT_MAX = 20;

function rememberPaneText(key: string, text: string): void {
  lastPaneText.set(key, text);
  if (lastPaneText.size > PANE_TEXT_MAX) {
    const oldest = lastPaneText.keys().next().value;
    if (oldest !== undefined) lastPaneText.delete(oldest);
  }
}

// The detail view pulls a deeper window than the home snapshot's status reads, so you can scroll
// back through a long exchange. The live tail still follows; scrolling up freezes it (see
// AgentChat). Larger = more scrollback but more bytes per poll — 600 holds several exchanges.
const DETAIL_HISTORY_LINES = 600;
// "Load older" raises the requested window by a step per tap, up to a cap.
//
// The cap is 1000 because HERDR clamps `pane.read` there — silently, and without setting `truncated`.
// Live-probed against a pane holding 6895 lines of scrollback: 999→1000, 1000→1001, 2000→1001,
// 6000→1001. Asking for more than 1000 returns the same 1000 lines, so a higher cap only bought taps
// that fetched nothing new. (The bridge's own MAX_READ_LINES=10000 is the outer guard; this is the
// real ceiling.) If Herdr ever lifts its clamp, raise this to match.
const DETAIL_HISTORY_STEP = 600;
export const DETAIL_HISTORY_MAX = 1000;

// Per-pane requested scrollback, raised by "Load older". Module-scoped so it survives revalidations
// (the loader re-runs on every poll) but resets on a full app reload — mirrors lastPaneText. Bounded
// the same way so a long session of opening many panes can't grow it without bound.
const requestedLines = new Map<string, number>();

/** The scrollback window currently requested for a pane (defaults to the base window). */
export function getRequestedLines(paneId: string, session?: string): number {
  return requestedLines.get(paneKey(paneId, session)) ?? DETAIL_HISTORY_LINES;
}

/** True while more scrollback can still be requested (below the cap). */
export function canGrowRequestedLines(paneId: string, session?: string): boolean {
  return getRequestedLines(paneId, session) < DETAIL_HISTORY_MAX;
}

/** Raise the requested scrollback by one step (capped) and return the new value. */
export function growRequestedLines(paneId: string, session?: string): number {
  const next = Math.min(getRequestedLines(paneId, session) + DETAIL_HISTORY_STEP, DETAIL_HISTORY_MAX);
  requestedLines.set(paneKey(paneId, session), next);
  if (requestedLines.size > PANE_TEXT_MAX) {
    const oldest = requestedLines.keys().next().value;
    if (oldest !== undefined) requestedLines.delete(oldest);
  }
  return next;
}

/** Reset a pane's requested scrollback back to the base window (used by tests). */
export function resetRequestedLines(paneId?: string, session?: string): void {
  if (paneId === undefined) requestedLines.clear();
  else requestedLines.delete(paneKey(paneId, session));
}

// Last-known pane payload, flagged degraded — stale text (empty if this pane was never fetched),
// truncated cleared, revision 0 (the prompt-select guard rejects a 0-revision mismatch anyway). Shared
// by the failed-refresh catch and the offline navigation fast path, so both return the same shape.
//
// Same two tiers as staleHome: the module cache, then the write-through sessionStorage mirror that
// survives the page being discarded. A restored mirror is promoted into the module cache.
function stalePane(paneId: string, session: string | undefined, lines: number): PaneData {
  const key = paneKey(paneId, session);
  const restored = loadLastPaneText(session, paneId);
  const text = lastPaneText.get(key) ?? restored?.value ?? "";
  if (text) rememberPaneText(key, text);
  return {
    paneId,
    session,
    text,
    truncated: false,
    requestedLines: lines,
    revision: 0,
    error: true,
    authError: hasAuthError(session),
    lastSeenAt: text ? restored?.at : undefined,
  };
}

// How much of the mirror the check below parses. `detectNoEchoPrompt` reads the last two NON-BLANK
// lines, so 40 gives the same answer as 600 for a fraction of the work on every poll: a prompt with
// 38 blank lines under it is not a terminal blocked waiting for a password.
const NO_ECHO_TAIL_LINES = 40;

/**
 * Whether this mirror is a pane sitting at a password prompt — the ADR 0017 exclusion.
 *
 * Recognition already exists and already changes what Nenu SAYS (lib/no-echo.ts); this is the one
 * other thing it changes, and it is a subtraction: a screen the operator is being asked to type a
 * secret into is not written to the browser's store, and whatever was written for that pane earlier is
 * dropped. Note what it is NOT about — the prompt echoes nothing, so there is no secret on the screen
 * to leak. It is about the pane the operator is answering `sudo` in not being kept, and about the next
 * read of that pane never being the one that restores it.
 */
function holdsNoEchoPrompt(text: string): boolean {
  const tail = text.split("\n").slice(-NO_ECHO_TAIL_LINES).join("\n");
  return detectNoEchoPrompt(splitLines(parseAnsi(tail))) !== null;
}

/**
 * How long a navigation waits on the pane's read before it opens the chat on what the page already
 * has. A read on a quick link lands inside it, so nothing changes there; on a slow one the header and
 * the conversation show at once instead of the old screen staying up for the whole read (SYS-17).
 */
export const PANE_FIRST_PAINT_MS = 150;

// The read a navigation started and stopped waiting for, so the revalidation that follows awaits it
// instead of reading the pane a second time. Keyed by pane and window; dropped once it settles, or
// once the reader is on another pane or off the panes (dropReads).
const inflight = new Map<string, { pane: string; read: Promise<PaneData>; stop: AbortController }>();

/** Stop the shared reads of every pane but `keep`: left to its timeout, a read nobody will show holds the link. */
function dropReads(keep?: string): void {
  for (const [id, entry] of inflight) {
    if (entry.pane === keep) continue;
    entry.stop.abort();
    inflight.delete(id);
  }
}

/** One background read of a pane, shared by the navigation that started it and the run after it. */
function sharedRead(paneId: string, session: string | undefined, lines: number): Promise<PaneData> {
  const pane = paneKey(paneId, session);
  const id = `${pane}\u0000${lines}`;
  dropReads(pane);
  const running = inflight.get(id);
  if (running) return running.read;
  // Not the request's signal: the navigation that starts it may stop waiting, and the read must still
  // land. Its own stops it once the reader moves on; fetchPane bounds it with its own timeout, and
  // loadPane turns a failure into the stale pane. Without AbortSignal.any (iOS before 17.4) fetchPane
  // can't join the stop to that timeout, so there the read keeps the timeout and goes without the stop.
  const stop = new AbortController();
  const signal = typeof AbortSignal.any === "function" ? stop.signal : undefined;
  const read = loadPane(paneId, session, lines, signal).then((data) => {
    rememberPaneData(pane, data);
    return data;
  }).finally(() => {
    if (inflight.get(id)?.read === read) inflight.delete(id);
  });
  inflight.set(id, { pane, read, stop });
  return read;
}

/** What a navigation hands the chat while the read runs: the last pane data or text, else nothing. */
function pendingPane(paneId: string, session: string | undefined, lines: number): PaneData {
  const key = paneKey(paneId, session);
  const known = lastPaneData.get(key);
  if (known?.requestedLines === lines) return { ...known, pending: true };
  const text = lastPaneText.get(key) ?? loadLastPaneText(session, paneId)?.value ?? "";
  return { paneId, session, text, truncated: false, requestedLines: lines, revision: 0, error: false, authError: hasAuthError(session), pending: true };
}

export async function paneLoader({
  params,
  request,
}: {
  params: { paneId?: string };
  request?: Request;
}): Promise<PaneData> {
  const { paneId } = params;
  // The route is `/pane/:paneId`, so a missing param means a misconfigured route, not a user state
  // — fail loudly to the error boundary rather than fetching `/api/pane/` and rendering an empty pane.
  if (!paneId) throw new Error("paneLoader: missing :paneId route param");
  const session = sessionFromRequest(request);
  const key = paneKey(paneId, session);
  const lines = getRequestedLines(paneId, session);
  // Nav-vs-revalidate, as in rootLoader. `lastPaneUrl` also flips to undefined whenever rootLoader sees
  // a non-pane URL, so opening a pane (even one just left) reads as a navigation, and polling within it
  // (same URL) reads as a revalidation.
  const url = request?.url;
  const previousPaneUrl = lastPaneUrl;
  const isNavigation = lastPaneUrl !== url;
  lastPaneUrl = url;

  // Fast path: navigating to a pane during a known, escalated outage shows its last-known mirror (or an
  // empty degraded pane if never visited) INSTANTLY — never a 10s hang on a fetch that can't land.
  if (isNavigation && isLostLatched()) return stalePane(paneId, session, lines);
  // A live event that named only the herd: the mirror stays as it was (lib/revalidation.ts).
  const previous = lastPaneData.get(key);
  if (!isNavigation && previous?.requestedLines === lines && !needsFetch("pane", request)) return previous;

  // Opening a pane: give the read a moment, then open on what the page has and let it land later.
  // A superseded navigation still rejects, so React Router drops it (see isSuperseded).
  if (isNavigation) {
    rethrowIfSuperseded(request);
    const read = sharedRead(paneId, session, lines);
    // What the chat reads right after its first render, asked for beside the pane's read: only on the
    // way into another pane, and only where the chat will read a conversation.
    if (enteringPane(previousPaneUrl, url) && chatReads(paneId, session)) warmConversation(paneId, session);
    preloadDeskChunks();
    const landed = await Promise.race([read, new Promise<null>((resolve) => setTimeout(() => resolve(null), PANE_FIRST_PAINT_MS))]);
    rethrowIfSuperseded(request);
    return landed ?? pendingPane(paneId, session, lines);
  }
  // The run after a navigation that stopped waiting: the read it started, not a second one.
  const running = inflight.get(`${key}\u0000${lines}`);
  if (running) return running.read;

  const pane = await loadPane(paneId, session, lines, request?.signal);
  rememberPaneData(key, pane);
  return pane;
}

/** A navigation into a pane other than the one shown: a changed search (a tab, a filter) is not one. */
function enteringPane(previous: string | undefined, next: string | undefined): boolean {
  if (!previous || !next) return true;
  const [from, to] = [new URL(previous, "http://nenu.invalid"), new URL(next, "http://nenu.invalid")];
  return from.pathname !== to.pathname || from.searchParams.get(SESSION_PARAM) !== to.searchParams.get(SESSION_PARAM);
}

/** Whether the pane's chat reads its conversation on open: an agent Nenu can read, not shown as its raw terminal. */
function chatReads(paneId: string, session: string | undefined): boolean {
  const agent = lastSnapshot.get(session ?? "")?.agents.find((candidate) => candidate.paneId === paneId);
  return readsConversation(agent) && !loadRawTerminal(paneDisplayScope(session, paneId));
}

// What paneLoader last returned per pane, bounded like the text cache.
const lastPaneData = new Map<string, PaneData>();

function rememberPaneData(key: string, pane: PaneData): void {
  lastPaneData.delete(key);
  lastPaneData.set(key, pane);
  if (lastPaneData.size > PANE_TEXT_MAX) {
    const oldest = lastPaneData.keys().next().value;
    if (oldest !== undefined) lastPaneData.delete(oldest);
  }
}

async function loadPane(paneId: string, session: string | undefined, lines: number, signal: AbortSignal | undefined): Promise<PaneData> {
  const key = paneKey(paneId, session);
  try {
    // On a 304 fetchPane returns the cached body, so `read.text` is populated either way; the
    // `?? lastPaneText` is just belt-and-suspenders. Both paths are a success (not the error
    // branch) so the connection bar doesn't flicker on an unchanged poll.
    const read: PaneReadResponse = await fetchPane(paneId, lines, session, signal);
    const text = read.text || lastPaneText.get(key) || "";
    rememberPaneText(key, text);
    // Write-through, EXCEPT while the pane is asking for a secret — see holdsNoEchoPrompt (ADR 0017).
    if (holdsNoEchoPrompt(text)) dropLastPaneText(session, paneId);
    else saveLastPaneText(session, paneId, text);
    rememberAuthError(session, false);
    return {
      paneId,
      session,
      text,
      truncated: read.truncated,
      requestedLines: lines,
      revision: read.revision,
      atPrompt: read.atPrompt,
      nativeTelemetry: read.nativeTelemetry,
      error: false,
      authError: false,
    };
  } catch (e) {
    if (signal?.aborted) throw e; // superseded revalidation, or a read the reader left — let it go
    rememberAuthError(session, isAuthError(e));
    // Genuine network / server failure: show stale text flagged as degraded.
    return stalePane(paneId, session, lines);
  }
}

// ── Pane history (the agent's own transcript) ─────────────────────────────────
//
// A Claude pane runs on the terminal's ALTERNATE SCREEN, which keeps no scrollback ring — Herdr can
// only ever hand us the visible viewport, so "load older" against the mirror is physically
// impossible. The real history lives in the agent's own session log, and this loader fetches its
// newest page. Unlike the pane loader this one is NOT on the poll loop: the history route sets
// `shouldRevalidate: () => false` (see router.tsx), because re-pulling a 900-turn transcript every
// 1.5s would be pure waste and would fight the component's own "load older" paging.

/**
 * Turns requested when the history view opens.
 *
 * "Show entire history" is taken literally: the point of this view is that the terminal mirror
 * CAN'T show you the past, so opening it and still being 40 turns from the start would miss the
 * point. This is high enough to swallow whole conversations (the longest measured live: 1415 turns);
 * `hasMore` + "Load older" remain for anything beyond it, so a pathological log still degrades to
 * paging rather than a stall.
 */
export const HISTORY_PAGE_SIZE = 5000;

export interface HistoryData {
  paneId: string;
  session: string | undefined;
  /** Oldest-first. Empty when unavailable or on a failed fetch. */
  entries: TranscriptEntry[];
  /** Older turns exist before `entries[0]` — the view pages back with `before`. */
  hasMore: boolean;
  total: number;
  /** The log was byte-capped, so even the oldest page isn't the true start. */
  fileTruncated: boolean;
  /** Why there's nothing to show; undefined when history IS available. */
  unavailable?: "disabled" | "no-session" | "no-log" | "error";
}

export async function historyLoader({
  params,
  request,
}: {
  params: { paneId?: string };
  request?: Request;
}): Promise<HistoryData> {
  const { paneId } = params;
  if (!paneId) throw new Error("historyLoader: missing :paneId route param");
  const session = sessionFromRequest(request);
  const base = { paneId, session, entries: [], hasMore: false, total: 0, fileTruncated: false };

  try {
    const res: PaneHistoryResponse = await fetchHistory(
      paneId,
      { limit: HISTORY_PAGE_SIZE },
      session,
      request?.signal,
    );
    if (!res.available) return { ...base, unavailable: res.reason };
    return {
      paneId,
      session,
      entries: res.entries,
      hasMore: res.hasMore,
      total: res.total,
      fileTruncated: res.fileTruncated,
    };
  } catch (e) {
    if (isSuperseded(request)) throw e; // superseded — let React Router drop it
    return { ...base, unavailable: "error" };
  }
}
