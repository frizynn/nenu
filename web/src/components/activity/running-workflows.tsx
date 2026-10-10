import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";

import { useActivity, useWorkflowDetail, type ActivityState } from "@/hooks/use-activity";
import { runningCount } from "@/lib/activity";
import { WorkflowCard } from "./workflow-card";
import { WorkflowDetail } from "./workflow-detail";

export type OpenWorkflow = { runId: string; agentId: string | null };

/** The clock running work is measured against, ticking each second only while something runs. */
export function useActivityClock(data: ActivityState["data"]): number {
  const [now, setNow] = useState(() => Date.now());
  const running = runningCount(data) > 0;
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [running]);
  return now;
}

/** A workflow opened full screen: its timeline and the selected agent's result. */
export function WorkflowScreen({ paneId, session, activity, open, now, onChange }: {
  paneId: string;
  session?: string;
  activity: ActivityState;
  open: OpenWorkflow;
  now: number;
  onChange: (open: OpenWorkflow | null) => void;
}) {
  const detail = useWorkflowDetail(paneId, open.runId, session, activity.data);
  const listed = activity.data?.available ? activity.data.workflows.find((w) => w.runId === open.runId) : undefined;
  const shown = detail.detail?.workflow ?? listed;
  return (
    <div role="dialog" aria-label={shown?.name ?? "Workflow"} className="fixed inset-0 z-40 flex flex-col bg-background pt-[env(safe-area-inset-top)]">
      <div className="flex min-h-12 items-center gap-2 border-b border-border px-2">
        <button type="button" aria-label="Back" onClick={() => onChange(null)} className="flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent">
          <ArrowLeft aria-hidden className="size-4" />
        </button>
        <span className="truncate text-sm font-medium">{shown?.name ?? "Workflow"}</span>
      </div>
      {shown
        ? <WorkflowDetail workflow={shown} results={detail.detail?.results} now={now} selectedAgentId={open.agentId}
          onSelectAgent={(agentId) => onChange({ runId: open.runId, agentId })} />
        : <p role="status" className="p-4 text-sm text-muted-foreground">{detail.failed ? "This workflow is no longer available." : "Loading workflow…"}</p>}
    </div>
  );
}

/**
 * The Claude session's running workflows as cards at the end of the chat, so a run launched from
 * this conversation stays in view while it works. View workflow opens it full screen.
 */
export function RunningWorkflows({ paneId, session }: { paneId: string; session?: string }) {
  const activity = useActivity(paneId, session);
  const now = useActivityClock(activity.data);
  const [open, setOpen] = useState<OpenWorkflow | null>(null);
  const running = activity.data?.available ? activity.data.workflows.filter((w) => w.status === "running") : [];
  if (running.length === 0 && !open) return null;
  return (
    <>
      {running.length > 0 && (
        <div className="mt-4 flex flex-col gap-3">
          {running.map((workflow) => (
            <WorkflowCard key={workflow.runId} workflow={workflow} now={now} onOpen={() => setOpen({ runId: workflow.runId, agentId: null })} />
          ))}
        </div>
      )}
      {open && <WorkflowScreen paneId={paneId} session={session} activity={activity} open={open} now={now} onChange={setOpen} />}
    </>
  );
}
