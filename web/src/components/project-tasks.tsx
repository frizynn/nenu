import { useState, type ReactNode } from "react";
import { Check, ChevronRight } from "lucide-react";

import { NewThreadMenu, errorMessage } from "@/components/new-thread-menu";
import { StatusDot } from "@/components/status-badge";
import { ConfirmDialog } from "@/components/ui/dialog";
import { resolveOrgNode } from "@/lib/api";
import { isOpenThread } from "@/lib/projects";
import { STATUS_LABEL, type AgentView, type ProjectThreadView, type ProjectView } from "@/lib/types";

interface ProjectTasksProps {
  project: ProjectView;
  /** Live panes, so a running thread can say what it is doing right now. */
  panes: readonly AgentView[];
  session?: string;
  currentPaneId?: string;
  readOnly: boolean;
  onOpenPane: (paneId: string) => void;
  onChanged: () => void;
  /** Extra header control, e.g. the panel's collapse button. */
  action?: ReactNode;
}

/** The project as a task list: coordinator, open threads, and resolved ones folded under History. */
export function ProjectTasks({ project, panes, session, currentPaneId, readOnly, onOpenPane, onChanged, action }: ProjectTasksProps) {
  const [closing, setClosing] = useState<ProjectThreadView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = project.threads.filter(isOpenThread);
  const resolved = project.threads.filter((thread) => !isOpenThread(thread));
  const activity = (paneId?: string) => panes.find((pane) => pane.paneId === paneId)?.terminalTitle;

  async function closeThread() {
    if (!closing) return;
    setBusy(true);
    setError(null);
    try {
      await resolveOrgNode({ project: project.slug, id: closing.id }, session);
      setClosing(null);
      onChanged();
    } catch (failure) {
      // The thread stays in the snapshot; the dialog stays open with the cause.
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  function row(thread: ProjectThreadView, closable: boolean) {
    const live = thread.paneId ? thread.liveStatus : undefined;
    const detail = [thread.agent, activity(thread.paneId) ?? (live ? STATUS_LABEL[live] : thread.status === "open" ? "not running" : thread.status)]
      .filter(Boolean).join(" · ");
    return (
      <TaskRow key={thread.id} status={live} title={thread.title} detail={detail} current={currentPaneId !== undefined && thread.paneId === currentPaneId}
        onOpen={thread.paneId ? () => onOpenPane(thread.paneId!) : undefined}
        onClose={closable && !readOnly ? () => { setError(null); setClosing(thread); } : undefined} />
    );
  }

  return (
    <div className="project-tasks">
      <header className="mb-6">
        <div className="flex items-start gap-2">
          <h2 className="min-w-0 flex-1 break-words text-lg font-semibold tracking-tight">{project.name}</h2>
          {project.status === "paused" && <span className="mt-1 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">Paused</span>}
          {action}
        </div>
        {project.goal && <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{project.goal}</p>}
      </header>

      <div className="mb-1 flex min-h-8 items-center justify-between">
        <h3 className="nav-label p-0">Tasks</h3>
        {!readOnly && <NewThreadMenu project={project} session={session} onStarted={onChanged} />}
      </div>
      <ul className="task-list">
        {project.coordinator && (
          <TaskRow status={project.coordinator.liveStatus} title="Coordinator" detail={`${project.coordinator.agent} · ${activity(project.coordinator.paneId) ?? STATUS_LABEL[project.coordinator.liveStatus]}`}
            current={currentPaneId === project.coordinator.paneId} onOpen={() => onOpenPane(project.coordinator!.paneId)} />
        )}
        {open.map((thread) => row(thread, true))}
      </ul>
      {open.length === 0 && <p className="py-3 text-sm text-muted-foreground">No open tasks.</p>}

      {resolved.length > 0 && (
        <details className="task-history mt-4">
          <summary className="nav-label px-0"><ChevronRight aria-hidden className="size-3.5" />History <span className="tabular-nums">{resolved.length}</span></summary>
          <ul className="task-list">{resolved.map((thread) => row(thread, false))}</ul>
        </details>
      )}

      <ConfirmDialog open={closing !== null} title="Close this thread?" confirmLabel="Close thread" busy={busy} error={error}
        description={<><span className="font-medium text-foreground">{closing?.title}</span> stops. Its branch, worktree and report are kept.</>}
        onConfirm={() => void closeThread()} onCancel={() => { if (!busy) setClosing(null); }} />
    </div>
  );
}

function TaskRow({ status, title, detail, current, onOpen, onClose }: {
  status?: ProjectThreadView["liveStatus"];
  title: string;
  detail: string;
  current: boolean;
  onOpen?: () => void;
  onClose?: () => void;
}) {
  const body = <>
    <StatusDot status={status ?? "unknown"} surface="bg-transparent" className="mt-1.5" />
    <span className="min-w-0 flex-1">
      <span className="block break-words text-sm font-medium">{title}</span>
      <span className="block truncate text-xs text-muted-foreground">{detail}</span>
    </span>
  </>;
  return (
    <li className="task-row" aria-current={current ? "true" : undefined}>
      {onOpen ? <button type="button" className="task-main" onClick={onOpen}>{body}</button> : <div className="task-main opacity-75">{body}</div>}
      {onClose && <button type="button" className="task-close" aria-label={`Close ${title}`} title="Close thread" onClick={onClose}><Check aria-hidden className="size-4" /></button>}
    </li>
  );
}
