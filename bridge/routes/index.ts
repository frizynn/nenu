import { deviceAuth, guard } from "./access.ts";
import { activityPaneActions } from "./activity.ts";
import type { PaneAction, RequestTimeouts, Route, Services } from "./context.ts";
import { eventRoutes } from "./events.ts";
import { filePaneActions } from "./files.ts";
import { historyPaneActions } from "./history.ts";
import { hookRoutes } from "./hooks.ts";
import { jsonError, text } from "./http.ts";
import { interactionPaneActions, interactionRoutes } from "./interactions.ts";
import { orgRoutes } from "./org.ts";
import { panePaneActions } from "./pane.ts";
import { queuePaneActions } from "./queue.ts";
import { replyPaneActions } from "./reply.ts";
import { settingsRoutes } from "./settings.ts";
import { snapshotRoutes } from "./snapshot.ts";
import { isReservedAuthPath, reservedAuthPlaceholder, serveStatic } from "./static.ts";
import { structurePaneActions, structureRoutes } from "./structure.ts";

/** Every `/api/pane/:id/<action>`, keyed by action; `""` is the bare pane read. */
export const PANE_ACTIONS: Readonly<Record<string, PaneAction>> = {
  ...panePaneActions,
  ...queuePaneActions,
  ...historyPaneActions,
  ...filePaneActions,
  ...replyPaneActions,
  ...structurePaneActions,
  ...interactionPaneActions,
  ...activityPaneActions,
};

export const PANE_ROUTE = new RegExp(
  `^\\/api\\/pane\\/([^/]+)(?:\\/(${Object.keys(PANE_ACTIONS).filter(Boolean).join("|")}))?$`,
);

/**
 * Header the web app sets on its own pane reads, and the ONLY thing that lets a read mark a pane
 * seen. See {@link marksPaneSeen} for why a header, of all things, is the check.
 */
export const SEEN_HEADER = "x-collie-seen";

/**
 * Whether this request proves it came from Nenu's own page, and may therefore stamp the pane as
 * seen (bridge/activity.ts).
 *
 * This exists because marking-seen made a **read-level GET mutate server state**, which it never did
 * before. `checkAccess` deliberately does not demand an `Origin` on reads — browsers omit it on
 * same-origin GETs, so demanding one would reject the real client — and that exemption was safe only
 * while reads had no side effects. Without this check, a page the operator visits while on the
 * tailnet could fire `<img src="https://collie…/api/pane/w1:p1">` at guessable pane ids and silently
 * clear the "Ready · unseen" section: the response is opaque to the attacker, but the write lands,
 * and the operator simply stops being told their agents finished.
 *
 * A custom request header is the check because a no-cors cross-site request **cannot set one** —
 * doing so promotes it to a preflighted CORS request, and the bridge answers no preflight. Our own
 * same-origin `fetch` sets it freely.
 *
 * Write actions (reply/keys/upload/close/rename) need no header: they already cleared
 * `guard(…, "write")`, which requires an `Origin`. Each action declares `marksSeen` in its table.
 */
export function marksPaneSeen(req: Request, action: string | undefined): boolean {
  if (req.headers.get(SEEN_HEADER) !== null) return true;
  return action !== undefined && (PANE_ACTIONS[action]?.marksSeen ?? true);
}

function paneLevel(action: PaneAction, method: string): "read" | "write" {
  return typeof action.level === "function" ? action.level(method) : action.level;
}

// ── Per-pane read / send ─────────────────────────────────────────────
const paneRoute: Route = {
  method: "*",
  path: PANE_ROUTE,
  // Reading a pane is allowed for any access-gated client; every action that types into or
  // restructures a terminal additionally needs an authorised device.
  access: (req, match) => paneLevel(PANE_ACTIONS[match![2] ?? ""]!, req.method),
  session: true,
  handle(ctx, r) {
    const paneId = decodeURIComponent(r.match![1]!);
    const name = r.match![2];
    const action = PANE_ACTIONS[name ?? ""]!;
    const isRead = paneLevel(action, r.req.method) === "read";
    // You are in this pane: reading it, replying, sending keys, browsing its history. That is
    // the whole definition of "seen" (.adr/0003), and this is the one place every such request
    // passes through. It cannot false-positive from background polling — the dashboard loader
    // only ever fetches /api/snapshot; paneLoader is the sole reader of pane text — nor from a
    // cross-site request forged at a guessed pane id (see marksPaneSeen).
    //
    // Gated on the request actually being ROUTED below. A read routes on GET and a write on POST;
    // the only way to reach here unrouted is a method mismatch (a GET at /reply, a POST at
    // /history) — which 405s. Without this a malformed request still marked the pane seen.
    const routed = isRead ? r.req.method === "GET" : r.req.method === "POST";
    if (routed && marksPaneSeen(r.req, name)) ctx.activity.noteSeen(r.rt.name, paneId);
    if (!routed) return text("method not allowed", 405);
    // Every action is a write; attribute it to the authorised device for the audit trail.
    // A read gets no device attribution (nothing is written to attribute).
    const device = isRead ? null : deviceAuth(r.req, ctx.cfg).device;
    return action.handle(ctx, { ...r, paneId, device });
  },
};

/** The API, in match order: the first route whose method and path match handles the request. */
export const ROUTES: readonly Route[] = [
  ...orgRoutes,
  ...snapshotRoutes,
  ...eventRoutes,
  ...structureRoutes,
  paneRoute,
  ...settingsRoutes,
  ...interactionRoutes,
  ...hookRoutes,
];

/** The route a request reaches, with its path match; undefined falls through to static. */
export function matchRoute(method: string, pathname: string): { route: Route; match: RegExpMatchArray | null } | undefined {
  for (const route of ROUTES) {
    if (route.method !== "*" && route.method !== method) continue;
    if (typeof route.path === "string") {
      if (route.path === pathname) return { route, match: null };
      continue;
    }
    const match = pathname.match(route.path);
    if (match) return { route, match };
  }
  return undefined;
}

/**
 * Answer one request: the route's gate first, then the session lookup, then its handler. Session
 * routes accept an optional `?session=<name>`; absent → the primary session. The name is only ever a
 * registry Map lookup — it never builds a path. An unknown name is a 404. Global routes ignore it.
 */
export async function dispatch(ctx: Services, req: Request, server: RequestTimeouts): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  const found = matchRoute(req.method, pathname);
  if (found) {
    const { route, match } = found;
    if (route.access !== "none") {
      const level = typeof route.access === "function" ? route.access(req, match) : route.access;
      const denied = guard(req, ctx.cfg, level);
      if (denied) return denied;
    }
    const base = { req, url, match, server };
    if (!route.session) return route.handle(ctx, base);
    const sessionName = url.searchParams.get("session") ?? undefined;
    const rt = ctx.registry.get(sessionName);
    if (!rt) return jsonError(`unknown session: ${sessionName ?? ""}`, 404, req.headers.get("accept-encoding"));
    return route.handle(ctx, { ...base, rt });
  }

  // ── Reserved for a fronting proxy's sign-in page ─────────────────────
  // `/auth/` is the one path the service worker always passes to the network (web/src/lib/
  // sw-routes.ts), so it is the only address an installed PWA can reach when a proxy in front of
  // the bridge refuses a stale session. Nenu never routes it. If a request gets this far, no
  // proxy claimed it — say so, instead of letting the SPA fallback answer with the app shell and
  // leave the operator staring at the UI they were trying to escape.
  if (isReservedAuthPath(pathname)) return reservedAuthPlaceholder();

  // ── Static PWA (with SPA fallback) ───────────────────────────────────
  return serveStatic(pathname, ctx.assets);
}
