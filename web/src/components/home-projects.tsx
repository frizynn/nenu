import { Link } from "react-router";

import { FoldedList, HomeHeading } from "@/components/home-panels";
import { NodeDot } from "@/components/node-row";
import { ProjectGlyph } from "@/components/project-glyph";
import { useHeldTime } from "@/hooks/use-held-time";
import { projectPulse, type ProjectPulse } from "@/lib/desk-nav";
import { timeAgo, timeAgoShort } from "@/lib/format";
import { projectPath, projectsPath } from "@/lib/nav";
import type { NodeState } from "@/lib/org-tree";
import type { AgentView, ProjectView } from "@/lib/types";
import { cn } from "@/lib/utils";

/** How many projects Home lists before "Show all". */
export const PROJECT_ROWS = 5;

/** What a project's state reads as, most pressing first: each count with the dot the organization tree draws for it. */
function pulseParts(pulse: ProjectPulse): Array<{ state: NodeState; text: string }> {
  return [
    pulse.waiting > 0 && { state: "needs" as const, text: `${pulse.waiting} ${pulse.waiting === 1 ? "needs" : "need"} you` },
    pulse.working > 0 && { state: "working" as const, text: `${pulse.working} working` },
    pulse.review > 0 && { state: "review" as const, text: `${pulse.review} to review` },
  ].filter((part) => part !== false);
}

/** The line under a project's name: its counts, or what it is when nothing runs there. */
function PulseLine({ project, pulse, className }: { project: ProjectView; pulse: ProjectPulse; className?: string }) {
  const parts = pulseParts(pulse);
  const open = pulse.threads + pulse.coordinators;
  const quiet = [project.status === "paused" ? "Paused" : open > 0 && "Nothing running", open > 0 ? `${open} open ${open === 1 ? "thread" : "threads"}` : "No open threads"]
    .filter(Boolean).join(" · ");
  return (
    <span className={cn("flex min-w-0 items-center gap-x-2.5 overflow-hidden text-footnote sm:gap-x-3 text-muted-foreground", className)}>
      {parts.length === 0
        ? <span className="truncate">{quiet}</span>
        : <>
          {project.status === "paused" && <span className="shrink-0">Paused</span>}
          {parts.map((part) => (
            <span key={part.state} className="inline-flex min-w-0 items-center gap-1.5 tabular-nums">
              <NodeDot state={part.state} className="size-1.5" /><span className="truncate">{part.text}</span>
            </span>
          ))}
        </>}
    </span>
  );
}

interface Entry { project: ProjectView; pulse: ProjectPulse }

/**
 * Home's projects, each with what waits on you there, what is working, what is ready to review and
 * when it last moved; a tap opens the project. Ordered by last activity, paused ones last, held in
 * place while on screen like Recents (ADR 0094).
 */
export function HomeProjects({ projects, agents, session, now }: {
  projects: readonly ProjectView[];
  agents: readonly AgentView[];
  session?: string;
  now: number;
}) {
  const held = useHeldTime((entry: Entry) => entry.project.slug, (entry) => entry.pulse.at);
  if (!projects.length) return null;
  const entries = held.order(projects.map((project) => ({ project, pulse: projectPulse(project, agents) })));
  const ordered = [...entries.filter((entry) => entry.project.status !== "paused"), ...entries.filter((entry) => entry.project.status === "paused")];
  const all = <Link to={projectsPath(session)} className="text-muted-foreground hover:text-foreground">See all</Link>;
  return (
    <section aria-labelledby="home-projects" className="flex flex-col gap-2">
      <HomeHeading id="home-projects" label="Projects" count={projects.length} note={all} />
      <div className="sm:-mx-2.5">
        <FoldedList items={ordered} rows={PROJECT_ROWS}>{(entry) => <ProjectRow key={entry.project.slug} {...entry} session={session} now={now} />}</FoldedList>
      </div>
    </section>
  );
}

/** A project as a row of Home's lists: its mark, its name, its state and when it last moved. */
function ProjectRow({ project, pulse, session, now }: Entry & { session?: string; now: number }) {
  return (
    <li>
      <Link to={projectPath(project.slug, session)}
        className={cn("grid min-h-14 min-w-0 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-3 px-1 py-2 hover:bg-[var(--workbench-row-hover)] sm:min-h-12 sm:rounded-lg sm:px-2.5",
          project.status === "paused" && "text-muted-foreground")}>
        <span className="row-span-2 flex justify-center"><ProjectGlyph slug={project.slug} pick={project} size={16} /></span>
        <span className="col-start-2 truncate text-body sm:text-subhead">{project.name}</span>
        <PulseLine project={project} pulse={pulse} className="col-start-2 row-start-2" />
        <span className="col-start-3 row-span-2 row-start-1 min-w-8 text-right text-footnote tabular-nums text-muted-foreground" title={pulse.at > 0 ? `Last activity ${timeAgo(pulse.at, now)}` : undefined}>
          {pulse.at > 0 && <><span aria-hidden>{timeAgoShort(pulse.at, now)}</span><span className="sr-only">, last activity {timeAgo(pulse.at, now)}</span></>}
        </span>
      </Link>
    </li>
  );
}
