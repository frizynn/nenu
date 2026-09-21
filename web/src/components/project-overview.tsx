import { ArrowRight, FolderKanban } from "lucide-react";

import type { ProjectView } from "@/lib/types";

export function ProjectOverview({ projects, onOpen }: { projects: ProjectView[]; onOpen: (slug: string) => void }) {
  if (projects.length === 0) return null;
  return (
    <section aria-labelledby="registered-projects" className="mb-12">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 id="registered-projects" className="text-sm font-semibold">Herdr Projects</h2>
        <span className="text-xs tabular-nums text-muted-foreground">{projects.length} registered</span>
      </div>
      <div className="divide-y rounded-xl border bg-card">
        {projects.map((project) => {
          const open = project.threads.filter((thread) => thread.status !== "resolved");
          const live = open.filter((thread) => thread.paneId).length + (project.coordinator ? 1 : 0);
          return (
            <button key={project.slug} type="button" onClick={() => onOpen(project.slug)}
              className="group flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left first:rounded-t-xl last:rounded-b-xl hover:bg-muted/50 active:bg-muted">
              <FolderKanban className="size-5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate font-medium">{project.name}</span>
                  {project.status === "paused" && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Paused</span>}
                </span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {live ? `${live} live · ` : ""}{open.length} open {open.length === 1 ? "thread" : "threads"}
                </span>
              </span>
              <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
            </button>
          );
        })}
      </div>
    </section>
  );
}
