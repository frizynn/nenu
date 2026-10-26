import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AppWindow, ChevronRight, FolderPlus, Sparkle, type IconComponent } from "@/components/ui/icon";
import { useParams, useRouteLoaderData } from "react-router";

import {
  Field,
  NewAgentForm,
  Segmented,
  defaultCwdFor,
  liveDirsOf,
  useSpawnInto,
} from "@/components/new-agent-sheet";
import { Button } from "@/components/ui/button";
import { textField } from "@/components/ui/field";
import { SelectField } from "@/components/ui/select-field";
import { BottomSheet } from "@/components/ui/sheet";
import { useMediaQuery } from "@/hooks/use-media-query";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { useHoldReload } from "@/lib/reload-guard";
import { workspaceName } from "@/lib/spaces";
import { agentLabel, loadAgent, loadModel, loadPermission, type SpawnTarget } from "@/lib/spawn";
import { ModelMenu, type StartAgent } from "@/components/start-pickers";
import { listedModel, useStartModels } from "@/hooks/use-start-models";
import { destinationFolder, destinationTarget, SCRATCH } from "@/lib/start-destination";
import { tabName } from "@/lib/spaces";
import { isReadOnly, type WorkspaceView } from "@/lib/types";
import { cn } from "@/lib/utils";

export type NewKind = "tab" | "workspace" | "chat";

/** Where the New flow opens: on a kind and the place it starts in. Without a kind a phone opens on the list. */
export interface NewPreset {
  kind?: NewKind;
  workspaceId?: string;
  /** A first message already written, as Home's composer hands it over. */
  message?: string;
}

const DESKTOP = "(min-width: 1024px)";
const matches = (query: string) => typeof window.matchMedia === "function" && window.matchMedia(query).matches;

function titleOf(kind: NewKind): string {
  switch (kind) {
    case "tab": return "New tab";
    case "workspace": return "New workspace";
    case "chat": return "Quick question";
  }
}

/** Where the person is: the workspace of the pane or space on screen. */
export function newContext(data: HomeData | undefined, params: { paneId?: string; spaceId?: string }) {
  const panes = [...(data?.agents ?? []), ...(data?.shellPanes ?? [])];
  const pane = panes.find((p) => p.paneId === params.paneId);
  const workspaces = data?.workspaces ?? [];
  const workspaceId =
    pane?.workspaceId ??
    workspaces.find((w) => w.workspaceId === params.spaceId)?.workspaceId ??
    workspaces.find((w) => w.focused)?.workspaceId ??
    workspaces[0]?.workspaceId;
  return { workspaceId };
}

type KindRow = { key: string; label: string; hint: string; icon: IconComponent | ReactNode; current: boolean; onChoose: () => void };

/**
 * The one place to start an agent, whichever button opened it: a bottom sheet on a
 * phone whose header names the step and steps back, a two-pane dialog of one fixed size on a desk,
 * where the list of kinds stays in view and only the folder picker steps back.
 */
