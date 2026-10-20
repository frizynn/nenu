import { useState } from "react";
import { Link, useRouteLoaderData } from "react-router";
import { LayoutGrid, Plus, Search } from "@/components/ui/icon";

import { ColumnPage } from "@/components/column-page";
import { openNewDialog } from "@/components/new-agent-sheet";
import { NodeDot } from "@/components/node-row";
import { ProjectGlyph } from "@/components/project-glyph";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { projectActivity } from "@/lib/desk-nav";
import { timeAgoShort } from "@/lib/format";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { projectPath } from "@/lib/nav";
import { flatten, openCoordinators, orgTree } from "@/lib/org-tree";
import { canCreate, type ProjectView } from "@/lib/types";

/**
 * Every project as a card (ADR 0102), the desk's way into them from the bar: its goal, what waits on
 * you there, what is working, and how many coordinators and threads it holds open.
 */
export function ProjectsRoute() {
  // SAFETY: this route is a child of the root route, whose loader returns HomeData (router.tsx).
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  const [query, setQuery] = useState("");
  const projects = data.projects ?? [];
  const needle = query.trim().toLowerCase();
  const shown = needle ? projects.filter((project) => `${project.name} ${project.goal}`.toLowerCase().includes(needle)) : projects;
  const now = Date.now();
  return (
    <ColumnPage data={data} title="Projects">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="flex-1 text-title">Projects</h1>
        {canCreate(data) && <Button type="button" variant="outline" onClick={() => openNewDialog({ kind: "project" })}><Plus aria-hidden className="size-4" />New project</Button>}
      </div>
      {projects.length === 0
        ? <EmptyState className="py-12" icon={LayoutGrid} title="No projects yet">A project is a Herdr Organizations project: a goal, its coordinators and their threads.</EmptyState>
        : <>
          <label className="mb-4 flex h-10 items-center gap-2.5 rounded-lg border border-border bg-card px-3 text-subhead">
            <Search aria-hidden size={15} className="text-muted-foreground" />
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search projects" aria-label="Search projects"
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-subtle-foreground" />
          </label>
          {shown.length === 0
            ? <p className="px-1 text-subhead text-muted-foreground">No project matches “{query.trim()}”.</p>
            : <ul className="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-3">
              {shown.map((project) => <li key={project.slug}><ProjectCard project={project} at={projectActivity(project, data.agents)} now={now} session={data.session} /></li>)}
            </ul>}
        </>}
    </ColumnPage>
  );
}

function ProjectCard({ project, at, now, session }: { project: ProjectView; at: number; now: number; session?: string }) {
  const tree = orgTree(project.threads);
  const open = flatten(tree.open);
  const coordinators = openCoordinators(tree).length;
  const working = open.filter((node) => node.state === "working").length;
  const waiting = project.waitingAsks ?? open.filter((node) => node.state === "needs").length;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return (
    <Link to={projectPath(project.slug, session)} className="desk-card flex h-full flex-col p-4 hover:bg-accent/40">
      <span className="desk-card-mark mb-3 size-9"><ProjectGlyph slug={project.slug} pick={project} size={18} /></span>
      <span className="text-headline">{project.name}</span>
      {project.goal && <span className="mt-1 line-clamp-2 text-footnote text-muted-foreground">{project.goal}</span>}
      <span className="mt-3 flex flex-wrap gap-x-3 text-footnote text-muted-foreground">
        {waiting > 0 && <span className="inline-flex items-center gap-1.5"><NodeDot state="needs" className="size-1.5" />{waiting} waiting on you</span>}
        {working > 0 && <span className="inline-flex items-center gap-1.5"><NodeDot state="working" className="size-1.5" />{working} working</span>}
        {project.status === "paused" && <span>Paused</span>}
      </span>
      <span aria-hidden className="flex-1" />
      <span className="mt-3 flex items-center gap-2 border-t border-border pt-3 text-caption text-muted-foreground">
        <span className="flex-1">{plural(coordinators, "coordinator")} · {plural(open.length - coordinators, "thread")}</span>
        {at > 0 && <span className="tabular-nums">{timeAgoShort(at, now)}</span>}
      </span>
    </Link>
  );
}
