import { journalPathResolver } from "../journal-watch.ts";
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
    handle({ cfg, live, paneWatcher, journalWatch, journals, conversations, registry }, { req, url, rt, server }) {
      server.timeout(req, 0);
      journalWatch.resolveWith(journalPathResolver({ transcript: cfg.transcript, journals, conversations, registry }));
      // `?watch=<paneId>` names the panes this page shows. Only panes of the live herd are read, so a
      // client cannot point the watcher at arbitrary ids.
      const { agents, shellPanes } = rt.engine.current();
      const known = new Set([...agents, ...shellPanes].map((pane) => pane.paneId));
      paneWatcher.watch(rt.name, rt.herdr, url.searchParams.getAll("watch").filter((id) => known.has(id)), req.signal);
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