export default function NewDialog({ preset = {}, open, onClose, onExited }: {
  preset?: NewPreset;
  /** Closed, the sheet slides away showing its last step, and `onExited` follows once it is gone. */
  open: boolean;
  onClose: () => void;
  onExited?: () => void;
}) {
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData | undefined;
  const params = useParams();
  const workspaces = data?.workspaces ?? [];
  const [context] = useState(() => newContext(data, params));
  const [workspaceId, setWorkspaceId] = useState(preset.workspaceId ?? context.workspaceId);
  const [kind, setKind] = useState<NewKind | null>(() => {
    if (preset.kind) return preset.kind;
    if (!matches(DESKTOP)) return null;
    return context.workspaceId ? "tab" : "workspace";
  });
  const [browsing, setBrowsing] = useState(false);
  const desk = useMediaQuery(DESKTOP);
  const heading = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLElement>(null);
  useHoldReload("new-dialog", open);

  const readOnly = isReadOnly(data?.device);
  const workspace = workspaces.find((w) => w.workspaceId === workspaceId);
  // A tab opens in a workspace; without one, that kind is not offered.
  const shown = kind === "tab" && !workspace ? null : kind;
  const title = browsing ? "Choose a folder" : shown ? titleOf(shown) : "New";
  const back = browsing ? () => setBrowsing(false) : shown && !desk ? () => choose(null) : undefined;
  const step = browsing ? "folder" : shown ?? "list";

  // Each step takes focus as it opens, since the control that opened it is hidden or gone by then. A
  // desk lands in the step's field to type; a phone on its title, so no keyboard pops up unasked.
  useEffect(() => {
    const field = matches("(pointer: fine)") ? body.current?.querySelector<HTMLElement>("[data-autofocus]") : null;
    (field ?? heading.current)?.focus({ preventScroll: true });
  }, [step]);

  function choose(next: NewKind | null) {
    setBrowsing(false);
    setKind(next);
  }

  const row = (id: NewKind, label: string, hint: string, icon: IconComponent): KindRow =>
    ({ key: id, label, hint, icon, current: shown === id, onChoose: () => choose(id) });
  const start: KindRow[] = [
    ...(workspace ? [row("tab", `Here in ${workspaceName(workspace)}`, "Runs in this workspace, in a new tab", AppWindow)] : []),
    row("workspace", "In a new folder", "Pick a folder for a new workspace", FolderPlus),
    row("chat", "Quick question", "No folder, nothing to clean up", Sparkle),
  ];
  const agentPane = { data, readOnly, message: preset.message, browsing, onBrowsing: setBrowsing, onDone: onClose };

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      onExited={onExited}
      title={title}
      onBack={back}
      headingRef={heading}
      className={cn(
        "flex flex-col",
        "sm:mx-auto sm:my-auto sm:max-w-lg sm:rounded-2xl sm:border sm:pb-4",
        // On a desk every step, the folder picker included, keeps one size.
        "lg:h-[min(40rem,85dvh)] lg:max-w-[760px] lg:overflow-hidden lg:pb-0",
        browsing && "h-dvh sm:h-[min(40rem,85dvh)]",
      )}
      // The flow lays out its own body: the list, then each step's form, side by side on a desk.
      bodyClassName="flex min-h-0 flex-1 flex-col p-0"
    >
      <div className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[220px_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]">
        <nav aria-label="Create" className={cn("flex flex-col gap-4 p-2 lg:gap-3 lg:overflow-y-auto lg:border-r lg:border-border lg:p-2.5", shown && "max-lg:hidden")}>
          <KindGroup title="Start an agent" rows={start} />
        </nav>

        <section ref={body} aria-label={title} className={cn("flex min-w-0 flex-1 flex-col px-4 pt-3 lg:overflow-y-auto lg:px-5 lg:pt-4 lg:pb-4", !shown && "max-lg:hidden")}>
          {shown === "tab" && workspace && (
            <TabPane workspaces={workspaces} workspaceId={workspace.workspaceId} onWorkspace={setWorkspaceId} {...agentPane} />
          )}
          {shown === "workspace" && <AgentPane target={{ kind: "workspace" }} {...agentPane} />}
          {shown === "chat" && <QuickChatPane data={data} readOnly={readOnly} message={preset.message} onDone={onClose} />}
        </section>
      </div>
    </BottomSheet>
  );
}

function KindGroup({ title, rows }: { title: string; rows: KindRow[] }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col">
      <h3 id={id} className="px-2 pb-1 text-footnote font-medium text-muted-foreground lg:px-2.5 lg:text-caption">{title}</h3>
      {rows.map((k) => (
        <button
          key={k.key}
          type="button"
          aria-current={k.current ? "true" : undefined}
          onClick={k.onChoose}
          className="flex min-h-14 w-full items-center gap-3 rounded-lg px-2 text-left transition-colors duration-120 hover:bg-hover active:bg-accent aria-[current=true]:bg-[var(--workbench-row-selected)] lg:min-h-0 lg:items-start lg:gap-2.5 lg:p-2.5"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted lg:size-auto lg:bg-transparent lg:pt-0.5">
            {typeof k.icon === "function" ? <k.icon className="size-5 lg:size-4" aria-hidden /> : k.icon}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-body font-medium lg:text-footnote">{k.label}</span>
            <span className="block text-footnote text-muted-foreground lg:text-caption">{k.hint}</span>
          </span>
          <ChevronRight className="size-4 shrink-0 text-subtle-foreground lg:hidden" aria-hidden />
        </button>
      ))}
    </section>
  );
}

interface AgentPaneProps {
  data: HomeData | undefined;
  readOnly: boolean;
  message?: string;
  browsing: boolean;
  onBrowsing: (browsing: boolean) => void;
  onDone: () => void;
}

