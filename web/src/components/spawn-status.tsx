import { Button } from "@/components/ui/button";
import { agentLabel, runSpawn, useSpawnState } from "@/lib/spawn";

/** Progress of the agent the new-agent sheet is starting in this pane; nothing when none is. */
export function SpawnStatus({ paneId }: { paneId: string }) {
  const state = useSpawnState(paneId);
  if (!state || state.phase === "done") return null;
  const name = agentLabel(state.agent);
  return (
    <section className="border-t border-border/40 px-3 py-3" aria-label={`Starting ${name}`}>
      {state.phase === "working" ? (
        <p role="status" className="text-sm text-muted-foreground">
          {state.stage === "start" ? `Starting ${name}…` : `${name} is up. Sending your first message when it is ready…`}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-destructive">
            {state.stage === "start" ? `Could not start ${name}.` : "Your first message was not sent."} {state.error}
          </p>
          {state.stage === "queue" && <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{state.message}</p>}
          <Button className="h-11 self-start" variant="outline" onClick={() => void runSpawn(paneId)}>
            Try again
          </Button>
        </div>
      )}
    </section>
  );
}
