import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams, useRevalidator, useRouteLoaderData } from "react-router";
import { ChevronRight } from "@/components/ui/icon";

import { ColumnPage } from "@/components/column-page";
import { DeskProject } from "@/components/desk-project";
import { NodeDot } from "@/components/node-row";
import { ProjectMissing } from "@/components/project-missing";
import { ProjectGlyph } from "@/components/project-glyph";
import { ProjectTasks, TasksHeader } from "@/components/project-tasks";
import { asksAvailable, useAsks } from "@/hooks/use-asks";
import { useDesk } from "@/hooks/use-desk";
import { coordinatorAsks } from "@/lib/asks";
import { useThreadSummaries } from "@/hooks/use-thread-summaries";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { asksPath, nodePath, panePath } from "@/lib/nav";
import { organizes, orgTree } from "@/lib/org-tree";
import { isReadOnly, type StatusFile } from "@/lib/types";
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
  return <ColumnPage data={data} title={project?.name ?? "Project"}>
    {!project ? <ProjectMissing session={data.session} />
      // Keyed by project: its folds and reads are its own.
      : <DeskProject key={project.slug} project={project} panes={data.agents} device={data.device} session={data.session} onChanged={() => void revalidator.revalidate()} />}
  </ColumnPage>;
}

// A project with only its own coordinator opens on that coordinator's conversation; the pane route
// frames it with the task list. A project that organizes coordinators is their page (ADR 0092): each
// one a row into its page (ADR 0110), the project's own first while it runs, and the threads at the
// top level apart, under what waits on you there. Without a live coordinator either way, the project is
// its organization: a way to start the coordinator, the open tree, History, and New.
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
      <ProjectTasks key={project.slug} project={project} bare status={headStatus} panes={data.agents} session={data.session} readOnly={isReadOnly(data.device)}
        organize={{ openCoordinator: (id) => navigate(nodePath(project.slug, id, data.session)) }}
        onOpenPane={(id) => navigate(panePath(id, data.session))} onOpenNode={(id) => navigate(nodePath(project.slug, id, data.session))}
        onChanged={() => revalidator.revalidate()} />
    </>}
  </ColumnPage>;
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
