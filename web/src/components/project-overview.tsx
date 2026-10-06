import { ChevronRight, FolderKanban } from "lucide-react";

import { StatusDot } from "@/components/status-badge";
import { projectSummary } from "@/lib/projects";
import { STATUS_LABEL, type ProjectView } from "@/lib/types";

/** Home's project list: coordinator status, name and a one-line activity summary per project. */
export function ProjectOverview({ projects, onOpen }: { projects: ProjectView[]; onOpen: (slug: string) => void }) {
  if (projects.length === 0) return null;
  return (
    <section aria-labelledby="registered-projects" className="mb-10">
      <h2 id="registered-projects" className="nav-label px-0">Projects</h2>
      <ul className="divide-y divide-border/70 border-y border-border/70">
        {projects.map((project) => {
          const status = project.coordinator?.liveStatus;
          return (
            <li key={project.slug}>
              <button type="button" onClick={() => onOpen(project.slug)}
                className="group flex min-h-14 w-full items-center gap-3 py-2.5 text-left">
                <FolderKanban className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{project.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{projectSummary(project)}</span>
                </span>
                {status && <StatusDot status={status} surface="bg-transparent" className="size-2" />}
                {status && <span className="sr-only">, coordinator {STATUS_LABEL[status]}</span>}
                <ChevronRight className="size-4 shrink-0 text-muted-foreground/70 transition-transform group-hover:translate-x-0.5" aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