function AgentPane({ target, data, readOnly, message, browsing, onBrowsing, onDone }: AgentPaneProps & { target: SpawnTarget }) {
  const spawnInto = useSpawnInto(onDone);
  // A new folder can be on any machine that is connected; a tab is in its workspace's.
  const machines = target.kind === "workspace" ? (data?.machines ?? []).filter((m) => m.state === "connected") : [];
  const [session, setSession] = useState(data?.session);
  const picked = machines.find((m) => m.session === session);
  const form = (
    <NewAgentForm key={session ?? ""} machine={machines.length > 1 ? { session } : undefined}
      defaultCwd={picked && session !== data?.session ? "" : target.kind === "pane" && data ? destinationFolder(target, data) ?? "" : defaultCwdFor(target, data)} defaultMessage={message}
      liveDirs={picked?.herd ? liveDirsOf(picked.herd) : liveDirsOf(data)} readOnly={readOnly}
      browsing={browsing} onBrowsing={onBrowsing} onSubmit={(values) => spawnInto(target, values)} />
  );
  if (machines.length < 2) return form;
  return (
    <div className="flex flex-col gap-3">
      {!browsing && <Segmented label="Machine" options={machines.map((m) => ({ id: m.session ?? "", label: m.label }))}
        value={session ?? ""} onChange={(id) => setSession(id || undefined)} />}
      {form}
    </div>
  );
}

/** A new tab of a workspace, or a new pane beside one of its tabs' (the same destinations Start offers). */
function TabPane({ workspaces, workspaceId, onWorkspace, ...pane }: AgentPaneProps & {
  workspaces: WorkspaceView[];
  workspaceId: string;
  onWorkspace: (id: string) => void;
}) {
  const tabs = (pane.data?.tabs ?? []).filter((t) => t.workspaceId === workspaceId);
  const [tabId, setTabId] = useState("");
  const tab = tabs.find((t) => t.tabId === tabId);
  const target: SpawnTarget = tab ? { kind: "pane", tabId: tab.tabId } : { kind: "tab", workspaceId };
  return (
    <div className="flex flex-1 flex-col gap-3">
      {!pane.browsing && (
        <>
          <Field label="Workspace">
            <SelectField value={workspaceId} onChange={(e) => { onWorkspace(e.currentTarget.value); setTabId(""); }}>
              {workspaces.map((w) => <option key={w.workspaceId} value={w.workspaceId}>{workspaceName(w)}</option>)}
            </SelectField>
          </Field>
          <Field label="Opens in">
            <SelectField value={tab?.tabId ?? ""} onChange={(e) => setTabId(e.currentTarget.value)}>
              <option value="">A new tab</option>
              {tabs.map((t, i) => <option key={t.tabId} value={t.tabId}>{`Beside ${tabName(t.label, i + 1)}`}</option>)}
            </SelectField>
          </Field>
        </>
      )}
      <AgentPane key={`${workspaceId}:${tab?.tabId ?? ""}`} target={target} {...pane} />
    </div>
  );
}

function QuickChatPane({ data, readOnly, message: preset = "", onDone }: { data: HomeData | undefined; readOnly: boolean; message?: string; onDone: () => void }) {
  const [agent, setAgent] = useState<StartAgent>(() => {
    const last = loadAgent();
    return last === "shell" ? "claude" : last;
  });
  const [models, setModels] = useState(() => ({ claude: loadModel("claude"), codex: loadModel("codex") }));
  const listed = useStartModels(data?.session, !readOnly);
  const model = listedModel(listed, agent, models[agent]);
  const [message, setMessage] = useState(preset);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const spawnInto = useSpawnInto(onDone);
  const scratch = data?.workspaces.find((w) => w.label.toLowerCase() === SCRATCH);

  async function submit() {
    if (busy || readOnly) return;
    setBusy(true);
    setError(null);
    // The scratch workspace is made once, and every later quick chat is a tab in it (lib/start-destination).
    const { target, cwd, name } = destinationTarget({ kind: "quick" }, "", data ?? { workspaces: [], tabs: [], agents: [], shellPanes: [] });
    const failure = await spawnInto(target, { agent, cwd, name, message, permission: loadPermission(agent), model });
    if (failure !== null) {
      setError(failure);
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="flex items-center text-footnote text-muted-foreground">
        <ModelMenu models={listed} agent={agent} model={model} onPick={(a, m) => { setAgent(a); setModels((current) => ({ ...current, [a]: m })); }} />
      </div>
      <textarea aria-label="Message" value={message} onChange={(e) => setMessage(e.target.value)} rows={4}
        placeholder="Ask anything" className={textField} data-autofocus />
      <p className="text-footnote text-muted-foreground">
        Opens in the <span className="font-medium text-foreground">{SCRATCH}</span> workspace on <code>~</code>
        {scratch ? "." : ", which is created the first time."}
      </p>
      {readOnly && <p className="text-subhead text-muted-foreground">Read-only: this device is not authorised to create.</p>}
      {error && <p role="alert" className="text-subhead text-destructive">{error}</p>}
      <Button type="submit" className="h-11" disabled={busy || readOnly} aria-busy={busy || undefined}>{busy ? "Starting…" : `Ask ${agentLabel(agent)}`}</Button>
    </form>
  );
}
