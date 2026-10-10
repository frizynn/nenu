import { useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useParams, useRevalidator, useRouteLoaderData } from "react-router";

import { AppHeader, SettingsGear } from "@/components/app-header";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { SpaceView } from "@/components/space-view";
import { useSpaceActions } from "@/hooks/use-spaces";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { homePath, panePath } from "@/lib/nav";
import { soloPane, workspaceName } from "@/lib/spaces";
import { setStatus } from "@/lib/status";
import { isReadOnly } from "@/lib/types";

/**
 * The tab last shown in each workspace, so Back from a pane lands on it. In memory, not in the URL:
 * a search param is a navigation, which waits on a snapshot read before the tab can change.
 */
const lastShownTab = new Map<string, string>();

// One workspace: its tabs and their panes, framed like the Home and project pages. Shares the root
// snapshot (no own loader) and reads :spaceId from the URL. Switching workspace is the sidebar's job
// (Browse on a phone), so the page lists no others. A workspace holding a single pane is that pane,
// the way a project with a live coordinator is its chat, so it opens straight onto it.
export function SpaceRoute() {
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  const { spaceId = "" } = useParams();
  // lastShownTab holds the pick; this only renders it. Tab ids are unique across workspaces.
  const [, setPicked] = useState<string>();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const { newTab } = useSpaceActions();

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

  const selectTab = (tabId: string) => {
    lastShownTab.set(spaceId, tabId);
    setPicked(tabId);
  };

  return (
    <div className="workbench-home flex min-h-0 min-w-0 flex-1 flex-col">
      <AppHeader bridge={data.bridge} error={data.error} onHome={() => navigate(homePath(data.session))}
        rightTrail={<SettingsGear session={data.session} />}>
        <span className="truncate text-sm font-medium">{workspace ? workspaceName(workspace) : "Workspace"}</span>
      </AppHeader>
      <ReadOnlyBanner device={data.device} />
      <main className="min-h-0 flex-1 overflow-y-auto px-4 pt-6 pb-[calc(env(safe-area-inset-bottom)+2rem)] sm:px-8 sm:pt-12">
        <div className="mx-auto w-full max-w-2xl">
          {workspace && (
            <SpaceView workspace={workspace} tabs={data.tabs} agents={data.agents} shellPanes={data.shellPanes}
              selectedTab={lastShownTab.get(spaceId) ?? null} onSelectTab={selectTab} onNewTab={() => newTab(workspace.workspaceId)}
              onChanged={() => revalidator.revalidate()} session={data.session} readOnly={isReadOnly(data.device)} />
          )}
        </div>
      </main>
    </div>
  );
}
