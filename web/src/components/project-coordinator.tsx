import { lazy, Suspense, useState } from "react";
import { Play, RefreshCw } from "@/components/ui/icon";

import { errorMessage } from "@/components/node-start";
import { NodeDot, TaskRow } from "@/components/node-row";
import { openOrgProject, replaceOrgCoordinator, type CoordinatorChoice } from "@/lib/api";
import { liveState } from "@/lib/org-tree";
import { setStatus } from "@/lib/status";
import { STATUS_LABEL, type AgentView, type ProjectView } from "@/lib/types";

// Drawn only when Start or Replace is tapped, so it stays out of the first load.
const CoordinatorWindow = lazy(() => import("@/components/coordinator-window").then((module) => ({ default: module.CoordinatorWindow })));

/** The project's own coordinator: its row, which can replace it with another agent, or a way to start it. */
export function ProjectCoordinator({ project, panes, session, current, readOnly, onOpenPane, onChanged }: {
  project: ProjectView;
  panes: readonly AgentView[];
  session?: string;
  current?: string;
  readOnly: boolean;
  onOpenPane: (paneId: string) => void;
  onChanged: () => Promise<void> | void;
}) {
  const [replacing, setReplacing] = useState(false);
  const coordinator = project.coordinator;
  // Organizations records the coordinator's pane before its agent runs, and keeps it once the agent
  // quits back to the shell: a pane with no agent in it is no running coordinator.
  if (!coordinator || coordinator.agent === "shell") return <CoordinatorStart project={project} session={session} readOnly={readOnly} onStarted={onChanged} />;
  const doing = panes.find((pane) => pane.paneId === coordinator.paneId)?.terminalTitle ?? STATUS_LABEL[coordinator.liveStatus];
  const here = current === coordinator.paneId;
  // Upstream herdr-projects has no `coordinator replace`.
  const replaceable = !readOnly && project.nodeActions !== false;
  return <>
    <ul className="task-list mb-2">
      <TaskRow state={liveState(coordinator.liveStatus) ?? "idle"} title="Coordinator" detail={[here && "You're here", coordinator.agent, doing].filter(Boolean).join(" · ")}
        current={here} onOpen={() => onOpenPane(coordinator.paneId)} opens="chat"
        actions={replaceable ? [{ label: "Replace", name: "Replace coordinator", menuLabel: "Replace coordinator…", icon: RefreshCw, run: () => setReplacing(true) }] : undefined} />
    </ul>
    {replacing && <ReplaceCoordinator project={project} agent={coordinator.agent} session={session}
      onReplaced={() => { setReplacing(false); void onChanged(); }} onCancel={() => setReplacing(false)} />}
  </>;
}

/** Organizations' `coordinator replace`: the running coordinator stops and a new one starts on what the window chose. */
function ReplaceCoordinator({ project, agent, session, onReplaced, onCancel }: {
  project: ProjectView;
  /** The running coordinator's harness, chosen first when Organizations knows no last launch. */
  agent: string;
  session?: string;
  onReplaced: () => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function replace(choice: CoordinatorChoice) {
    setBusy(true);
    setError(null);
    try {
      const { message } = await replaceOrgCoordinator({ project: project.slug, ...choice }, session);
      setStatus(message || "Replacing the coordinator", "success");
      onReplaced();
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  }

  return <Suspense fallback={null}>
    <CoordinatorWindow project={project.slug} session={session} mode="replace" running={agent} busy={busy} error={error}
      onSubmit={(choice) => void replace(choice)} onClose={onCancel} />
  </Suspense>;
}

/**
 * The project coordinator, not running: Start asks what it runs on, then runs Organizations' `open`,
 * and the button says it is starting until the page becomes its chat. That holds while Organizations
 * has recorded the pane but no agent runs in it yet; it ends with the chat, an error, or a line from
 * Organizations (an agent waiting on a dialog).
 */
function CoordinatorStart({ project, session, readOnly, onStarted }: {
  project: ProjectView;
  session?: string;
  readOnly: boolean;
  onStarted: () => Promise<void> | void;
}) {
  const [choosing, setChoosing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [outcome, setOutcome] = useState<{ error: boolean; text: string } | null>(null);

  async function start(choice: CoordinatorChoice) {
    setChoosing(false);
    setStarting(true);
    setOutcome(null);
    try {
      const { message } = await openOrgProject({ project: project.slug, ...choice }, session);
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
        <NodeDot state="idle" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">Coordinator</span>
          <span className="block text-xs text-muted-foreground">Not running</span>
        </span>
        {!readOnly && (
          <button type="button" disabled={starting} onClick={() => setChoosing(true)}
            className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md bg-foreground px-3 text-[13px] font-medium text-background disabled:opacity-60 lg:h-8">
            {!starting && <Play aria-hidden className="size-3.5" />}{starting ? "Starting coordinator…" : "Start coordinator"}
          </button>
        )}
      </div>
      {outcome?.error && <p role="alert" className="mt-2 text-sm text-destructive">{outcome.text}</p>}
      {outcome && !outcome.error && outcome.text && <p role="status" className="mt-2 text-xs text-muted-foreground">{outcome.text}</p>}
      {choosing && <Suspense fallback={null}>
        <CoordinatorWindow project={project.slug} session={session} mode="start" onSubmit={(choice) => void start(choice)} onClose={() => setChoosing(false)} />
      </Suspense>}
    </section>
  );
}
