import { liveEventStream } from "../live-events.ts";
import type { Route } from "./context.ts";
import { secure } from "./http.ts";

// ── Live invalidations (Server-Sent Events) ─────────────────────────
// Read-level like the snapshot: it names what changed and carries no pane content, so the page
// re-reads through the routes above. No idle timeout: the stream is quiet between changes.
export const eventRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/events",
    access: "read",
    session: true,
    handle({ live, paneWatcher }, { req, url, rt, server }) {
      server.timeout(req, 0);
      // `?watch=<paneId>` names the panes this page shows, for the bridge-side pane watcher.
      paneWatcher.watch(rt.name, url.searchParams.getAll("watch"), req.signal);
      return secure(new Response(liveEventStream(live, rt.name, { signal: req.signal }), {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          "x-accel-buffering": "no",
        },
      }));
    },
  },
];
