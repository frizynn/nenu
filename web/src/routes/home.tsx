import { useState } from "react";
import { useNavigate, useRouteLoaderData } from "react-router";
import { Plus } from "lucide-react";

import { AppHeader, SettingsGear } from "@/components/app-header";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { SpaceOverview } from "@/components/space-overview";
import { ProjectOverview } from "@/components/project-overview";
import { NewSpaceSheet } from "@/components/new-space-sheet";
import { openForCount, useDashPrefs } from "@/hooks/use-dash-prefs";
import { useSpaceActions } from "@/hooks/use-spaces";
import { useLoadingStalled } from "@/hooks/use-loading-stalled";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { panePath, projectPath, spacePath } from "@/lib/nav";
import { isReadOnly } from "@/lib/types";

// T3's index route centers the next useful action. Existing Nenu sessions are opened explicitly;
// creating a workspace uses the established shell flow, without claiming to have started an agent.
export function HomeRoute() {
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  const navigate = useNavigate();
  const { newSpace } = useSpaceActions();
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);
  const { prefs, setSpacesOpen } = useDashPrefs();
  const stalled = useLoadingStalled();
  const canCreate = !isReadOnly(data.device) && !data.error && data.bridge === "connected";
  const spacesOpen = openForCount(prefs.spacesOpen, data.workspaces.length);

  return <div className="workbench-home flex min-h-0 min-w-0 flex-1 flex-col">
    <AppHeader bridge={data.bridge} error={data.error} stalled={stalled}
      rightTrail={<><span className="text-xs tabular-nums text-muted-foreground">{data.projects?.length ?? 0} {(data.projects?.length ?? 0) === 1 ? "project" : "projects"}</span><SettingsGear session={data.session} /></>}>
      <span className="truncate text-sm font-medium">Home</span>
    </AppHeader>
    <ReadOnlyBanner device={data.device} />
    <main className="min-h-0 flex-1 overflow-y-auto px-5 py-10 sm:px-8 sm:py-14">
      <div className="mx-auto w-full max-w-2xl">
        <div className="mb-10">
          <h1 className="text-2xl font-medium tracking-tight sm:text-3xl">What should we work on?</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {data.error ? "Showing your last workspace snapshot. Reconnect to see current activity."
              : data.bridge !== "connected" ? "Waiting for your workspaces to connect."
              : data.projects?.length ? "Choose a project to see its coordinator and threads."
              : data.agents.length ? "Choose a workspace, then a tab or pane."
              : data.workspaces.length ? "Open a workspace to start or resume an agent."
              : "Create a workspace to start your first thread."}
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <button type="button" disabled={!canCreate} onClick={() => setNewSpaceOpen(true)} className="inline-flex min-h-11 items-center gap-2 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
              <Plus aria-hidden="true" className="size-3.5" />New workspace
            </button>
          </div>
        </div>

        <ProjectOverview projects={data.projects ?? []} onOpen={(slug) => navigate(projectPath(slug, data.session))} />

        <SpaceOverview
          workspaces={data.workspaces}
          tabs={data.tabs}
          agents={data.agents}
          shellPanes={data.shellPanes}
          onOpen={(workspaceId) => navigate(spacePath(workspaceId, data.session))}
          onOpenPane={(paneId) => navigate(panePath(paneId, data.session))}
          onNewSpace={() => setNewSpaceOpen(true)}
          open={spacesOpen}
          onOpenChange={setSpacesOpen}
        />
      </div>
    </main>
    <NewSpaceSheet open={newSpaceOpen} onClose={() => setNewSpaceOpen(false)} onCreate={newSpace} />
  </div>;
}
