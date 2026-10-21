import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams, useRevalidator, useRouteLoaderData } from "react-router";
import { ChevronRight } from "@/components/ui/icon";

import { ColumnPage } from "@/components/column-page";
import { CoordinatorStatus } from "@/components/coordinator-status";
import { useOpenCoordinator, useOpenNode } from "@/components/desk-pages";
import { DeskProject, ProjectWork } from "@/components/desk-project";
import { NewNodeActions, startableRoles } from "@/components/node-start";
import { StartProjectCoordinator } from "@/components/project-coordinator";
import { NodeDot } from "@/components/node-row";
import { ProjectMissing } from "@/components/project-missing";
import { ProjectGlyph } from "@/components/project-glyph";
import { ProjectTasks, TasksHeader } from "@/components/project-tasks";
import { asksAvailable, useAsks } from "@/hooks/use-asks";
import { useDesk } from "@/hooks/use-desk";
import { coordinatorAsks } from "@/lib/asks";
import { useThreadSummaries } from "@/hooks/use-thread-summaries";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { asksPath, nodePath, panePath, projectsPath } from "@/lib/nav";
import { waitingGroups } from "@/lib/project-work";
import { organizes, orgTree } from "@/lib/org-tree";
import { isReadOnly, type ProjectView, type StatusFile } from "@/lib/types";
import { projectChat, runningCoordinator } from "@/lib/projects";

// On a desk a project is its own page, with tabs (ADR 0102); on a phone it is as before.
export function ProjectRoute() {
  return useDesk() ? <DeskProjectRoute /> : <PhoneProjectRoute />;
}

function DeskProjectRoute() {
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  const { projectSlug = "" } = useParams();
  const revalidator = useRevalidator();
  const project = data.projects?.find((candidate) => candidate.slug === projectSlug);
  return <ColumnPage data={data} title={project?.name ?? "Project"} back={{ label: "Projects", to: projectsPath(data.session), desk: true }}>
    {!project ? <ProjectMissing session={data.session} />
      // Keyed by project: its folds and reads are its own.
      : <DeskProject key={project.slug} project={project} panes={data.agents} device={data.device} session={data.session} onChanged={() => void revalidator.revalidate()} />}
  </ColumnPage>;
}

// A project with only its own coordinator opens on that coordinator's conversation; the pane route
// frames it with the task list. A project that organizes coordinators is their page (ADR 0092), drawn
// as a desk draws it: a row per coordinator that enters its chat, its threads folded under it, the
// project's own last with the threads started from the project (ADR 0113). Without a live coordinator
// and nothing to organize, the project is its organization: a way to start the coordinator, the open
// tree, History, and New.
function PhoneProjectRoute() {
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  const { projectSlug = "" } = useParams();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const project = data.projects?.find((candidate) => candidate.slug === projectSlug);
  const tree = project ? orgTree(project.threads) : undefined;
  const organizer = tree !== undefined && organizes(tree);
  const coordinator = projectChat(project, data.agents);
  const read = useThreadSummaries(coordinator ? undefined : project, []);
  // Whether its STATUS.md says something, for a project that organizes coordinators.
  const asks = useAsks(organizer ? data.projects : undefined);
  // Its STATUS.md heads the page, so the page waits for it (briefly) before drawing what it would push
  // down; a project read again draws it at once (useThreadSummaries).
  const waited = useWaited(projectSlug, HOLD_MS);
  const held = !waited && !(read.ready && asks.loaded);
  if (coordinator) return <Navigate to={panePath(coordinator, data.session)} replace />;

  // The project coordinator's STATUS.md heads the page, except where the project organizes
  // coordinators: there it is on its coordinator's page while that runs, and otherwise heads the
  // page only while it says something. An Organizations that predates the fields cannot tell, and shows it.
  const rootStatus = read.status ?? undefined;
  const says = (status: StatusFile) => !asksAvailable(data.projects) ||
    Boolean(status.objective || status.needsDecision?.length || coordinatorAsks(asks.list, projectSlug, "root")?.asks.length);
  const headStatus = !organizer || (project && !runningCoordinator(project) && rootStatus && says(rootStatus)) ? rootStatus : undefined;

  const waiting = project?.waitingAsks ?? 0;
  const readOnly = isReadOnly(data.device);

  // The goal stays on the desk's page: on a phone the name, what waits on you and what runs come first.
  return <ColumnPage data={data} title={project?.name ?? "Project"}>
    {!project ? <ProjectMissing session={data.session} /> : held ? null : <>
      <TasksHeader title={project.name} paused={project.status === "paused"} mark={<ProjectGlyph slug={project.slug} pick={project} size={20} className="mt-1" />} />
      {waiting > 0 && <Link to={asksPath(data.session, project.slug)}
        className="mb-4 flex min-h-11 items-center gap-2.5 rounded-xl border border-border bg-card px-3.5 py-2.5 text-subhead">
        <NodeDot state="needs" /><span className="flex-1 font-medium">{waiting === 1 ? "1 ask waits" : `${waiting} asks wait`} on you</span>
        <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
      </Link>}
      {/* Keyed by project: its folds are its own, and node ids repeat across projects. */}
      {organizer
        ? <PhoneWork key={project.slug} project={project} status={headStatus} data={data} waiting={(id) => asks.list ? waitingGroups(asks.list, project).find((group) => group.coordinator.id === id)?.count ?? 0 : 0} />
        : <ProjectTasks key={project.slug} project={project} bare status={headStatus} panes={data.agents} session={data.session} readOnly={readOnly}
          onOpenPane={(id) => navigate(panePath(id, data.session))} onOpenNode={(id) => navigate(nodePath(project.slug, id, data.session))}
          onChanged={() => revalidator.revalidate()} />}
    </>}
  </ColumnPage>;
}

/** A phone's project that organizes coordinators: its rows, as a desk draws them, and New under them. */
function PhoneWork({ project, status, data, waiting }: { project: ProjectView; status?: StatusFile; data: HomeData; waiting: (coordinatorId: string) => number }) {
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const openNode = useOpenNode(project, data.agents, data.session);
  const openCoordinator = useOpenCoordinator(project, data.agents, data.session);
  const readOnly = isReadOnly(data.device);
  const refresh = () => void revalidator.revalidate();
  return <>
    {status && <CoordinatorStatus status={status} project={project} onOpenNode={(id) => navigate(nodePath(project.slug, id, data.session))} />}
    <ProjectWork project={project} waiting={waiting} canStart={!readOnly && startableRoles(project).includes("worker")}
      onOpenNode={openNode} onOpenCoordinator={openCoordinator} onChanged={refresh} />
    {!readOnly && <div className="mt-4 flex flex-wrap gap-1">
      <NewNodeActions project={project} session={data.session} onStarted={refresh} />
      <StartProjectCoordinator project={project} session={data.session} onStarted={refresh} />
    </div>}
  </>;
}

/** How long a project page waits for what heads it before it draws without it. */
const HOLD_MS = 1_000;

/** True once `ms` have passed since `key` was first shown. */
function useWaited(key: string, ms: number): boolean {
  const [waited, setWaited] = useState<string>();
  useEffect(() => {
    const timer = setTimeout(() => setWaited(key), ms);
    return () => clearTimeout(timer);
  }, [key, ms]);
  return waited === key;
}
