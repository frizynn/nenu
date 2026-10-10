import { toPaneWire, type AgentView, type SnapshotResponse } from "../types.ts";
import { deviceAuth } from "./access.ts";
import type { Route } from "./context.ts";
import { buildId, json, withBuildHeader } from "./http.ts";

// ── Live state (polled by the client) ────────────────────────────────
export const snapshotRoutes: Route[] = [
  {
    method: "*",
    path: "/api/snapshot",
    access: "read",
    session: true,
    async handle({ cfg, activity, hasJournal, projects, registry, snooze, updateMonitor }, { req, rt }) {
      const { agents, shellPanes, workspaces, tabs, bridge } = rt.engine.current();
      const device = deviceAuth(req, cfg);
      // Attach each pane's activity timestamps. Done here rather than in the state engine so the
      // engine stays a pure Herdr-poller with no knowledge of the ledger — and so the two numbers
      // are read at serialise time, i.e. as fresh as the request.
      const withActivity = (p: AgentView): AgentView => {
        const a = activity.get(rt.name, p.paneId);
        return a ? { ...p, lastActiveAt: a.activeAt, lastSeenAt: a.seenAt } : p;
      };
      // Tag every snapshot poll with the on-disk build id so an open client notices a live rebuild
      // between polls — the no-service-worker self-update path (web/src/lib/self-update.ts).
      return withBuildHeader(
        json({
          bridge,
          // Only report device state when the feature is on, so an off deployment sends nothing new.
          ...(device.enforced ? { device } : {}),
          // The one place a pane leaves the bridge: the session ref is stripped to a presence flag
          // here, so an agent-reported filesystem path never reaches a browser (see toPaneWire).
          // The flag is computed against the registry, so a harness Herdr detects but Nenu has no
          // journal for doesn't advertise a History button that can only ever come back empty.
          // withActivity runs FIRST: it returns an AgentView, which is what toPaneWire consumes,
          // and the two timestamps then ride through its rest-spread onto the wire shape.
          agents: agents.map((p) => toPaneWire(withActivity(p), hasJournal)),
          shellPanes: shellPanes.map((p) => toPaneWire(withActivity(p), hasJournal)),
          workspaces,
          tabs,
          projects: projects.list(rt.name, rt.isPrimary, [...agents, ...shellPanes]),
          sessions: registry.list(),
          notifications: { snoozedUntil: snooze.until() },
          update: updateMonitor.status(),
          ts: Date.now(),
        } satisfies SnapshotResponse, req.headers.get("accept-encoding")),
        await buildId(),
      );
    },
  },
];
