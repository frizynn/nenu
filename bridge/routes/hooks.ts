import { CLAUDE_HOOK_PATH, CLAUDE_HOOK_TOKEN_HEADER, decodeClaudeHook, hookTokenMatches, paneForSession, readHookToken } from "../claude-hooks.ts";
import { isLoopbackPeer } from "./access.ts";
import type { Route, RouteRequest } from "./context.ts";
import { secure, text } from "./http.ts";

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const MAX_HOOK_BYTES = 256 * 1024;

/**
 * Only Claude on this host may deliver a hook. The browser gates in access.ts do not apply here
 * (Claude sends no Origin), so this route carries its own: a loopback peer AND a loopback Host, no
 * trace of a front door (tailscale serve and proxies add identity or forwarding headers), no
 * browser Origin, and the installed token.
 */
function fromLocalClaude(r: RouteRequest): boolean {
  const { headers } = r.req;
  if (r.peer !== undefined && !isLoopbackPeer(r.peer)) return false;
  if (!LOOPBACK_HOST.test(headers.get("host") ?? "")) return false;
  return !["origin", "tailscale-user-login", "x-forwarded-for", "forwarded"].some((name) => headers.has(name));
}

// Every accepted delivery answers an empty 204: Claude reads that as a hook with no output, so
// nothing here can allow, deny or block (ADR 0057). A refusal is a non-blocking error to Claude.
const noOutput = () => secure(new Response(null, { status: 204 }));

export const hookRoutes: Route[] = [
  {
    method: "POST",
    path: CLAUDE_HOOK_PATH,
    access: "none",
    session: false,
    async handle(ctx, r) {
      if (!fromLocalClaude(r)) return text("forbidden", 403);
      if (!hookTokenMatches(r.req.headers.get(CLAUDE_HOOK_TOKEN_HEADER), await readHookToken(ctx.cfg.stateDir))) return text("forbidden", 403);
      if (Number(r.req.headers.get("content-length") ?? 0) > MAX_HOOK_BYTES) return text("too large", 413);
      const raw = await r.req.text();
      if (raw.length > MAX_HOOK_BYTES) return text("too large", 413);
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return text("bad request", 400);
      }
      const observation = decodeClaudeHook(body);
      if (!observation) return noOutput();
      for (const rt of ctx.registry.all()) {
        const paneId = paneForSession(rt.engine.current().agents, observation.sessionId);
        if (!paneId) continue;
        ctx.claudeHooks.receive(rt.name, paneId, observation);
        rt.engine.pokeNow();
      }
      return noOutput();
    },
  },
];
