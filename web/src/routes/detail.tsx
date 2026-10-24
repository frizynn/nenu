import { useCallback, useEffect, useMemo, useRef } from "react";
import { useLoaderData, useLocation, useNavigate, useParams, useRouteLoaderData } from "react-router";

import { AgentChat } from "@/components/agent-chat";
import { useRevalidate } from "@/hooks/use-router";
import { InspectorToggle, panelLink, SessionInspector, sessionPr, useSessionInspector } from "@/components/session-inspector";
import { ROOT_ROUTE_ID, type HomeData, type PaneData } from "@/lib/loaders";
import { currentMachine } from "@/lib/machines";
import { useGoBack } from "@/lib/motion";
import { homePath, panePath } from "@/lib/nav";
import { displayName } from "@/lib/display-name";
import { paneAfterClose, tabName } from "@/lib/spaces";
import { narrowRevalidation } from "@/lib/revalidation";
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
  const goBack = useGoBack();
  const location = useLocation();
  const revalidate = useRevalidate();
  // Kept here, above the frames, so a switch between sessions leaves the desk's panel as it was.
  const inspector = useSessionInspector();

  // The loader opened the chat before the pane's read landed (paneLoader): ask for that read now, so
  // it shows as soon as it lands rather than at the next poll. Only the pane loader re-runs.
  useEffect(() => {
    if (!pane.pending) return;
    narrowRevalidation("pane");
    void revalidate();
  }, [pane, revalidate]);

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
  const gone = !agent;

  // The pane beside a closed one (paneAfterClose): where the route moves, and what the closed view offers.
  const last = gone && seen ? lastListed.current : null;
  const nextId = last ? paneAfterClose(last.pane, last.tabs, root) : undefined;
  const next = nextId === undefined ? undefined : root.agents.find((p) => p.paneId === nextId) ?? root.shellPanes.find((p) => p.paneId === nextId);

  // Recover from a closed pane, whether Herdr or this page closed it: once a healthy snapshot no
  // longer has it, open the pane beside it instead of leaving you on a dead view, and go Home only
  // when its workspace has nothing left. The notice names what closed and where you are now. Guarded
  // on a connected, non-stale snapshot so a transient poll failure or reconnect doesn't evict a
  // still-valid pane; until then the chat shows the closed view with the same two ways on.
  useEffect(() => {
    if (!gone || root.bridge !== "connected" || root.error) return;
    setStatus(closedNotice(last, next, root), "info");
    navigate(next ? panePath(next.paneId, session) : homePath(session), { replace: true });
  }, [gone, last, next, root, navigate, session]);

  // Stable while the herd and the inspector are, so a revalidation that changed neither (a live event
  // naming only the mirror, and the "loading" render of every run) leaves the memoised chat alone.
  const pr = useMemo(() => sessionPr(root, paneId), [root.pullRequests, paneId]);
  // The inspector is a new object each render; what the toggle and the panel link read of it is these
  // fields, and its functions only reach refs and state setters, so an older closure does the same.
  const { desk, open, terminal } = inspector;
  const headerTrail = useMemo(() => desk && !open ? <InspectorToggle inspector={inspector} pr={pr} /> : undefined,
    [desk, open, pr]);
  const sessionPanel = useMemo(() => desk ? panelLink(inspector) : undefined, [desk, terminal]);
  // Nothing above a chat but Home.
  const onBack = useCallback(() => goBack(homePath(session)), [goBack, session]);
  // A tab or pane switch is a step sideways, not deeper: it replaces this chat in history, so
  // the browser's back leaves the chat instead of walking back through every pane visited.
  const onSelect = useCallback((id: string) => navigate(panePath(id, session), { replace: true }), [navigate, session]);
  return (
    <div className="project-frame">
      <AgentChat
        key={paneId}
        headerTrail={headerTrail}
        sessionPanel={sessionPanel}
        paneId={paneId}
        session={session}
        machine={currentMachine(root)?.label}
        agent={agent}
        closed={last?.pane}
        next={next}
        agents={root.agents}
        shellPanes={root.shellPanes}
        tabs={root.tabs}
        text={pane.text}
        pending={pane.pending}
        nativeTelemetry={pane.nativeTelemetry}
        atPrompt={pane.atPrompt}
        requestedLines={pane.requestedLines}
        revision={pane.revision}
        device={root.device}
        bridge={root.bridge}
        error={root.error}
        authError={root.authError || pane.authError}
        onBack={onBack}
        onSelect={onSelect}
      />
      {inspector.desk && inspector.open && <SessionInspector inspector={inspector} paneId={paneId} session={session}
        artifacts={root.agents.some((pane) => pane.paneId === paneId)} pr={pr} />}
    </div>
  );
}

/** What closed and where the route went: a link to a pane this page never saw names no pane at all. */
function closedNotice(last: { pane: AgentView; tabs: TabView[] } | null, next: AgentView | undefined, now: HomeData): string {
  if (!last) return "That pane no longer exists";
  const tabs = last.tabs.filter((t) => t.workspaceId === last.pane.workspaceId);
  const tab = tabs.find((t) => t.tabId === last.pane.tabId);
  const tabClosed = tab !== undefined && !now.tabs.some((t) => t.tabId === tab.tabId);
  const what = tabClosed ? `Tab ${tabName(tab.label, tabs.indexOf(tab) + 1)}` : displayName(last.pane);
  return `${what} closed · ${next ? `showing ${displayName(next)}` : "back to Home"}`;
}
