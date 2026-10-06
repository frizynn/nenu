import { useEffect, useState } from "react";
import { useNavigate, useRevalidator, useRouteLoaderData } from "react-router";

import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { panePath } from "@/lib/nav";
import { useHoldReload } from "@/lib/reload-guard";
import {
  SPAWN_AGENTS,
  agentLabel,
  loadAgent,
  loadDirs,
  openNewAgent,
  spawn,
  suggestDirs,
  useNewAgentRequest,
  type SpawnAgent,
  type SpawnTarget,
} from "@/lib/spawn";
import { isReadOnly, type AgentView } from "@/lib/types";

export interface NewAgentValues {
  agent: SpawnAgent;
  cwd: string;
  name: string;
  message: string;
}

interface NewAgentSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  defaultCwd: string;
  liveDirs: string[];
  readOnly: boolean;
  /** Resolves to an error to show inline, or null once the new pane is open. */
  onSubmit: (values: NewAgentValues) => Promise<string | null>;
}

const field =
  "h-11 w-full rounded-lg border border-border bg-background px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function NewAgentSheet({ open, onClose, title, defaultCwd, liveDirs, readOnly, onSubmit }: NewAgentSheetProps) {
  const [agent, setAgent] = useState<SpawnAgent>("claude");
  const [cwd, setCwd] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A self-update reload would drop a half-typed first message; hold it until the sheet closes.
  useHoldReload("new-agent", open);

  useEffect(() => {
    if (!open) return;
    setAgent(loadAgent());
    setCwd(defaultCwd);
    setName("");
    setMessage("");
    setRecent(loadDirs());
    setBusy(false);
    setError(null);
    // Only a fresh open resets the form; a poll that changes the default dir must not clobber typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function submit() {
    if (busy || readOnly) return;
    setBusy(true);
    setError(null);
    const failure = await onSubmit({ agent, cwd, name, message });
    if (failure !== null) {
      setError(failure);
      setBusy(false);
    }
  }

  const shell = agent === "shell";
  const dirs = suggestDirs(liveDirs, recent, cwd);
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={title}
      className="sm:mx-auto sm:my-auto sm:max-w-lg sm:rounded-2xl sm:border sm:pb-4"
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div role="radiogroup" aria-label="Agent" className="grid grid-cols-3 gap-1 rounded-xl bg-muted p-1">
          {SPAWN_AGENTS.map((a) => (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={agent === a.id}
              onClick={() => setAgent(a.id)}
              className={cn(
                "min-h-11 rounded-lg px-2 text-sm font-medium transition-colors",
                agent === a.id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
              )}
            >
              {a.label}
            </button>
          ))}
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Directory</span>
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="~ (home dir)"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className={cn(field, "font-mono text-sm")}
          />
        </label>
        {dirs.length > 0 && (
          <div className="-mt-1 flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" aria-label="Recent directories">
            {dirs.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setCwd(d)}
                className="min-h-11 max-w-[14rem] shrink-0 truncate rounded-lg border border-border px-3 font-mono text-xs text-muted-foreground active:bg-accent"
              >
                {d}
              </button>
            ))}
          </div>
        )}

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Name (optional)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name it" className={field} />
        </label>

        {!shell && (
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">First message (optional)</span>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              placeholder={`Sent to ${agentLabel(agent)} as soon as it is ready`}
              className={cn(field, "h-auto resize-none py-2")}
            />
          </label>
        )}

        {readOnly && <p className="text-sm text-muted-foreground">Read-only: this device is not authorised to create.</p>}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy || readOnly} className="h-11">
          {busy ? "Creating…" : shell ? "Open shell" : `Start ${agentLabel(agent)}`}
        </Button>
      </form>
    </BottomSheet>
  );
}

const uniqueDirs = (panes: AgentView[]) => [...new Set(panes.map((p) => p.cwd).filter(Boolean))];

/** The one create sheet, mounted at the app root and opened through {@link openNewAgent}. */
export function NewAgentHost() {
  const target = useNewAgentRequest();
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData | undefined;
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  // The sheet keeps rendering through its close so a failed re-open never flashes empty content.
  const [last, setLast] = useState<SpawnTarget | null>(null);
  useEffect(() => {
    if (target) setLast(target);
  }, [target]);
  const shown = target ?? last;
  if (!shown) return null;

  const panes = [...(data?.agents ?? []), ...(data?.shellPanes ?? [])];
  const inWorkspace = shown.kind === "tab" ? panes.filter((p) => p.workspaceId === shown.workspaceId) : [];
  const workspaceDirs = uniqueDirs([...inWorkspace].sort((a, b) => Number(b.focused) - Number(a.focused)));
  const live = uniqueDirs(panes);

  async function onSubmit(values: NewAgentValues): Promise<string | null> {
    try {
      const created = await spawn({ ...values, target: shown!, session: data?.session });
      if (!created.ok) return created.error;
      const p = created.pane;
      // The new pane is not in the snapshot yet; hand it to the pane route so it opens live.
      const fresh: AgentView = {
        paneId: p.paneId,
        workspaceId: p.workspaceId,
        workspaceLabel: p.workspaceLabel,
        workspaceNumber: 0,
        tabId: p.tabId,
        agent: "shell",
        status: "unknown",
        cwd: p.cwd,
        focused: false,
        kind: "shell",
      };
      void revalidator.revalidate();
      navigate(panePath(p.paneId, data?.session), { state: { freshPane: fresh } });
      openNewAgent(null);
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause.message : "Could not create it.";
    }
  }

  return (
    <NewAgentSheet
      open={target !== null}
      onClose={() => openNewAgent(null)}
      title={shown.kind === "tab" ? "New tab" : "New chat"}
      defaultCwd={shown.kind === "tab" ? (workspaceDirs[0] ?? "") : (loadDirs()[0] ?? "")}
      liveDirs={live}
      readOnly={isReadOnly(data?.device)}
      onSubmit={onSubmit}
    />
  );
}
