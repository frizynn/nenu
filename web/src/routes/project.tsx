import { Navigate, useNavigate, useParams, useRevalidator, useRouteLoaderData } from "react-router";

import { ColumnPage } from "@/components/column-page";
import { CoordinatorHead } from "@/components/coordinator-card";
import { ProjectMissing } from "@/components/project-missing";
import { ProjectTasks, organizes } from "@/components/project-tasks";
import { asksAvailable, useAsks } from "@/hooks/use-asks";
import { coordinatorAsks } from "@/lib/asks";
import { useThreadSummaries } from "@/hooks/use-thread-summaries";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { nodePath, panePath } from "@/lib/nav";
import { openCoordinators, orgTree, type OrgNode } from "@/lib/org-tree";
import { isReadOnly, type StatusFile } from "@/lib/types";
import { liveCoordinator, runningCoordinator } from "@/lib/projects";

// A project with only its own coordinator opens on that coordinator's conversation; the pane route
// frames it with the task list. A project that organizes coordinators is their page (ADR 0092): each
// one folds over its card and work, the project's own first while it runs, and the threads at the top
// level apart. Without a live coordinator either way, the project is its organization: a way to start
// the coordinator, the open tree, History, and New.
export function ProjectRoute() {
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  const { projectSlug = "" } = useParams();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const project = data.projects?.find((candidate) => candidate.slug === projectSlug);
  const tree = project ? orgTree(project.threads) : undefined;
  const organizer = tree !== undefined && organizes(tree);
  const coordinator = organizer ? undefined : liveCoordinator(project, data.agents);
  const coordinators = organizer && tree ? openCoordinators(tree).map(({ node }) => node.thread) : [];
  const read = useThreadSummaries(coordinator ? undefined : project, coordinators);
  // Only the cards read the asks, and only a project that organizes coordinators draws them.
  const asks = useAsks(organizer ? data.projects : undefined);
  if (coordinator) return <Navigate to={panePath(coordinator, data.session)} replace />;

  // The project coordinator's STATUS.md heads the page, except where the project organizes
  // coordinators: there it sits under its coordinator's card while that runs, and otherwise heads the
  // page only while it says something. An Organizations that predates the fields cannot tell, and shows it.
  const rootStatus = read.status ?? undefined;
  const says = (status: StatusFile) => !asksAvailable(data.projects) ||
    Boolean(status.objective || status.needsDecision?.length || coordinatorAsks(asks.list, projectSlug, "root")?.asks.length);
  const headStatus = !organizer || (project && !runningCoordinator(project) && rootStatus && says(rootStatus)) ? rootStatus : undefined;

  const live = (paneId: string | undefined) => paneId !== undefined && data.agents.some((pane) => pane.paneId === paneId);
  const openNode = ({ thread }: OrgNode) =>
    navigate(thread.paneId && live(thread.paneId) ? panePath(thread.paneId, data.session) : nodePath(projectSlug, thread.id, data.session));
  const card = (coordinatorId: string) => project && <CoordinatorHead project={project} coordinatorId={coordinatorId} listsAgents={false}
    status={(coordinatorId === "root" ? read.status : read.summaries.get(coordinatorId)?.status) ?? undefined}
    usage={(coordinatorId === "root" ? read.usage : read.summaries.get(coordinatorId)?.usage) ?? undefined}
    asks={asks} summaries={read.summaries} onOpenNode={openNode} onOpenStatusNode={(id) => navigate(nodePath(projectSlug, id, data.session))} />;

  return <ColumnPage data={data} title={project?.name ?? "Project"}>
    {!project ? <ProjectMissing session={data.session} />
      // Keyed by project: its folds are its own, and node ids repeat across projects.
      : <ProjectTasks key={project.slug} project={project} status={headStatus} panes={data.agents} session={data.session} readOnly={isReadOnly(data.device)}
        organize={{ card }}
        onOpenPane={(id) => navigate(panePath(id, data.session))} onOpenNode={(id) => navigate(nodePath(project.slug, id, data.session))}
        onChanged={() => revalidator.revalidate()} />}
  </ColumnPage>;
}
