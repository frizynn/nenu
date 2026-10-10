import { Link } from "react-router";
import { ChevronRight } from "lucide-react";

import { StatusDot } from "@/components/status-badge";
import { projectStateCounts, type ProjectStateCounts } from "@/lib/home-stats";
import { projectPath } from "@/lib/nav";
import { isOpenThread } from "@/lib/projects";
import type { ProjectView } from "@/lib/types";
import { cn } from "@/lib/utils";

const SEGMENTS: ReadonlyArray<{ key: keyof ProjectStateCounts; label: string; fill: string }> = [
  { key: "blocked", label: "need you", fill: "bg-status-blocked" },
  { key: "working", label: "working", fill: "bg-status-working" },
  { key: "review", label: "to review", fill: "bg-primary" },
  // Resting threads stay quiet as a fill, the way StatusDot draws them hollow.
  { key: "idle", label: "idle", fill: "bg-muted-foreground/30" },
];

function LegendDot({ state }: { state: keyof ProjectStateCounts }) {
  if (state === "review") return <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />;
  return <StatusDot status={state} surface="bg-card" className="size-1.5" />;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** One line under the name: how many coordinators lead how many open threads. */
function projectLine(project: ProjectView, counts: ProjectStateCounts): string {
  const open = project.threads.filter(isOpenThread);
  const coordinators = open.filter((thread) => thread.role === "coordinator").length || (project.coordinator ? 1 : 0);
  const parts = [coordinators ? plural(coordinators, "coordinator") : "", plural(open.length, "thread")];
  if (counts.review) parts.push(`${counts.review} to review`);
  return project.status === "paused" ? `Paused · ${parts.join(" · ")}` : parts.join(" · ");
}

/** A project on Home: its initial, what it holds, and one bar of what its threads are doing. */
export function ProjectSummaryCard({ project, session }: { project: ProjectView; session?: string }) {
  const counts = projectStateCounts(project);
  const total = SEGMENTS.reduce((sum, part) => sum + counts[part.key], 0);
  const shown = SEGMENTS.filter((part) => counts[part.key] > 0);
  const described = shown.map((part) => `${counts[part.key]} ${part.label}`).join(", ");
  return (
    <Link to={projectPath(project.slug, session)}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-3.5 hover:bg-card/80 max-sm:rounded-2xl">
      <span className="flex min-w-0 items-center gap-2.5">
        <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-violet-500 text-[13px] font-bold text-white">
          {project.name.trim().charAt(0).toUpperCase() || "P"}
        </span>
        <span className="flex min-w-0 flex-1 flex-col leading-snug">
          <span className="truncate text-[13.5px] font-semibold">{project.name}</span>
          <span className="truncate text-[11.5px] text-muted-foreground">{projectLine(project, counts)}</span>
        </span>
        <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </span>
      {total > 0 && <>
        <span role="img" aria-label={described} className="flex h-1.5 gap-0.5 overflow-hidden rounded-full">
          {shown.map((part) => <span key={part.key} className={cn("h-full", part.fill)} style={{ flexGrow: counts[part.key] }} />)}
        </span>
        <span aria-hidden className="flex flex-wrap gap-3 text-[11.5px] text-muted-foreground tabular-nums">
          {shown.map((part) => <span key={part.key} className="flex items-center gap-1.5"><LegendDot state={part.key} />{counts[part.key]}</span>)}
        </span>
      </>}
    </Link>
  );
}
