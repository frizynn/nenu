import { ArrowLeft, GitBranch } from "lucide-react";
import { useNavigate, useParams, useRouteLoaderData } from "react-router";

import { AppHeader, SettingsGear } from "@/components/app-header";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { AgentIcon } from "@/components/agent-icon";
import { StatusDot } from "@/components/status-badge";
import { useLoadingStalled } from "@/hooks/use-loading-stalled";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { homePath, panePath } from "@/lib/nav";
import type { ProjectThreadView } from "@/lib/types";

export function ProjectRoute() {
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  const { projectSlug = "" } = useParams();
  const navigate = useNavigate();
  const stalled = useLoadingStalled();
  const project = data.projects?.find((candidate) => candidate.slug === projectSlug);
  const back = () => navigate(homePath(data.session));

  return <div className="workbench-home flex min-h-0 min-w-0 flex-1 flex-col">
    <AppHeader bridge={data.bridge} error={data.error} stalled={stalled} onHome={back}
      rightTrail={<SettingsGear session={data.session} />}>
      <span className="truncate text-sm font-medium">{project?.name ?? "Project"}</span>
    </AppHeader>
    <ReadOnlyBanner device={data.device} />
    <main className="min-h-0 flex-1 overflow-y-auto px-5 py-8 sm:px-8 sm:py-12">
      <div className="mx-auto w-full max-w-2xl">
        <button type="button" onClick={back} className="mb-7 inline-flex min-h-11 items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden />Projects
        </button>
        {!project ? <p className="py-16 text-center text-sm text-muted-foreground">Project not found in this Herdr session.</p> : <>
          <header className="mb-9">
            <div className="flex items-center gap-3">
              <h1 className="min-w-0 break-words text-2xl font-semibold tracking-tight sm:text-3xl">{project.name}</h1>
              {project.status === "paused" && <span className="rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">Paused</span>}
            </div>
            {project.goal && <p className="mt-3 max-w-[70ch] text-sm leading-relaxed text-muted-foreground">{project.goal}</p>}
          </header>

          <section className="mb-10" aria-labelledby="coordinator-heading">
            <h2 id="coordinator-heading" className="mb-3 text-sm font-semibold">Coordinator</h2>
            {project.coordinator ? <button type="button" onClick={() => navigate(panePath(project.coordinator!.paneId, data.session))}
              className="flex min-h-14 w-full items-center gap-3 rounded-xl border bg-card px-4 text-left hover:bg-muted/50">
              <AgentIcon agent={project.coordinator.agent} className="size-6" />
              <span className="min-w-0 flex-1"><span className="block font-medium">Project coordinator</span><span className="block text-xs text-muted-foreground">{project.coordinator.agent} · {project.coordinator.liveStatus}</span></span>
              <StatusDot status={project.coordinator.liveStatus} surface="bg-card" />
            </button> : <div className="rounded-xl border border-dashed px-4 py-4 text-sm text-muted-foreground">Coordinator is not active in this session.</div>}
          </section>

          <ThreadSection title="Active threads" threads={project.threads.filter((thread) => thread.status !== "resolved")} onOpen={(id) => navigate(panePath(id, data.session))} />
          <ThreadSection title="Thread history" threads={project.threads.filter((thread) => thread.status === "resolved")} onOpen={(id) => navigate(panePath(id, data.session))} quiet />
        </>}
      </div>
    </main>
  </div>;
}

function ThreadSection({ title, threads, onOpen, quiet = false }: { title: string; threads: ProjectThreadView[]; onOpen: (paneId: string) => void; quiet?: boolean }) {
  if (threads.length === 0 && quiet) return null;
  return <section className="mb-10" aria-labelledby={`threads-${quiet ? "history" : "active"}`}>
    <div className="mb-3 flex items-baseline justify-between"><h2 id={`threads-${quiet ? "history" : "active"}`} className="text-sm font-semibold">{title}</h2><span className="text-xs tabular-nums text-muted-foreground">{threads.length}</span></div>
    {threads.length === 0 ? <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">No active threads.</p> : <div className="divide-y rounded-xl border bg-card">
      {threads.map((thread) => {
        const content = <><span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted"><GitBranch className="size-4 text-muted-foreground" aria-hidden /></span><span className="min-w-0 flex-1"><span className="block break-words font-medium">{thread.title}</span><span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground"><span className="font-mono">{thread.id}</span><span aria-hidden>·</span><span>{thread.role}</span>{thread.parentId !== "root" && <><span aria-hidden>·</span><span>under {thread.parentId}</span></>}<span aria-hidden>·</span><span>{thread.status}</span>{thread.paneId && <><span aria-hidden>·</span><span>{thread.liveStatus}</span></>}</span></span>{thread.liveStatus ? <StatusDot status={thread.liveStatus} surface="bg-card" /> : <span className="size-2.5 shrink-0 rounded-full border border-muted-foreground/40" aria-hidden />}</>;
        return thread.paneId ? <button key={thread.id} type="button" onClick={() => onOpen(thread.paneId!)} className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left first:rounded-t-xl last:rounded-b-xl hover:bg-muted/50">{content}</button> : <div key={thread.id} className="flex min-h-16 items-center gap-3 px-4 py-3 text-left opacity-75">{content}</div>;
      })}
    </div>}
  </section>;
}
