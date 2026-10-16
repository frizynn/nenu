import type { Route } from "./context.ts";
import { json, text } from "./http.ts";

// Settings → Usage, and the page it opens (bridge/usage/). Reading is read-level, like the other
// settings; turning tracking on is write-level because it makes this bridge read every agent log.
export const usageRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/usage",
    access: "read",
    session: false,
    async handle({ usage }, { req }) {
      const url = new URL(req.url);
      const account = url.searchParams.get("account") ?? undefined;
      if (account !== undefined && !/^(claude|codex):[0-9a-z-]{1,32}$/.test(account)) return text("bad account", 400);
      const body = await usage.read({ account, fresh: url.searchParams.get("fresh") === "1" });
      return json(body, req.headers.get("accept-encoding"));
    },
  },
  {
    method: "POST",
    path: "/api/usage",
    access: "write",
    session: false,
    async handle({ usage }, { req }) {
      const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body || typeof body !== "object") return text("bad request", 400);
      const patch: { on?: boolean; splitByAccount?: boolean } = {};
      for (const key of ["on", "splitByAccount"] as const) {
        if (!(key in body)) continue;
        if (typeof body[key] !== "boolean") return text(`bad ${key}`, 400);
        patch[key] = body[key];
      }
      return json(await usage.set(patch), req.headers.get("accept-encoding"));
    },
  },
  { method: "*", path: "/api/usage", access: "none", session: false, handle: () => text("method not allowed", 405) },
];
