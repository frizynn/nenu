import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronRight, Folder, TriangleAlert } from "lucide-react";
import { useNavigate, useRevalidator, useRouteLoaderData } from "react-router";

import type { NewPreset } from "@/components/new-dialog";
import { Button } from "@/components/ui/button";
import { inputField, textField } from "@/components/ui/field";
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
import type { AgentView } from "@/lib/types";

// Only someone choosing a folder needs the picker; it stays out of the bundle every page loads.
const DirPicker = lazy(() => import("@/components/dir-picker").then((m) => ({ default: m.DirPicker })));

export interface NewAgentValues {
  agent: SpawnAgent;
  cwd: string;
  name: string;
  message: string;
  permission: string;
}

/** A labelled field of the New flow: the label over its control. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-footnote font-medium text-muted-foreground">
      {label}
      {children}
    </label>
  );
}

export function Segmented<T extends string>({ label, options, value, onChange, className }: {
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
            "h-8 flex-auto truncate rounded-md px-1.5 text-footnote font-medium transition-colors coarse:h-11",
            value === o.id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The agent form of the New flow. Mounting it starts a fresh form. The folder picker takes the form's
 * place while `browsing`, and the host owns that switch, so its header can title the step and step back.
 */
export function NewAgentForm({ defaultCwd, defaultMessage = "", liveDirs, readOnly, onSubmit, browsing, onBrowsing }: {
  defaultCwd: string;
  defaultMessage?: string;
  liveDirs: string[];
  readOnly: boolean;
  /** Resolves to an error to show inline, or null once the new pane is open. */
  onSubmit: (values: NewAgentValues) => Promise<string | null>;
  browsing: boolean;
  onBrowsing: (browsing: boolean) => void;
}) {
  const [agent, setAgent] = useState<SpawnAgent>(loadAgent);
  const [permissions, setPermissions] = useState(() => ({ claude: loadPermission("claude"), codex: loadPermission("codex") }));
  const [cwd, setCwd] = useState(defaultCwd);
  const [name, setName] = useState("");
  const [message, setMessage] = useState(defaultMessage);
  const [recent] = useState(loadDirs);
  const [home, setHome] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A self-update reload would drop a half-typed first message; hold it while the form is up.
  useHoldReload("new-agent", true);

  // Learn the host's home once, so folders read as ~/… before the picker is ever opened.
  useEffect(() => {
    if (home) return;
    const abort = new AbortController();
    fetchHomeDirs("~", false, abort.signal).then((d) => setHome(d.home), () => undefined);
    return () => abort.abort();
  }, [home]);

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
  if (browsing) {
    return (
      <Suspense fallback={<p className="px-2 py-3 text-subhead text-muted-foreground">Loading…</p>}>
        <DirPicker
          home={home}
          shortcuts={suggestDirs([cwd], liveDirs, recent)}
          onHome={setHome}
          onPick={(path) => {
            setCwd(path);
            onBrowsing(false);
          }}
        />
      </Suspense>
    );
  }
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Segmented label="Agent" options={SPAWN_AGENTS} value={agent} onChange={setAgent} />

      <FolderButton shown={shown} parent={parent} onClick={() => onBrowsing(true)} />

      {chosen && !shell && (
        <div className="flex flex-col gap-1.5">
          <Segmented
            label="Permissions"
            options={choices}
            value={chosen.id}
            onChange={(id) => setPermissions((p) => ({ ...p, [agent]: id }))}
          />
          <p className={cn("flex items-start gap-1.5 px-0.5 text-footnote", chosen.danger ? "text-status-working" : "text-muted-foreground")}>
            {chosen.danger && <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />}
            {chosen.hint}
          </p>
        </div>
      )}

      <input aria-label="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" className={inputField} />

      {!shell && (
        <textarea
          aria-label="First message (optional)"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={3}
          placeholder={`First message (optional), sent when ${agentLabel(agent)} is ready`}
          className={textField}
          data-autofocus
        />
      )}

      {readOnly && <p className="text-subhead text-muted-foreground">Read-only: this device is not authorised to create.</p>}
      {error && (
        <p role="alert" className="text-subhead text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" size="block" disabled={busy || readOnly} aria-busy={busy || undefined}>
        {busy ? "Creating…" : shell ? "Open shell" : `Start ${agentLabel(agent)}`}
      </Button>
    </form>
  );
}

/** A folder as a tappable row: its name over its parent, opening the picker. */
export function FolderButton({ shown, parent, onClick, label = "Directory" }: { shown: string; parent: string; onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      aria-label={`${label}: ${shown}`}
      onClick={onClick}
      className="flex h-12 w-full items-center gap-3 rounded-lg border border-border bg-background px-3 text-left hover:bg-accent/60 active:bg-accent coarse:h-14"
    >
      <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-subhead font-medium">{shown === "~" ? "Home" : baseName(shown)}</span>
        <span className="block truncate text-footnote text-muted-foreground">{parent}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-subtle-foreground" aria-hidden />
    </button>
  );
}

const uniqueDirs = (panes: AgentView[]) => [...new Set(panes.map((p) => p.cwd).filter(Boolean))];

/** Folders worth offering: where agents run now. */
export const liveDirsOf = (data: HomeData | undefined) => uniqueDirs([...(data?.agents ?? []), ...(data?.shellPanes ?? [])]);

/** Where a new agent starts: a tab inherits its workspace's focused folder, a workspace the last pick. */
export function defaultCwdFor(target: SpawnTarget, data: HomeData | undefined): string {
  if (target.kind !== "tab") return loadDirs()[0] ?? "";
  const panes = [...(data?.agents ?? []), ...(data?.shellPanes ?? [])].filter((p) => p.workspaceId === target.workspaceId);
  return uniqueDirs(panes.sort((a, b) => Number(b.focused) - Number(a.focused)))[0] ?? "";
}

/**
 * Whether the step that sent a create is still on screen. One the person stepped away from still
 * lands and refreshes the lists, but it navigates and closes nothing: by then the sheet may hold
 * whatever they opened next.
 */
export function useOnScreen() {
  const onScreen = useRef(false);
  useEffect(() => {
    onScreen.current = true;
    return () => {
      onScreen.current = false;
    };
  }, []);
  return onScreen;
}

/** Create the tab or workspace, then open its pane live. Resolves to an error to show, or null. */
export function useSpawnInto(onDone: () => void) {
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData | undefined;
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const onScreen = useOnScreen();
  return async (target: SpawnTarget, values: NewAgentValues): Promise<string | null> => {
    try {
      const created = await spawn({ ...values, target, session: data?.session });
      if (!created.ok) return created.error;
      void revalidator.revalidate();
      if (!onScreen.current) return null;
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
      navigate(panePath(p.paneId, data?.session), { state: { freshPane: fresh } });
      onDone();
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause.message : "Could not create it.";
    }
  };
}

// ── The New flow's request ────────────────────────────────────────────────────────────────────
// Every way to create something (sidebar, ⌘N, the phone's center +, a tab strip's +, Home's composer,
// a project's New thread) opens the one New flow mounted here, at the app root, preset to where the
// person is, so none of them threads state through its parents.
let newRequest: NewPreset | null = null;
const newListeners = new Set<() => void>();
/** Opens the New flow on its list (`true`), preset to a kind and its place, or closes it (`false`). */
export function openNewDialog(open: boolean | NewPreset = true): void {
  newRequest = open === true ? {} : open === false ? null : open;
  for (const fn of newListeners) fn();
}
function useNewDialogRequest(): NewPreset | null {
  return useSyncExternalStore(
    (fn) => (newListeners.add(fn), () => void newListeners.delete(fn)),
    () => newRequest,
  );
}
export function useNewDialogOpen(): boolean {
  return useNewDialogRequest() !== null;
}

// The flow is only loaded once someone opens it, like the folder picker.
const NewDialog = lazy(() => import("@/components/new-dialog"));

// Each request mounts a fresh flow: ⌘N over an open one starts over instead of keeping its step,
// and a create still in flight in the one it replaced is off screen.
let opened = 0;
const openings = new WeakMap<NewPreset, number>();
function openingOf(preset: NewPreset): number {
  if (!openings.has(preset)) openings.set(preset, ++opened);
  return openings.get(preset)!;
}

/** The New flow, mounted at the app root. {@link openNewAgent} (lib/spawn) opens it on a tab or a workspace. */
export function NewAgentHost() {
  const target = useNewAgentRequest();
  const request = useNewDialogRequest();
  const preset: NewPreset | null = request ?? target;
  if (!preset) return null;
  return (
    <Suspense fallback={null}>
      <NewDialog key={openingOf(preset)} preset={preset} onClose={() => { openNewDialog(false); openNewAgent(null); }} />
    </Suspense>
  );
}
