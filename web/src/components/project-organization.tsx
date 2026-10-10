import { useState, type ReactNode } from "react";
import { Play } from "lucide-react";

import { NewNodeActions, errorMessage } from "@/components/node-start";
import { BUCKETS, CloseThreadDialog, TaskGroup, TaskRow, TasksHeader, ThreadStateDot, threadAge, threadBucket, threadDetail, threadDot } from "@/components/project-tasks";
import { openOrgProject } from "@/lib/api";
import { isOpenThread, nestThreads, type ThreadNode } from "@/lib/projects";
import type { AgentView, ProjectThreadView, ProjectView } from "@/lib/types";

function ranked(node: ThreadNode): { node: ThreadNode; rank: number } {
  const children = node.children.map(ranked).sort((a, b) => a.rank - b.rank);
  const rank = Math.min(BUCKETS.indexOf(threadBucket(node.thread)), ...children.map((child) => child.rank));
  return { node: { ...node, children: children.map((child) => child.node) }, rank };
}

/** Siblings most urgent first, a coordinator ranked by the most urgent thread under it; ties keep Organizations' order. */
function byUrgency(nodes: readonly ThreadNode[]): ThreadNode[] {
  return nodes.map(ranked).sort((a, b) => a.rank - b.rank).map((entry) => entry.node);
}

/**
 * A project whose coordinator is not running: a way to start it, the open threads nested under the
 * coordinators that run them, the resolved ones folded away, and New thread / New coordinator.
 */
export function ProjectOrganization({ project, panes, session, readOnly, onOpenPane, onChanged, now = Date.now() }: {
  project: ProjectView;
  panes: readonly AgentView[];
  session?: string;
  readOnly: boolean;
  onOpenPane: (paneId: string) => void;
  onChanged: () => Promise<void> | void;
  now?: number;
}) {
  const [closing, setClosing] = useState<ProjectThreadView | null>(null);
  const open = project.threads.filter(isOpenThread);
  const resolved = project.threads.filter((thread) => !isOpenThread(thread));
  const row = (thread: ProjectThreadView, team?: ReactNode) => {
    const detail = threadDetail(thread, panes);
    return <TaskRow key={thread.id} dot={threadDot(thread)} title={thread.title} age={threadAge(thread, now)} current={false}
      detail={thread.role === "coordinator" ? `Coordinator · ${detail}` : detail}
      onOpen={thread.paneId ? () => onOpenPane(thread.paneId!) : undefined}
      onClose={isOpenThread(thread) && !readOnly ? () => setClosing(thread) : undefined}>{team}</TaskRow>;
  };
  const branch = (node: ThreadNode): ReactNode => row(node.thread, node.children.length > 0 &&
    <ul aria-label={`${node.thread.title} threads`} className="task-list task-branch">{node.children.map(branch)}</ul>);

  return (
    <div className="project-tasks">
      <TasksHeader title={project.name} subtitle={project.goal} paused={project.status === "paused"} />
      <CoordinatorStart project={project} session={session} readOnly={readOnly} onStarted={onChanged} />
      {open.length > 0
        ? <ul className="task-list mb-2" aria-label="Open threads">{byUrgency(nestThreads(open)).map(branch)}</ul>
        : <p className="mb-2 py-1 text-sm text-muted-foreground">No open threads.</p>}
      {resolved.length > 0 && <TaskGroup label="Resolved" count={resolved.length} open={false}>
        <ul className="task-list mt-1">{resolved.map((thread) => row(thread))}</ul>
      </TaskGroup>}
      {!readOnly && <div className="mt-3"><NewNodeActions project={project} session={session} onStarted={onChanged} /></div>}

      <CloseThreadDialog project={project} thread={closing} session={session} onCancel={() => setClosing(null)}
        onClosed={() => { setClosing(null); void onChanged(); }} />
    </div>
  );
}

/** The project coordinator, not running: Start runs Organizations' `open`, and the page becomes its chat. */
function CoordinatorStart({ project, session, readOnly, onStarted }: {
  project: ProjectView;
  session?: string;
  readOnly: boolean;
  onStarted: () => Promise<void> | void;
}) {
  const [starting, setStarting] = useState(false);
  const [outcome, setOutcome] = useState<{ error: boolean; text: string } | null>(null);

  async function start() {
    setStarting(true);
    setOutcome(null);
    try {
      const { message } = await openOrgProject({ project: project.slug }, session);
      // Shown only if this page outlives the refresh: the re-read snapshot normally carries the
      // running coordinator and the route opens its chat. If the agent waits on a dialog, the line
      // says where to answer it.
      setOutcome({ error: false, text: message });
      await onStarted();
    } catch (failure) {
      setOutcome({ error: true, text: errorMessage(failure) });
    } finally {
      setStarting(false);
    }
  }

  return (
    <section aria-label="Project coordinator" className="mb-3 rounded-xl border border-border bg-card/40 px-3.5 py-2.5">
      <div className="flex min-h-9 items-center gap-2.5">
        <ThreadStateDot state="unknown" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">Coordinator</span>
          <span className="block text-xs text-muted-foreground">Not running</span>
        </span>
        {!readOnly && (
          <button type="button" disabled={starting} onClick={() => void start()}
            className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md bg-foreground px-3 text-[13px] font-medium text-background disabled:opacity-60 lg:h-8">
            <Play aria-hidden className="size-3.5" />{starting ? "Starting…" : "Start coordinator"}
          </button>
        )}
      </div>
      {outcome?.error && <p role="alert" className="mt-2 text-sm text-destructive">{outcome.text}</p>}
      {outcome && !outcome.error && outcome.text && <p role="status" className="mt-2 text-xs text-muted-foreground">{outcome.text}</p>}
    </section>
  );
}
