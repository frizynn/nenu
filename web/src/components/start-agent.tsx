import { useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { Button } from "@/components/ui/button";
import { startAgent } from "@/lib/api";

export function StartAgent({ paneId, session, disabled, ready }: { paneId: string; session?: string; disabled: boolean; ready: boolean }) {
  const pending = useRef(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revalidator = useRevalidator();
  async function start(agent: "codex" | "claude") {
    if (pending.current || disabled || !ready) return;
    pending.current = true;
    setStarting(true);
    setError(null);
    try {
      const result = await startAgent(paneId, agent, session);
      if (!result.ok) setError(result.error);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the agent.");
    } finally {
      pending.current = false;
      setStarting(false);
      void revalidator.revalidate();
    }
  }
  return <section className="border-t border-border/40 px-3 py-3" aria-label="Start a conversation">
    <div className="flex flex-wrap gap-2">
      <Button className="h-11" disabled={disabled || starting || !ready} onClick={() => void start("codex")}>Start Codex</Button>
      <Button className="h-11" variant="outline" disabled={disabled || starting || !ready} onClick={() => void start("claude")}>Start Claude Code</Button>
    </div>
    {starting && <p role="status" className="mt-2 text-sm text-muted-foreground">Starting the agent…</p>}
    {!ready && <p role="status" className="mt-2 text-sm text-muted-foreground">Preparing the terminal…</p>}
    {error && <p role="alert" className="mt-2 text-sm text-destructive">{error} Check the terminal before retrying.</p>}
  </section>;
}
