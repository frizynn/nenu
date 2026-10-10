import { Navigate, useNavigate, useParams, useRevalidator, useRouteLoaderData } from "react-router";

import { ColumnPage } from "@/components/column-page";
import { ProjectTasks } from "@/components/project-tasks";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { nodePath, panePath } from "@/lib/nav";
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

  return <ColumnPage data={data} title={project?.name ?? "Project"}>
    {!project ? <p className="py-16 text-center text-sm text-muted-foreground">Project not found in this Herdr session.</p>
      : <ProjectTasks project={project} panes={data.agents} session={data.session} readOnly={isReadOnly(data.device)}
        onOpenPane={(id) => navigate(panePath(id, data.session))} onOpenNode={(id) => navigate(nodePath(project.slug, id, data.session))}
        onChanged={() => revalidator.revalidate()} />}
  </ColumnPage>;
}
