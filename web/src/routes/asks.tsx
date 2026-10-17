import { useSearchParams, useRouteLoaderData } from "react-router";
import { ListChecks } from "@/components/ui/icon";

import { AskSections } from "@/components/ask-list";
import { ColumnPage } from "@/components/column-page";
import { selectField } from "@/components/new-agent-sheet";
import { EmptyState } from "@/components/ui/empty-state";
import { asksAvailable, useAsks } from "@/hooks/use-asks";
import { askSections, asksHeadline, coordinatorName, type AskFilter } from "@/lib/asks";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { AskCoordinator, AsksList, ProjectView } from "@/lib/types";

/**
 * Your asks (ADR 0091): everything you asked any coordinator, in one list grouped the way Herdr
 * Organizations' popup groups it, each row saying whose it is and where it stands, its links as chips,
 * and Answer where one waits on you (ADR 0093). A project and a coordinator narrow it, kept in the
 * address so a link can open it narrowed. Read when the page opens and again when the organization
 * moves; never polled.
 */
export function AsksRoute() {
  // SAFETY: this route is a child of the root route, whose loader returns HomeData (router.tsx).
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  const projects = data.projects ?? [];
  const { list, loaded, failed } = useAsks(projects);
  const [params, setParams] = useSearchParams();
  const filter: AskFilter = { project: params.get("project") || undefined, coordinator: (params.get("project") && params.get("coordinator")) || undefined };
  const sections = list ? askSections(list, projects, filter) : [];
  const everything = list ? askSections(list, projects) : [];
  const line = (text: string) => <p className="mt-6 px-2.5 text-footnote text-muted-foreground">{text}</p>;
  const narrow = (next: AskFilter) => setParams(Object.fromEntries(Object.entries(next).filter(([, value]) => value)), { replace: true });

  return (
    <ColumnPage data={data} title="Your asks">
      <h1 className="text-title">Your asks</h1>
      <p className="mt-1 text-footnote text-muted-foreground">
        {everything.length ? asksHeadline(sections, scopeName(filter, projects, list)) : "What you asked every coordinator, and where each one stands."}
      </p>
      {list && everything.length > 0 && <AskFilters list={list} projects={projects} filter={filter} onChange={narrow} />}
      {!asksAvailable(projects) ? <EmptyState className="py-12" icon={ListChecks} title="No asks to show">
          This Herdr Organizations can’t list asks yet; update it to see them here.</EmptyState>
        : !loaded ? line("Reading…")
        : !list ? line(failed ?? "Could not read the asks.")
        : everything.length === 0 ? <EmptyState className="py-12" icon={ListChecks} title="Nothing asked yet">
          A coordinator lists what you ask it under “## Asked” in its STATUS.md.</EmptyState>
        : <div className="mt-6 flex flex-col gap-6">
          {failed && line(failed)}
          {sections.length === 0 ? line("Nothing asked here.")
            : <AskSections sections={sections} session={data.session} whose answers={list.answers === true} />}
        </div>}
    </ColumnPage>
  );
}

/** The coordinators that hold an ask or a decision, by project, in the order the list names them. */
function coordinatorsOf(list: AsksList, project: string): AskCoordinator[] {
  const seen = new Map<string, AskCoordinator>();
  for (const item of [...(list.asks ?? []), ...list.decisions]) if (item.project === project && !seen.has(item.coordinator.id)) seen.set(item.coordinator.id, item.coordinator);
  return [...seen.values()];
}

function scopeName(filter: AskFilter, projects: readonly ProjectView[], list: AsksList | null): string {
  const project = projects.find((candidate) => candidate.slug === filter.project);
  if (!project) return "all coordinators";
  const coordinator = list && filter.coordinator ? coordinatorsOf(list, project.slug).find((candidate) => candidate.id === filter.coordinator) : undefined;
  return coordinator ? `${project.name} · ${coordinatorName(coordinator)}` : project.name;
}

/** A project, then one of its coordinators: only those that hold something to list. */
function AskFilters({ list, projects, filter, onChange }: {
  list: AsksList;
  projects: readonly ProjectView[];
  filter: AskFilter;
  onChange: (filter: AskFilter) => void;
}) {
  const asked = projects.filter((project) => coordinatorsOf(list, project.slug).length > 0);
  const coordinators = filter.project ? coordinatorsOf(list, filter.project) : [];
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      <label className="flex min-w-0 flex-1 flex-col gap-1 sm:max-w-60">
        <span className="text-footnote font-medium text-muted-foreground">Project</span>
        <select className={selectField} value={filter.project ?? ""} onChange={(event) => onChange({ project: event.currentTarget.value || undefined })}>
          <option value="">All projects</option>
          {asked.map((project) => <option key={project.slug} value={project.slug}>{project.name}</option>)}
        </select>
      </label>
      <label className="flex min-w-0 flex-1 flex-col gap-1 sm:max-w-60">
        <span className="text-footnote font-medium text-muted-foreground">Coordinator</span>
        <select className={selectField} value={filter.coordinator ?? ""} disabled={!filter.project}
          onChange={(event) => onChange({ project: filter.project, coordinator: event.currentTarget.value || undefined })}>
          <option value="">All coordinators</option>
          {coordinators.map((coordinator) => <option key={coordinator.id} value={coordinator.id}>{coordinatorName(coordinator)}</option>)}
        </select>
      </label>
    </div>
  );
}
