import { journalPathResolver } from "../journal-watch.ts";
import { liveEventStream } from "../live-events.ts";
import type { EngineSnapshot } from "../state-engine.ts";
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
    async handle({ cfg, live, paneWatcher, journalWatch, journals, conversations, registry }, { req, url, rt, server }) {
      server.timeout(req, 0);
      journalWatch.resolveWith(journalPathResolver({ transcript: cfg.transcript, journals, conversations, registry }));
      // `?watch=<paneId>` names the panes this page shows. Only panes of the live herd are read, so a
      // client cannot point the watcher at arbitrary ids. A pane created a moment ago may not be in the
      // cached snapshot yet, so an unknown id costs one refresh before it is dropped.
      const asked = url.searchParams.getAll("watch");
      const known = (snapshot: EngineSnapshot) => new Set([...snapshot.agents, ...snapshot.shellPanes].map((pane) => pane.paneId));
      let herd = known(rt.engine.current());
      if (asked.some((id) => !herd.has(id))) herd = known(await rt.engine.refresh().catch(() => rt.engine.current()));
      // The watch ends with the stream, not only with the request: the stream also closes itself on a
      // client that stopped reading, and then the request's signal never aborts.
      const ended = new AbortController();
      const signal = AbortSignal.any([req.signal, ended.signal]);
      paneWatcher.watch(rt.name, rt.herdr, asked.filter((id) => herd.has(id)), signal);
      return secure(new Response(liveEventStream(live, rt.name, { signal, onClose: () => ended.abort() }), {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          "x-accel-buffering": "no",
        },
      }));
    },
  },
];
