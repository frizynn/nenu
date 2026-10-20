import { useEffect, useState } from "react";
import { Navigate, useRouteLoaderData } from "react-router";
import { Clock, GitPullRequest } from "@/components/ui/icon";

import { ColumnPage } from "@/components/column-page";
import { ProjectGlyph } from "@/components/project-glyph";
import { EmptyState } from "@/components/ui/empty-state";
import { useDesk } from "@/hooks/use-desk";
import { fetchOrgRoutines } from "@/lib/api";
import { timeUntilShort } from "@/lib/format";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { projectsPath } from "@/lib/nav";
import type { ProjectView, RoutineList, RoutineView } from "@/lib/types";

/**
 * Every project's routines, read once when the page opens and never polled: what each one runs on,
 * and whether it is on. Read only: a routine is changed with `herdr-organizations routine` at a
 * terminal, where approving a command is the person's own step. A desk reads them on each project's
 * Routines tab (ADR 0102), so an old link lands on Projects.
 */
export function RoutinesRoute() {
  // SAFETY: this route is a child of the root route, whose loader returns HomeData (router.tsx).
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  return useDesk() ? <Navigate replace to={projectsPath(data.session)} /> : <PhoneRoutines data={data} />;
}

function PhoneRoutines({ data }: { data: HomeData }) {
  const projects = data.projects ?? [];
  return (
    <ColumnPage data={data} title="Routines">
      <h1 className="text-title">Routines</h1>
      <p className="mt-1 text-footnote text-muted-foreground">What each project&rsquo;s coordinator does on a schedule or on its pull requests.</p>
      {projects.length === 0
        ? <EmptyState className="py-12" title="No projects yet">Routines belong to a Herdr Organizations project.</EmptyState>
        : <div className="mt-6 flex flex-col gap-6">{projects.map((project) => <ProjectRoutines key={project.slug} project={project} session={data.session} />)}</div>}
    </ColumnPage>
  );
}

function ProjectRoutines({ project, session }: { project: ProjectView; session?: string }) {
  const [read, setRead] = useState<{ list?: RoutineList; error?: string }>();
  useEffect(() => {
    let current = true;
    fetchOrgRoutines(project.slug, session).then(
      (list) => { if (current) setRead({ list }); },
      (error: unknown) => { if (current) setRead({ error: error instanceof Error ? error.message : "Could not read the routines." }); },
    );
    return () => { current = false; };
  }, [project.slug, session]);

  const line = (text: string) => <p className="px-2.5 py-1.5 text-footnote text-muted-foreground">{text}</p>;
  const list = read?.list;
  return (
    <section aria-label={project.name}>
      <h2 className="flex items-center gap-2.5 px-2.5 pb-1.5 text-footnote font-medium text-muted-foreground">
        <ProjectGlyph slug={project.slug} pick={project} size={14} />{project.name}
      </h2>
      {!read ? line("Reading…")
        : read.error ? line(read.error)
        : !list?.available ? line("This Herdr Organizations can’t list routines yet; update it to see them here.")
        : list.routines.length === 0 ? line("No routines")
        : <ul>{list.routines.map((routine) => <RoutineRow key={routine.name} routine={routine} />)}</ul>}
      {list?.broken ? line(`${list.broken} routine ${list.broken === 1 ? "file does" : "files do"} not parse.`) : null}
    </section>
  );
}

/** A routine as Cursor's Subscriptions popover draws one: its trigger's glyph, its name, when, and whether it is on. */
function RoutineRow({ routine }: { routine: RoutineView }) {
  const Icon = routine.trigger === "pr" ? GitPullRequest : Clock;
  const when = routine.trigger === "pr" ? `on ${routine.events.join(", ") || "pull requests"}` : routine.schedule;
  const next = Date.parse(routine.nextRun);
  const state = !routine.enabled ? "off" : Number.isNaN(next) ? "on" : timeUntilShort(next);
  return (
    <li className="flex min-h-9 min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-footnote">
      <Icon aria-hidden size={14} className="shrink-0 text-subtle-foreground" />
      <span className="min-w-0 truncate">{routine.name}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{when}</span>
      <span className="shrink-0 text-caption text-subtle-foreground tabular-nums">{state}</span>
    </li>
  );
}
