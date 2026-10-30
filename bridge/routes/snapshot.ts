import { shownStatus } from "../activity.ts";
import { hcSessionMachine, isHcSession } from "../hc-core.ts";
import { computeEtag, JsonBody, notModified, notModifiedResponse } from "../http-cache.ts";
import type { SessionRuntime } from "../sessions.ts";
import { toPaneWire, type AgentView, type MachineHerd, type MachineView, type SnapshotResponse } from "../types.ts";
import { deviceAuth } from "./access.ts";
import type { Route, Services } from "./context.ts";
import { buildId, secure, withBuildHeader } from "./http.ts";

// ── Live state (polled by the client) ────────────────────────────────
export const snapshotRoutes: Route[] = [
  {
    method: "*",
    path: "/api/snapshot",
    access: "read",
    session: true,
    async handle(ctx, { req, rt }) {
      const { cfg, registry, machines } = ctx;
      const herd = herdOf(ctx, rt);
      const device = deviceAuth(req, cfg);
      machines.refresh();
      const others = joinedMachines(ctx, machines.views(undefined, null));
      const view: Omit<SnapshotResponse, "ts"> = {
        bridge: herd.bridge,
        // Only report device state when the feature is on, so an off deployment sends nothing new.
        ...(device.enforced ? { device } : {}),
        agents: herd.agents,
        shellPanes: herd.shellPanes,
        workspaces: herd.workspaces,
        tabs: herd.tabs,
        // Only the list's version: the list itself is most of the herd's bytes and changes far less often.
        pullRequestsEtag: pullRequestBody(ctx, rt).etag,
        sessions: registry.list(),
        notifications: { snoozedUntil: ctx.snooze.until() },
        update: ctx.updateMonitor.status(),
        // Absent while Herdr has no saved machine, so one machine's snapshot (and its ETag) is unchanged.
        ...(others ? { machines: others } : {}),
      };
      return respond(req, view);
    },
  },
  {
    method: "GET",
    path: "/api/pull-requests",
    access: "read",
    session: true,
    // Another machine's pull requests stay there (machineSnapshot).
    machine: false,
    handle(ctx, { req, rt }) {
      const body = pullRequestBody(ctx, rt);
      const etag = body.etag;
      if (notModified(req.headers.get("if-none-match"), etag)) return secure(notModifiedResponse(etag));
      return secure(body.response(req.headers.get("accept-encoding"), { etag }));
    },
  },
];

/**
 * The machines a session runs on: hc's `hc@<machine>` on that machine, every other session (Herdr's own and
 * hc's `hc`) on this one, named by its host. Each session by the key a row carries, "" for the primary.
 */
export function machineGroups(sessions: ReadonlyArray<{ name: string; isPrimary: boolean }>, host: string): Array<{ label: string; sessions: string[] }> {
  const groups = new Map<string, string[]>([[host, []]]);
  for (const session of sessions) {
    const label = hcSessionMachine(session.name) || host;
    groups.set(label, [...(groups.get(label) ?? []), session.isPrimary ? "" : session.name]);
  }
  return [...groups].map(([label, keys]) => ({ label, sessions: keys }));
}

/**
 * With herdr-core on, the lists show machines, not sessions (ADR 0136): this one joins Herdr's sessions
 * and hc's, each other machine is its hc session, and every machine carries its whole herd with each row's
 * session. Herdr's own other machines follow. Without hc, Herdr's machines as they were.
 */
function joinedMachines(ctx: Services, herdrMachines: MachineView[] | undefined): MachineView[] | undefined {
  if (!ctx.registry.list().some((s) => isHcSession(s.name))) return herdrMachines;
  const runtimes = ctx.registry.all();
  const byKey = new Map(runtimes.map((r) => [r.isPrimary ? "" : r.name, r]));
  const views = machineGroups(runtimes, ctx.machines.hostLabel).map(({ label, sessions }): MachineView => {
    const live = sessions.map((key) => byKey.get(key)!).filter((r) => r.engine.current().bridge === "connected");
    const herds = live.map((r) => stamped(r.isPrimary ? "" : r.name, herdOf(ctx, r)));
    return {
      label,
      sessions,
      state: live.length ? "connected" : "offline",
      ...(herds.length ? { herd: {
        bridge: "connected",
        agents: herds.flatMap((h) => h.agents),
        shellPanes: herds.flatMap((h) => h.shellPanes),
        workspaces: herds.flatMap((h) => h.workspaces),
        tabs: herds.flatMap((h) => h.tabs),
      } } : {}),
    };
  });
  return [...views, ...(herdrMachines ?? []).filter((m) => m.session)];
}

/** A herd whose every row names the session it opens in. */
function stamped(session: string, herd: MachineHerd): MachineHerd {
  const mark = <T extends object>(row: T) => ({ ...row, session });
  return { bridge: herd.bridge, agents: herd.agents.map(mark), shellPanes: herd.shellPanes.map(mark), workspaces: herd.workspaces.map(mark), tabs: herd.tabs.map(mark) };
}

