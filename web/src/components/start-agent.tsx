import { useEffect, useId, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { PermissionPicker, Segmented } from "@/components/new-agent-sheet";
import { Button } from "@/components/ui/button";
import { ChevronDown } from "@/components/ui/icon";
import { startAgent } from "@/lib/api";
import { PERMISSIONS, SPAWN_AGENTS, agentLabel, loadAgent, loadPermission, saveAgent, savePermission, type SpawnAgent } from "@/lib/spawn";
import { cn } from "@/lib/utils";

type PaneAgent = Exclude<SpawnAgent, "shell">;
// The pane is the shell already: what starts in it is an agent.
const AGENTS = SPAWN_AGENTS.filter((a): a is { id: PaneAgent; label: string } => a.id !== "shell");

/**
 * New's agent and permission choice, started in this shell. Folded, it is one row that starts the
 * remembered choice, so the terminal keeps its height; the choice unfolds under it and folds again on
 * a start, a tap elsewhere or Escape. The bridge turns the level into flags.
 */
export function StartAgent({ paneId, session, disabled, ready }: { paneId: string; session?: string; disabled: boolean; ready: boolean }) {
  const pending = useRef(false);
  const root = useRef<HTMLElement>(null);
  const optionsId = useId();
  const [open, setOpen] = useState(false);
  const [agent, setAgent] = useState<PaneAgent>(() => {
    const last = loadAgent();
    return last === "shell" ? "claude" : last;
  });
  const [permissions, setPermissions] = useState(() => ({ claude: loadPermission("claude"), codex: loadPermission("codex") }));
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revalidator = useRevalidator();
  const level = PERMISSIONS[agent].find((p) => p.id === permissions[agent]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node && root.current?.contains(event.target))) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing && !event.defaultPrevented) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function start() {
    if (pending.current || disabled || !ready) return;
    pending.current = true;
    setOpen(false);
    setStarting(true);
    setError(null);
    const permission = permissions[agent];
    saveAgent(agent);
    savePermission(agent, permission);
    try {
      const result = await startAgent(paneId, agent, session, permission);
      if (!result.ok) setError(result.error);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the agent.");
    } finally {
      pending.current = false;
      setStarting(false);
      void revalidator.revalidate();
    }
  }
  return <section ref={root} className="border-t border-border/40 px-3 py-1.5" aria-label="Start a conversation">
    <div className="flex max-w-md">
      <Button variant="secondary" className="min-w-0 flex-1 justify-start rounded-r-none" disabled={disabled || starting || !ready}
        aria-busy={starting || undefined} onClick={() => void start()}>
        <span className="truncate">Start {agentLabel(agent)}</span>{" "}
        <span className={cn("shrink-0", level?.danger ? "text-status-working" : "text-muted-foreground")}>· {level?.label}</span>
      </Button>
      <Button variant="secondary" size="icon" className="rounded-l-none border-l border-background" aria-label="Agent and permissions"
        aria-expanded={open} aria-controls={optionsId} onClick={() => setOpen((o) => !o)}>
        <ChevronDown aria-hidden className={cn(open && "rotate-180")} />
      </Button>
    </div>
    {open && <div id={optionsId} className="flex max-w-md flex-col gap-3 pt-3 pb-1.5">
      <Segmented label="Agent" options={AGENTS} value={agent} onChange={setAgent} />
      <PermissionPicker agent={agent} value={permissions[agent]} onChange={(id) => setPermissions((p) => ({ ...p, [agent]: id }))} />
    </div>}
    {starting && <p role="status" className="mt-1.5 text-subhead text-muted-foreground">Starting the agent…</p>}
    {!ready && <p role="status" className="mt-1.5 text-subhead text-muted-foreground">Preparing the terminal…</p>}
    {error && <p role="alert" className="mt-1.5 text-subhead text-destructive">{error} Check the terminal before retrying.</p>}
  </section>;
}
