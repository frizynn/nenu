import { join } from "node:path";
import { gzipJsonResponse } from "../http-cache.ts";

// The response primitives every route shares. Every response the bridge emits funnels through
// json(), text(), jsonError() or secure(), so the hardening headers are set exactly once.

// The built PWA lives in web/dist (Vite output). If it's missing, the bridge still runs the API
// — only the static UI 503s with a hint to build.
export const WEB_DIR = join(import.meta.dir, "..", "..", "web", "dist");

// Strict CSP. Scripts are external, hashed bundles (script-src 'self'); pane text is rendered by
// React as text nodes, never markup, so terminal output can't inject. 'unsafe-inline' is allowed
// for styles only (the toast library injects a <style> tag) — it can't execute code.
export const CSP =
  "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; " +
  "style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self'; " +
  "manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'";

// Hardening headers set on EVERY response (static + API), applied centrally in the fetch wrapper.
// nosniff stops content-type confusion; no-referrer keeps the tailnet URL out of any Referer.
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

// Apply the shared hardening headers (nosniff / no-referrer) to any response.
export function secure(res: Response): Response {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  return res;
}

export function json(data: unknown, acceptEncoding: string | null, status = 200): Response {
  const response = gzipJsonResponse(data, acceptEncoding);
  if (status === 200) return secure(response);
  return secure(new Response(response.body, { status, headers: response.headers }));
}

/**
 * A JSON error body with a non-200 status (e.g. an unknown-session 404). The body is tiny (below the
 * gzip threshold), so a plain uncompressed JSON response is the whole story — no need for the gzip
 * path. `acceptEncoding` is accepted for call-site symmetry with {@link json} but not needed here.
 */
export function jsonError(message: string, status: number, _acceptEncoding: string | null): Response {
  return secure(
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
  );
}

export function text(body: string, status: number): Response {
  return secure(new Response(body, { status }));
}

// Build id of the bundle currently on disk (written by the Vite build to dist/build-info.json).
// Surfaced via the legacy-compatible X-Collie-Build header and /api/config so a stale,
// service-worker-cached client
// can tell it's behind. Cached by file mtime so a frontend rebuild (live, no restart) is picked up.
let buildCache: { id: string; mtime: number } | null = null;
export async function buildId(): Promise<string> {
  try {
    const f = Bun.file(join(WEB_DIR, "build-info.json"));
    const mtime = f.lastModified;
    if (!buildCache || buildCache.mtime !== mtime) {
      const data = (await f.json()) as { id?: string };
      buildCache = { id: data.id ?? "unknown", mtime };
    }
    return buildCache.id;
  } catch {
    return "unknown";
  }
}

// The response header carrying the on-disk bundle's build id. A polling client reads it off every
// snapshot/pane response (web/src/lib/server-build.ts) to notice a live rebuild WITHOUT a service
// worker — the plain-HTTP deployments where the SW can't register, so the SW-based auto-reload never
// runs (see web/src/lib/self-update.ts). Also set on static responses (serveStatic). A named constant
// so both sides agree on the spelling.
export const BUILD_HEADER = "x-collie-build";

/**
 * Attach the current bundle's build id to a response so a polling client can observe a server-side
 * rebuild continuously, not just on a full document load. Pure given the id (the disk read stays in
 * buildId(), mtime-cached) — exported for unit tests.
 */
export function withBuildHeader(res: Response, id: string): Response {
  res.headers.set(BUILD_HEADER, id);
  return res;
}