/**
 * The session's open pull requests with the panes on each branch; reading them asks for a refresh when
 * stale. The snapshot's `pullRequestsEtag` and this route both come from here, so they always agree.
 */
function pullRequestBody({ pullRequests }: Services, rt: SessionRuntime): JsonBody {
  const { agents, shellPanes } = rt.engine.current();
  return new JsonBody(pullRequests.list(rt.name, [...agents, ...shellPanes]));
}

/**
 * A session's herd as the snapshot shows it. The CLIs' own turn state (ADR 0067) and each pane's
 * activity timestamps, with the status they imply (shownStatus), are attached at serialise time so the
 * engine stays a pure Herdr poller and the numbers are as fresh as the request. A dialog Herdr's
 * manifest does not name leaves the pane `unknown`; the bridge's card says it asks.
 */
function herdOf({ activity, agentStates, agentNotify, hasJournal, interactions }: Services, rt: SessionRuntime): MachineHerd {
  const { agents, shellPanes, workspaces, tabs, bridge } = rt.engine.current();
  agentStates.sync(rt.name, rt.herdr, agents);
  const withActivity = (p: AgentView): AgentView => {
    const a = activity.get(rt.name, p.paneId);
    const withTurn = agentStates.attach(rt.name, p);
    const status = shownStatus(p.status, a, interactions.current(rt.name, p.paneId) !== null);
    return a ? { ...withTurn, status, lastActiveAt: a.activeAt, lastSeenAt: a.seenAt } : { ...withTurn, status };
  };
  // Only an agent pushes, so only an agent carries its notifications switch.
  const notify = agentNotify?.switches(rt.name);
  const withNotify = (p: AgentView): AgentView => notify ? { ...p, notify: notify(p.paneId) } : p;
  const shown = { agents: agents.map((p) => withNotify(withActivity(p))), shellPanes: shellPanes.map(withActivity) };
  // The one place a pane leaves the bridge: the session ref is stripped to a presence flag here, so
  // an agent-reported filesystem path never reaches a browser (see toPaneWire). The flag is computed
  // against the registry, so a harness Herdr detects but Nenu has no journal for doesn't advertise a
  // History button that can only ever come back empty.
  return {
    bridge,
    agents: shown.agents.map((p) => toPaneWire(p, hasJournal)),
    shellPanes: shown.shellPanes.map((p) => toPaneWire(p, hasJournal)),
    workspaces,
    tabs,
  };
}

/**
 * The ETag covers everything but `ts`, so an unchanged herd answers 304 instead of a fresh body per
 * poll per device. Every response, 304 included, carries the on-disk build id so an open client
 * notices a live rebuild between polls (web/src/lib/self-update.ts).
 */
async function respond(req: Request, view: Omit<SnapshotResponse, "ts">): Promise<Response> {
  const etag = computeEtag(JSON.stringify(view));
  const build = await buildId();
  if (notModified(req.headers.get("if-none-match"), etag)) return withBuildHeader(secure(notModifiedResponse(etag)), build);
  const body = new JsonBody({ ...view, ts: Date.now() } satisfies SnapshotResponse);
  return withBuildHeader(secure(body.response(req.headers.get("accept-encoding"), { etag })), build);
}

/**
 * The snapshot of another machine (`?session=@<label>`): its herd as its own Nenu answers it now, with
 * this bridge's device, update, sessions and notifications, and every machine's list but its own. Its
 * pull requests stay there: no `pullRequestsEtag`, so the page reads none. Its build and update are its
 * own business, so this page never reloads or nags over the other machine's version.
 */
export async function machineSnapshot(ctx: Services, req: Request, session: string): Promise<Response> {
  ctx.machines.refresh();
  const remote = await ctx.machines.snapshot(session);
  if (!remote) {
    const view = ctx.machines.views(session, null)?.find((m) => m.session === session);
    return Response.json({ error: view?.detail ?? "Machine not connected", machine: view?.state ?? "offline" }, { status: 503 });
  }
  const primary = ctx.registry.get(undefined);
  const device = deviceAuth(req, ctx.cfg);
  const herd = remote as Partial<MachineHerd>;
  const view: Omit<SnapshotResponse, "ts"> = {
    bridge: herd.bridge ?? "disconnected",
    ...(device.enforced ? { device } : {}),
    agents: herd.agents ?? [],
    shellPanes: herd.shellPanes ?? [],
    workspaces: herd.workspaces ?? [],
    tabs: herd.tabs ?? [],
    sessions: ctx.registry.list(),
    notifications: { snoozedUntil: ctx.snooze.until() },
    update: ctx.updateMonitor.status(),
    machines: ctx.machines.views(session, primary ? herdOf(ctx, primary) : null),
  };
  return respond(req, view);
}
