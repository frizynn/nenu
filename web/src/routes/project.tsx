import { Navigate, useNavigate, useParams, useRevalidator, useRouteLoaderData } from "react-router";

import { AppHeader, SettingsGear } from "@/components/app-header";
import { ProjectTasks } from "@/components/project-tasks";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { homePath, nodePath, panePath } from "@/lib/nav";
import { isReadOnly } from "@/lib/types";

// A project opens on its coordinator's conversation; the pane route frames it with the task list.
// Without a live coordinator there is no conversation to show, so the project is its organization:
// a way to start the coordinator, the open tree, History, and New.
export function ProjectRoute() {
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  const { projectSlug = "" } = useParams();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const project = data.projects?.find((candidate) => candidate.slug === projectSlug);
  const coordinator = project?.coordinator?.paneId;
  if (coordinator && data.agents.some((pane) => pane.paneId === coordinator)) {
    return <Navigate to={panePath(coordinator, data.session)} replace />;
  }

  return <div className="workbench-home flex min-h-0 min-w-0 flex-1 flex-col">
    <AppHeader bridge={data.bridge} error={data.error} onHome={() => navigate(homePath(data.session))}
      rightTrail={<SettingsGear session={data.session} />}>
      <span className="truncate text-sm font-medium">{project?.name ?? "Project"}</span>
    </AppHeader>
    <ReadOnlyBanner device={data.device} />
    <main className="min-h-0 flex-1 overflow-y-auto px-4 pt-6 pb-[calc(env(safe-area-inset-bottom)+2rem)] sm:px-8 sm:pt-12">
      <div className="mx-auto w-full max-w-2xl">
        {!project ? <p className="py-16 text-center text-sm text-muted-foreground">Project not found in this Herdr session.</p>
          : <ProjectTasks project={project} panes={data.agents} session={data.session} readOnly={isReadOnly(data.device)}
            onOpenPane={(id) => navigate(panePath(id, data.session))} onOpenNode={(id) => navigate(nodePath(project.slug, id, data.session))}
            onChanged={() => revalidator.revalidate()} />}
      </div>
    </main>
  </div>;
}
