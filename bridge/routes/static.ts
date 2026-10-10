import { extname, join, normalize, sep } from "node:path";
import type { WebAssetArchive } from "../web-assets.ts";
import { BUILD_HEADER, buildId, CSP, secure, text, WEB_DIR } from "./http.ts";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/**
 * Resolve a request pathname to an absolute path under `webDir`, or null if it escapes. Pure +
 * exported for tests. The `full === webDir || full.startsWith(webDir + sep)` check rejects both
 * `..` traversal AND a sibling dir that merely shares the prefix (e.g. `web/dist-x` vs `web/dist`) —
 * a bare `startsWith(webDir)` would let the latter through.
 */
export function resolveStaticPath(
  pathname: string,
  webDir: string = WEB_DIR,
): { rel: string; full: string } | null {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const full = normalize(join(webDir, rel));
  if (full !== webDir && !full.startsWith(webDir + sep)) return null;
  return { rel, full };
}

/**
 * The namespace reserved for the operator's front door. Matches `/auth` with or without a trailing
 * slash and anything beneath it — a proxy may serve one page or a whole flow. Kept in lockstep with
 * the service worker's navigation denylist (`web/src/lib/sw-routes.ts`); if these two disagree, an
 * installed PWA either can't reach the proxy or can't reach Nenu. Pure + exported for tests.
 */
export function isReservedAuthPath(pathname: string): boolean {
  return pathname === "/auth" || pathname.startsWith("/auth/");
}

/**
 * What `/auth/` says when nothing is in front of the bridge. Deliberately a 404: the path is
 * reserved, not implemented — Nenu has no sign-in of its own and must not imply otherwise. Plain
 * HTML with no inline style or script (the strict CSP forbids both) and a link home, because in an
 * installed PWA this page may be the only thing on screen and there is no address bar to leave it.
 * Unauthenticated by design: it sits outside every gate, since the reason to be here is that a gate
 * refused you.
 */
export function reservedAuthPlaceholder(): Response {
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Nothing configured here — Nenu</title>
</head>
<body>
<h1>Nothing is configured at this address</h1>
<p>Nenu reserves <code>/auth/</code> for a reverse proxy sitting in front of it, so that an
installed app has somewhere to reach a sign-in or device-enrolment page. Nenu itself serves
nothing here and has no sign-in of its own.</p>
<p>If you are the operator: point this path at your proxy's sign-in flow. See <em>Serving Nenu
behind your own reverse proxy</em> in the README.</p>
<p><a href="/">Back to Nenu</a></p>
</body>
</html>
`;
  return secure(
    new Response(body, {
      status: 404,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": CSP,
        "cache-control": "no-store",
      },
    }),
  );
}

export async function serveStatic(pathname: string, assets: WebAssetArchive): Promise<Response> {
  // An archive failure must not take the current frontend offline.
  await assets.retain(WEB_DIR).catch(() => {});
  const resolved = resolveStaticPath(pathname);
  if (!resolved) return text("forbidden", 403);
  let { rel, full } = resolved;

  let file = Bun.file(full);
  if (!(await file.exists())) {
    const retained = await assets.resolve(rel);
    if (retained) { full = retained; file = Bun.file(full); }
  }
  if (!(await file.exists())) {
    // SPA fallback: extension-less paths fall back to index.html; missing assets 404.
    if (extname(rel) === "") {
      rel = "index.html";
      full = join(WEB_DIR, "index.html");
      file = Bun.file(full);
      if (!(await file.exists())) {
        return text("frontend not built — run `bun run build` in web/", 503);
      }
    } else {
      return text("not found", 404);
    }
  }

  const ext = extname(full);
  const headers: Record<string, string> = {
    "content-type": staticContentType(full),
    [BUILD_HEADER]: await buildId(), // which bundle the server is serving (vs the client's stamp)
    "cache-control": cacheControlFor(rel),
  };
  if (ext === ".html") headers["content-security-policy"] = CSP;
  if (rel === "sw.js") headers["service-worker-allowed"] = "/";
  return secure(new Response(file, { headers }));
}

/** Module workers need a JavaScript MIME under nosniff, including Vite's emitted .mjs assets. */
export function staticContentType(path: string): string {
  return CONTENT_TYPES[extname(path)] ?? "application/octet-stream";
}

/**
 * Cache-Control for a served dist file, keyed by its path relative to web/dist. Hashed assets under
 * `assets/` are content-addressed, so cache them hard + immutable. EVERYTHING else — index.html,
 * sw.js, manifest.webmanifest, build-info.json, the favicons — is MUTABLE across a rebuild and must
 * always be revalidated (`no-cache`), so neither the browser NOR an intermediary reverse proxy can
 * pin a stale copy. This matters most for sw.js: a proxy that heuristically caches it (it shipped
 * with no Cache-Control before) starves `registration.update()` and wedges the whole SW update
 * pipeline — the exact failure the API-observed self-update (web/src/lib/self-update.ts) works around,
 * but which this header prevents at the source. Pure + exported for unit tests.
 */
export function cacheControlFor(rel: string): string {
  return rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache";
}
