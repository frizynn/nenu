import { lazy, Suspense, useEffect, useState } from "react";
import { ChevronRight, Folder, TriangleAlert } from "lucide-react";
import { useNavigate, useRevalidator, useRouteLoaderData } from "react-router";

import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { fetchHomeDirs } from "@/lib/api";
import { baseName, tildePath } from "@/lib/dir-picker";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { panePath } from "@/lib/nav";
import { useHoldReload } from "@/lib/reload-guard";
import {
  PERMISSIONS,
  SPAWN_AGENTS,
  agentLabel,
  loadAgent,
  loadDirs,
  loadPermission,
  openNewAgent,
  spawn,
  suggestDirs,
  useNewAgentRequest,
  type SpawnAgent,
  type SpawnTarget,
} from "@/lib/spawn";
import { isReadOnly, type AgentView } from "@/lib/types";

// Only someone choosing a folder needs the picker; it stays out of the bundle every page loads.
const DirPicker = lazy(() => import("@/components/dir-picker").then((m) => ({ default: m.DirPicker })));

export interface NewAgentValues {
  agent: SpawnAgent;
  cwd: string;
  name: string;
  message: string;
  permission: string;
}

interface NewAgentSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  defaultCwd: string;
  defaultMessage?: string;
  liveDirs: string[];
  readOnly: boolean;
  /** Resolves to an error to show inline, or null once the new pane is open. */
  onSubmit: (values: NewAgentValues) => Promise<string | null>;
}

const field =
  "h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring";

function Segmented<T extends string>({ label, options, value, onChange, className }: {
  label: string;
  options: ReadonlyArray<{ id: T; label: string }>;
  value: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("flex gap-0.5 rounded-lg bg-muted p-0.5", className)}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            "h-8 flex-auto truncate rounded-md px-1.5 text-[13px] font-medium transition-colors",
            value === o.id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function NewAgentSheet({ open, onClose, title, defaultCwd, defaultMessage = "", liveDirs, readOnly, onSubmit }: NewAgentSheetProps) {
  const [agent, setAgent] = useState<SpawnAgent>("claude");
  const [permissions, setPermissions] = useState({ claude: "ask", codex: "ask" });
  const [cwd, setCwd] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  const [home, setHome] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A self-update reload would drop a half-typed first message; hold it until the sheet closes.
  useHoldReload("new-agent", open);

  useEffect(() => {
    if (!open) return;
    setAgent(loadAgent());
    setPermissions({ claude: loadPermission("claude"), codex: loadPermission("codex") });
    setCwd(defaultCwd);
    setName("");
    setMessage(defaultMessage);
    setRecent(loadDirs());
    setBrowsing(false);
    setBusy(false);
    setError(null);
    // Only a fresh open resets the form; a poll that changes the default dir must not clobber typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Learn the host's home once, so folders read as ~/… before the picker is ever opened.
  useEffect(() => {
    if (!open || home) return;
    const abort = new AbortController();
    fetchHomeDirs("~", false, abort.signal).then((d) => setHome(d.home), () => undefined);
    return () => abort.abort();
  }, [open, home]);

  async function submit() {
    if (busy || readOnly) return;
    setBusy(true);
    setError(null);
    const permission = agent === "shell" ? "ask" : permissions[agent];
    const failure = await onSubmit({ agent, cwd, name, message, permission });
    if (failure !== null) {
      setError(failure);
      setBusy(false);
    }
  }

  const shell = agent === "shell";
  const choices = shell ? [] : PERMISSIONS[agent];
  const chosen = shell ? undefined : choices.find((p) => p.id === permissions[agent]);
  const shown = cwd.trim() ? tildePath(cwd.trim(), home) : "~";
  const parent = shown === "~" ? "~" : shown.slice(0, -baseName(shown).length - 1) || "/";
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={browsing ? "Choose a folder" : title}
      className={cn("sm:mx-auto sm:my-auto sm:max-w-lg sm:rounded-2xl sm:border sm:pb-4", browsing && "flex h-dvh flex-col sm:h-[min(40rem,85dvh)] [&>div:last-child]:flex [&>div:last-child]:flex-1 [&>div:last-child]:flex-col")}
    >
      {browsing ? (
        <Suspense fallback={<p className="px-2 py-3 text-sm text-muted-foreground">Loading…</p>}>
          <DirPicker
            home={home}
            shortcuts={suggestDirs([cwd], liveDirs, recent)}
            onHome={setHome}
            onBack={() => setBrowsing(false)}
            onPick={(path) => {
              setCwd(path);
              setBrowsing(false);
            }}
          />
        </Suspense>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Segmented label="Agent" options={SPAWN_AGENTS} value={agent} onChange={setAgent} />

          <button
            type="button"
            aria-label={`Directory: ${shown}`}
            onClick={() => setBrowsing(true)}
            className="flex h-12 w-full items-center gap-3 rounded-lg border border-border bg-background px-3 text-left hover:bg-accent/60 active:bg-accent"
          >
            <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-sm font-medium">{shown === "~" ? "Home" : baseName(shown)}</span>
              <span className="block truncate text-xs text-muted-foreground">{parent}</span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" aria-hidden />
          </button>

          {chosen && !shell && (
            <div className="flex flex-col gap-1.5">
              <Segmented
                label="Permissions"
                options={choices}
                value={chosen.id}
                onChange={(id) => setPermissions((p) => ({ ...p, [agent]: id }))}
              />
              <p className={cn("flex items-start gap-1.5 px-0.5 text-xs", chosen.danger ? "text-status-working" : "text-muted-foreground")}>
                {chosen.danger && <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />}
                {chosen.hint}
              </p>
            </div>
          )}

          <input aria-label="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" className={field} />

          {!shell && (
            <textarea
              aria-label="First message (optional)"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              placeholder={`First message (optional), sent when ${agentLabel(agent)} is ready`}
              className={cn(field, "h-auto resize-none py-2")}
            />
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
      )}
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
      defaultMessage={shown.message}
      liveDirs={live}
      readOnly={isReadOnly(data?.device)}
      onSubmit={onSubmit}
    />
  );
}
