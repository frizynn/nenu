import { useEffect, useRef } from "react";
import { useLoaderData, useLocation, useNavigate, useParams, useRouteLoaderData } from "react-router";

import { AgentChat } from "@/components/agent-chat";
import { ProjectFrame, type ProjectChatSlots } from "@/components/project-frame";
import { ROOT_ROUTE_ID, type HomeData, type PaneData } from "@/lib/loaders";
import { homePath, panePath } from "@/lib/nav";
import { projectForPane } from "@/lib/projects";
import { paneAfterClose } from "@/lib/spaces";
import { setStatus } from "@/lib/status";
import type { AgentView, TabView } from "@/lib/types";

// Pane detail route. Pane output comes from this route's loader; the pane's metadata comes from the
// shared snapshot (root loader). The pane may be an agent OR a bare shell. A just-created shell
// isn't in the snapshot yet, so we fall back to the `freshPane` passed via navigation state — the
// composer stays live immediately while polling catches the snapshot up. Keyed by paneId so
// switching panes remounts the composer fresh.
export function DetailRoute() {
  const pane = useLoaderData() as PaneData;
  const root = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  const { paneId = "" } = useParams();
  // The session this pane belongs to (undefined = primary), read from the pane loader so every
  // navigation and write below stays scoped to it.
  const session = pane.session;
  const navigate = useNavigate();
  const location = useLocation();

  const fresh = (location.state as { freshPane?: AgentView } | null)?.freshPane;
  const listed =
    root.agents.find((a) => a.paneId === paneId) ??
    root.shellPanes.find((p) => p.paneId === paneId);
  // The freshPane is a bootstrap only — used before a just-created pane first appears in a snapshot.
  // Once it's been seen, retire it; otherwise the stale copy masks a pane that has since closed
  // (e.g. you ran `exit` in its shell), stranding you on a dead view.
  //
  // Track *which* pane has been seen, not just a boolean: DetailRoute doesn't remount on a pane→pane
  // navigation (only `key={paneId}` on AgentChat does), so a lifetime boolean would carry the prior
  // pane's "seen" state onto a freshly-created one — disabling its freshPane fallback before the
  // snapshot catches up, so `gone` flips true and the effect below bounces you Home. That's the
  // "create a tab from inside an open pane sends me home" bug. The tabs of that snapshot say where
  // the pane sat, which a later snapshot without it can no longer tell.
  const lastListed = useRef<{ pane: AgentView; tabs: TabView[] } | null>(null);
  if (listed) lastListed.current = { pane: listed, tabs: root.tabs };
  const seen = lastListed.current?.pane.paneId === paneId;

  const agent = listed ?? (fresh && fresh.paneId === paneId && !seen ? fresh : undefined);
  const tabLabel = root.tabs.find((t) => t.tabId === agent?.tabId)?.label;
  const owner = projectForPane(root.projects, paneId);
  const project = owner?.project;
  const gone = !agent;

  // Recover from a closed pane, whether Herdr or this page closed it: once a healthy snapshot no
  // longer has it, open the pane beside it (paneAfterClose) instead of leaving you on a dead "agent
  // gone" view, and go Home only when its workspace has nothing left. Guarded on a connected,
  // non-stale snapshot so a transient poll failure or reconnect doesn't evict a still-valid pane.
  useEffect(() => {
    if (!gone || root.bridge !== "connected" || root.error) return;
    const last = seen ? lastListed.current : null;
    const next = last ? paneAfterClose(last.pane, last.tabs, root) : undefined;
    const tabClosed = last !== null && !root.tabs.some((t) => t.tabId === last.pane.tabId);
    setStatus(tabClosed ? "Tab closed" : "Pane closed", "info");
    navigate(next ? panePath(next, session) : homePath(session), { replace: true });
  }, [gone, seen, root, navigate, session]);

  const chat = (slots: Partial<ProjectChatSlots> = {}) => (
    <AgentChat
      key={paneId}
      {...slots}
      paneId={paneId}
      session={session}
      agent={agent}
      project={project ? { slug: project.slug, name: project.name, role: owner?.thread?.role ?? "coordinator" } : undefined}
      agents={root.agents}
      shellPanes={root.shellPanes}
      tabs={root.tabs}
      tabLabel={tabLabel}
      text={pane.text}
      nativeTelemetry={pane.nativeTelemetry}
      requestedLines={pane.requestedLines}
      revision={pane.revision}
      device={root.device}
      bridge={root.bridge}
      error={root.error}
      authError={root.authError || pane.authError}
      // A project's page opens its coordinator, so leaving a project pane goes Home, not back into it.
      onBack={() => navigate(homePath(session))}
      onSelect={(id) => navigate(panePath(id, session))}
    />
  );

  return owner ? <ProjectFrame owner={owner} paneId={paneId} data={root}>{chat}</ProjectFrame> : chat();
}
