import { useEffect, useState } from "react";
import { fetchTaskOutput, type TaskOutputResponse } from "@/lib/activity";

/** The newest output of one background command, as plain text nodes (never HTML). */
export function TaskOutput({ paneId, session, taskId }: { paneId: string; session?: string; taskId: string }) {
  const [output, setOutput] = useState<TaskOutputResponse | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setOutput(null);
    setFailed(false);
    fetchTaskOutput(paneId, taskId, session, controller.signal).then(setOutput, () => {
      if (!controller.signal.aborted) setFailed(true);
    });
    return () => controller.abort();
  }, [paneId, session, taskId]);
  if (failed) return <p role="status" className="text-xs text-muted-foreground">Output is no longer available.</p>;
  if (!output) return <p role="status" className="text-xs text-muted-foreground">Loading output…</p>;
  return (
    <div className="flex flex-col gap-1.5">
      {output.truncated && <span className="text-[11.5px] text-muted-foreground">Showing the newest output only.</span>}
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-3 font-mono text-xs leading-relaxed">
        {output.text || "(no output)"}
      </pre>
    </div>
  );
}
