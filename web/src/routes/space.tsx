import { useEffect, useRef } from "react";
import { Navigate, useNavigate, useParams, useRevalidator, useRouteLoaderData } from "react-router";

import { ColumnPage } from "@/components/column-page";
import { SpaceView } from "@/components/space-view";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { homePath, panePath } from "@/lib/nav";
import { soloPane, workspaceName } from "@/lib/spaces";
import { openNewAgent } from "@/lib/spawn";
import { setStatus } from "@/lib/status";
import { isReadOnly } from "@/lib/types";

// One workspace: its tabs and their panes, in the project pages' frame. Shares the root snapshot
// (no own loader) and reads :spaceId from the URL. Switching workspace is the sidebar's job (Browse
// on a phone), so the page lists no others. A workspace holding a single pane is that pane, the way
// a project with a live coordinator is its chat, so it opens straight onto it.
export function SpaceRoute() {
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  const { spaceId = "" } = useParams();
  const navigate = useNavigate();
  const revalidator = useRevalidator();

  const workspace = data.workspaces.find((w) => w.workspaceId === spaceId);

  // Recover from a deleted space: once a healthy snapshot no longer has it, bounce to the dashboard
  // instead of leaving you on an empty shell. Guarded on a connected, non-stale snapshot so a
  // transient poll failure or a reconnect (or an idle-lock remount where the space died while locked)
  // doesn't evict a still-valid one. Mirrors DetailRoute's closed-pane recovery.
  // Tell "closed under you" apart from "deep-link that never resolved": track whether we ever saw
  // this space (a ref write during render is idempotent). "Space closed" would misdescribe
  // /space/<bad-id>, which was never open.
  const gone = !workspace;
  const everExisted = useRef(false);
  if (workspace) everExisted.current = true;
  useEffect(() => {
    if (gone && data.bridge === "connected" && !data.error) {
      setStatus(everExisted.current ? "Space closed" : "Space not found", "info");
      navigate(homePath(data.session), { replace: true });
    }
  }, [gone, data.bridge, data.error, data.session, navigate]);

  const solo = workspace && soloPane(workspace.workspaceId, data.agents, data.shellPanes);
  if (solo) return <Navigate to={panePath(solo.paneId, data.session)} replace />;

  return (
    <ColumnPage data={data} title={workspace ? workspaceName(workspace) : "Workspace"}>
      {/* Keyed, so another workspace starts from the tab it last showed rather than this one's. */}
      {workspace && (
        <SpaceView key={workspace.workspaceId} workspace={workspace} tabs={data.tabs} agents={data.agents} shellPanes={data.shellPanes}
          onNewTab={() => openNewAgent({ kind: "tab", workspaceId: workspace.workspaceId })}
          onChanged={() => revalidator.revalidate()} session={data.session} readOnly={isReadOnly(data.device)} />
      )}
    </ColumnPage>
  );
}
