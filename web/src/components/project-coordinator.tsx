import { useState, type FormEvent } from "react";
import { Play, RefreshCw } from "lucide-react";

import { FIELD, errorMessage, useStartOptions } from "@/components/node-start";
import { NodeDot, TaskRow } from "@/components/node-row";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { openOrgProject, replaceOrgCoordinator } from "@/lib/api";
import { liveState } from "@/lib/org-tree";
import { setStatus } from "@/lib/status";
import { STATUS_LABEL, type AgentView, type ProjectView } from "@/lib/types";

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
  if (!coordinator) return <CoordinatorStart project={project} session={session} readOnly={readOnly} onStarted={onChanged} />;
  const doing = panes.find((pane) => pane.paneId === coordinator.paneId)?.terminalTitle ?? STATUS_LABEL[coordinator.liveStatus];
  // Upstream herdr-projects has no `coordinator replace`.
  const replaceable = !readOnly && project.nodeActions !== false;
  return <>
    <ul className="task-list mb-2">
      <TaskRow state={liveState(coordinator.liveStatus) ?? "idle"} title="Coordinator" detail={`${coordinator.agent} · ${doing}`}
        current={current === coordinator.paneId} onOpen={() => onOpenPane(coordinator.paneId)}
        action={replaceable && <button type="button" className="task-close" aria-label="Replace coordinator" title="Replace coordinator" onClick={() => setReplacing(true)}>
          <RefreshCw aria-hidden className="size-4" />
        </button>} />
    </ul>
    {replacing && <ReplaceCoordinatorDialog project={project} agent={coordinator.agent} session={session}
      onReplaced={() => { setReplacing(false); void onChanged(); }} onCancel={() => setReplacing(false)} />}
  </>;
}

/** Organizations' `coordinator replace`: the running coordinator stops and a new one starts on the chosen profile. */
function ReplaceCoordinatorDialog({ project, agent, session, onReplaced, onCancel }: {
  project: ProjectView;
  /** The running coordinator's agent, the choice it starts on. */
  agent: string;
  session?: string;
  onReplaced: () => void;
  onCancel: () => void;
}) {
  const options = useStartOptions(project.slug, session);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const profiles = options.kind === "ready" ? options.profiles : [];
  const profile = choice || (profiles.includes(agent) ? agent : profiles[0] ?? "");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { message } = await replaceOrgCoordinator({ project: project.slug, profile }, session);
      setStatus(message || `Replacing the coordinator with ${profile}`, "success");
      onReplaced();
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={() => { if (!busy) onCancel(); }} title="Replace the coordinator?"
      description="The running coordinator stops and its conversation ends. A new one starts in the same Herdr session.">
      <form className="mt-4 space-y-3" onSubmit={(event) => void submit(event)}>
        {options.kind === "loading" && <p className="text-sm text-muted-foreground">Reading the agents this host can run…</p>}
        {options.kind === "error" && <p role="alert" className="text-sm text-destructive">The agents are unavailable: {options.message}</p>}
        {profiles.length > 0 && <label className="block text-sm font-medium">New one runs on
          <select className={FIELD} value={profile} onChange={(event) => setChoice(event.currentTarget.value)}>
            {profiles.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="lg" disabled={busy} onClick={onCancel}>Cancel</Button>
          <Button type="submit" variant="destructive" size="lg" disabled={busy || !profile}>{busy ? "Replacing…" : "Replace"}</Button>
        </div>
      </form>
    </Dialog>
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
        <NodeDot state="idle" />
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
