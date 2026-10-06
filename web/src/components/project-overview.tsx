import { ChevronRight, FolderKanban } from "lucide-react";

import { StatusDot } from "@/components/status-badge";
import { projectProgress } from "@/lib/home-stats";
import { projectSummary } from "@/lib/projects";
import { STATUS_LABEL, type ProjectView } from "@/lib/types";

/** Home's project list: coordinator status, a one-line activity summary and how many tasks are done. */
export function ProjectOverview({ projects, onOpen }: { projects: ProjectView[]; onOpen: (slug: string) => void }) {
  if (projects.length === 0) return null;
  return (
    <section aria-labelledby="registered-projects" className="home-card">
      <div className="home-card-head"><h2 id="registered-projects">Projects</h2></div>
      <ul className="mt-2">
        {projects.map((project) => {
          const status = project.coordinator?.liveStatus;
          const progress = projectProgress(project);
          return (
            <li key={project.slug}>
              <button type="button" onClick={() => onOpen(project.slug)} className="home-row group items-start py-2.5 text-left">
                <FolderKanban className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-medium">{project.name}</span>
                    {status && <StatusDot status={status} surface="bg-card" className="size-2" />}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">{projectSummary(project)}</span>
                  {progress.total > 0 && (
                    <span className="mt-2 flex items-center gap-3">
                      <span role="meter" aria-label="Tasks done" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.resolved}
                        className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                        <span className="block h-full rounded-full bg-foreground/70" style={{ width: `${progress.ratio * 100}%` }} />
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{progress.resolved}/{progress.total} done</span>
                    </span>
                  )}
                  {status && <span className="sr-only">, coordinator {STATUS_LABEL[status]}</span>}
                </span>
                <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground/70 transition-transform group-hover:translate-x-0.5" aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
