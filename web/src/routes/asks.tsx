import { Link, useRouteLoaderData } from "react-router";
import { ListChecks } from "@/components/ui/icon";

import { ColumnPage } from "@/components/column-page";
import { AskMark } from "@/components/coordinator-card";
import { EmptyState } from "@/components/ui/empty-state";
import { asksAvailable, useAsks } from "@/hooks/use-asks";
import { askSections, asksHeadline, coordinatorName, type AskEntry } from "@/lib/asks";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { nodePath } from "@/lib/nav";

/**
 * Your asks (ADR 0091): everything you asked any coordinator, in one list grouped the way Herdr
 * Organizations' popup groups it, each row saying whose it is and where it stands, and opening that
 * coordinator's card. Read when the page opens and again when the organization moves; never polled.
 */
export function AsksRoute() {
  // SAFETY: this route is a child of the root route, whose loader returns HomeData (router.tsx).
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  const projects = data.projects ?? [];
  const { list, loaded, failed } = useAsks(projects);
  const sections = list ? askSections(list, projects) : [];
  const line = (text: string) => <p className="mt-6 px-2.5 text-footnote text-muted-foreground">{text}</p>;

  return (
    <ColumnPage data={data} title="Your asks">
      <h1 className="text-title">Your asks</h1>
      <p className="mt-1 text-footnote text-muted-foreground">
        {sections.length ? asksHeadline(sections) : "What you asked every coordinator, and where each one stands."}
      </p>
      {!asksAvailable(projects) ? <EmptyState className="py-12" icon={ListChecks} title="No asks to show">
          This Herdr Organizations can’t list asks yet; update it to see them here.</EmptyState>
        : !loaded ? line("Reading…")
        : !list ? line(failed ?? "Could not read the asks.")
        : sections.length === 0 ? <EmptyState className="py-12" icon={ListChecks} title="Nothing asked yet">
          A coordinator lists what you ask it under “## Asked” in its STATUS.md.</EmptyState>
        : <div className="mt-6 flex flex-col gap-6">
          {failed && line(failed)}
          {sections.map((section) => (
            <section key={section.group} aria-label={section.label}>
              <h2 className="flex items-center gap-2 px-2.5 pb-1 text-footnote font-medium text-muted-foreground">
                <span className="text-foreground">{section.label}</span><span className="tabular-nums">{section.entries.length}</span>
              </h2>
              <ul>{section.entries.map((entry) => <AskRowLink key={entry.key} entry={entry} session={data.session} />)}</ul>
            </section>
          ))}
        </div>}
    </ColumnPage>
  );
}

/** An ask, then whose it is and where it stands; a tap opens that coordinator's card. */
function AskRowLink({ entry, session }: { entry: AskEntry; session?: string }) {
  const whose = [entry.project.name, coordinatorName(entry.coordinator), entry.detail].filter(Boolean).join(" · ");
  return (
    <li>
      <Link to={nodePath(entry.project.slug, entry.coordinator.id, session)}
        className="flex min-w-0 items-start gap-2.5 rounded-lg px-2.5 py-2 hover:bg-muted/50 active:bg-muted">
        <span className="pt-0.5"><AskMark group={entry.group} /></span>
        <span className="min-w-0 flex-1">
          <span className="block break-words text-subhead">{entry.text}</span>
          <span className="block break-words text-footnote text-muted-foreground">{whose}</span>
        </span>
      </Link>
    </li>
  );
}
