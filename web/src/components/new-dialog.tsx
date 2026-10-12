import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { AppWindow, ChevronRight, Folder, FolderGit2, FolderPlus, MessageCircle, Sparkles, X, type LucideIcon } from "lucide-react";
import { useNavigate, useParams, useRevalidator, useRouteLoaderData } from "react-router";

import {
  Field,
  FolderButton,
  NewAgentForm,
  Segmented,
  defaultCwdFor,
  liveDirsOf,
  useOnScreen,
  useSpawnInto,
} from "@/components/new-agent-sheet";
import { NodeStartForm, errorMessage, startableRoles } from "@/components/node-start";
import { Button } from "@/components/ui/button";
import { inputField, textField } from "@/components/ui/field";
import { SelectField } from "@/components/ui/select-field";
import { BottomSheet } from "@/components/ui/sheet";
import { useMediaQuery } from "@/hooks/use-media-query";
import { createOrgProject, fetchHomeDirs } from "@/lib/api";
import { baseName, tildePath } from "@/lib/dir-picker";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { projectPath } from "@/lib/nav";
import { projectForPane } from "@/lib/projects";
import { useHoldReload } from "@/lib/reload-guard";
import { workspaceName } from "@/lib/spaces";
import { SPAWN_AGENTS, agentLabel, loadAgent, loadPermission, suggestDirs, type SpawnAgent, type SpawnTarget } from "@/lib/spawn";
import { isReadOnly, type NodeRole, type ProjectView, type WorkspaceView } from "@/lib/types";
import { cn } from "@/lib/utils";

const DirPicker = lazy(() => import("@/components/dir-picker").then((m) => ({ default: m.DirPicker })));

export type NewKind = "thread" | "tab" | "workspace" | "project" | "chat";

/** Where the New flow opens: on a kind and the place it starts in. Without a kind a phone opens on the list. */
export interface NewPreset {
  kind?: NewKind;
  workspaceId?: string;
  project?: string;
  role?: NodeRole;
  /** A first message already written, as Home's composer hands it over. */
  message?: string;
  /** Called instead of opening `project` once a thread starts in it: the page that asked refreshes itself. */
  onStarted?: () => void;
}

/** The workspace a quick chat opens in, created on the first one. */
export const SCRATCH = "scratch";
const DESKTOP = "(min-width: 1024px)";
const matches = (query: string) => typeof window.matchMedia === "function" && window.matchMedia(query).matches;

function titleOf(kind: NewKind, role: NodeRole): string {
  switch (kind) {
    case "tab": return "New tab";
    case "workspace": return "New workspace";
    case "chat": return "Quick question";
    case "project": return "New project";
    case "thread": return role === "coordinator" ? "New coordinator" : "New thread";
  }
}

/** Where the person is: the workspace and project of the pane, space or project on screen. */
export function newContext(data: HomeData | undefined, params: { paneId?: string; spaceId?: string; projectSlug?: string }) {
  const panes = [...(data?.agents ?? []), ...(data?.shellPanes ?? [])];
  const projects = data?.projects ?? [];
  const pane = panes.find((p) => p.paneId === params.paneId);
  const project =
    projects.find((p) => p.slug === params.projectSlug) ??
    projectForPane(projects, params.paneId)?.project ??
    projects.find((p) => (pane || params.spaceId) && p.workspaceIds?.includes(pane?.workspaceId ?? params.spaceId!));
  const workspaces = data?.workspaces ?? [];
  const workspaceId =
    pane?.workspaceId ??
    workspaces.find((w) => w.workspaceId === params.spaceId)?.workspaceId ??
    project?.workspaceIds?.find((id) => workspaces.some((w) => w.workspaceId === id)) ??
    workspaces.find((w) => w.focused)?.workspaceId ??
    workspaces[0]?.workspaceId;
  return { workspaceId, project: project?.slug };
}

/** A shell-quoted word, so the preview line pastes into a terminal as the same argv. */
export function shellWord(word: string): string {
  return /^[\w@%+=:,./~-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The exact `herdr-organizations` argv the bridge runs for a new project (bridge/org-cli.ts). */
export function projectCommand(name: string, goal: string, repo: string): string {
  const flags = [...(goal.trim() ? [`--goal=${shellWord(goal.trim())}`] : []), ...(repo ? [`--repo=${shellWord(repo)}`] : [])];
  return ["herdr-organizations", "new", ...flags, "--json", "--", shellWord(name.trim() || "…")].join(" ");
}

type KindRow = { id: NewKind; label: string; hint: string; icon: LucideIcon };

const canStart = (project: ProjectView) => startableRoles(project).length > 0;

/**
 * The one place to start an agent or organize work, whichever button opened it: a bottom sheet on a
 * phone whose header names the step and steps back, a two-pane dialog of one fixed size on a desk,
 * where the list of kinds stays in view and only the folder picker steps back.
 */
export default function NewDialog({ preset = {}, onClose }: { preset?: NewPreset; onClose: () => void }) {
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData | undefined;
  const params = useParams();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const workspaces = data?.workspaces ?? [];
  const projects = data?.projects ?? [];
  const [context] = useState(() => newContext(data, params));
  const [workspaceId, setWorkspaceId] = useState(preset.workspaceId ?? context.workspaceId);
  // A thread goes to the project on screen unless that one cannot start it.
  const [project, setProject] = useState(() => preset.project ?? projects.find((p) => p.slug === context.project && canStart(p))?.slug);
  const [role, setRole] = useState<NodeRole>(preset.role ?? "worker");
  const [kind, setKind] = useState<NewKind | null>(() => {
    if (preset.kind) return preset.kind;
    if (!matches(DESKTOP)) return null;
    return context.project ? "thread" : context.workspaceId ? "tab" : "workspace";
  });
  const [browsing, setBrowsing] = useState(false);
  const desk = useMediaQuery(DESKTOP);
  const heading = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLElement>(null);
  useHoldReload("new-dialog", true);

  const readOnly = isReadOnly(data?.device);
  const workspace = workspaces.find((w) => w.workspaceId === workspaceId);
  const current = projects.find((p) => p.slug === project) ?? projects.find(canStart);
  // The role the form starts, which a project without coordinators turns into a thread.
  const nodeRole = current && startableRoles(current).includes(role) ? role : "worker";
  // A tab opens in a workspace and a thread in a project; without one, that kind is not offered.
  const shown = kind === "tab" && !workspace ? null : kind === "thread" && !current ? null : kind;
  const title = browsing ? "Choose a folder" : shown ? titleOf(shown, nodeRole) : "New";
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
  function pickWorkspace(id: string) {
    setWorkspaceId(id);
    const bound = projects.find((p) => p.workspaceIds?.includes(id));
    if (bound && canStart(bound)) setProject(bound.slug);
  }
  function threadStarted(slug: string) {
    // The page that asked refreshes itself; a thread started in another project opens that one.
    if (preset.onStarted && slug === preset.project) preset.onStarted();
    else {
      void revalidator.revalidate();
      navigate(projectPath(slug, data?.session));
    }
    onClose();
  }

  const start: KindRow[] = [
    ...(workspace ? [{ id: "tab" as const, label: `Here in ${workspaceName(workspace)}`, hint: "Runs in this workspace, in a new tab", icon: AppWindow }] : []),
    { id: "workspace", label: "In a new folder", hint: "Pick a folder for a new workspace", icon: FolderPlus },
    { id: "chat", label: "Quick question", hint: "No folder, nothing to clean up", icon: Sparkles },
  ];
  const organize: KindRow[] = [
    { id: "project", label: "Project", hint: "Agents working toward one goal", icon: Folder },
    ...(current && projects.some(canStart) ? [{ id: "thread" as const, label: "Thread", hint: `One task in ${current.name}`, icon: MessageCircle }] : []),
  ];
  const agentPane = { data, readOnly, message: preset.message, browsing, onBrowsing: setBrowsing, onDone: onClose };

  return (
    <BottomSheet
      open
      onClose={onClose}
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
          <KindGroup title="Start an agent" rows={start} current={shown} onChoose={choose} />
          <KindGroup title="Organize" rows={organize} current={shown} onChoose={choose} />
          <p className="mt-auto hidden p-2.5 text-caption text-muted-foreground lg:block">
            Nenu only asks Herdr for this. Projects, threads and memory live in Herdr Organizations.
          </p>
        </nav>

        <section ref={body} aria-label={title} className={cn("flex min-w-0 flex-1 flex-col px-4 pt-3 lg:overflow-y-auto lg:px-5 lg:pt-4 lg:pb-4", !shown && "max-lg:hidden")}>
          {shown === "thread" && current && (
            <ThreadPane projects={projects} current={current} onProject={setProject} role={nodeRole} onRole={setRole} readOnly={readOnly}
              session={data?.session} onStarted={() => threadStarted(current.slug)} />
          )}
          {shown === "tab" && workspace && (
            <TabPane workspaces={workspaces} workspaceId={workspace.workspaceId} onWorkspace={pickWorkspace} {...agentPane} />
          )}
          {shown === "workspace" && <AgentPane target={{ kind: "workspace" }} {...agentPane} />}
          {shown === "project" && <ProjectPane data={data} readOnly={readOnly} browsing={browsing} onBrowsing={setBrowsing} onDone={onClose} />}
          {shown === "chat" && <QuickChatPane data={data} readOnly={readOnly} message={preset.message} onDone={onClose} />}
        </section>
      </div>
    </BottomSheet>
  );
}

function KindGroup({ title, rows, current, onChoose }: {
  title: string;
  rows: KindRow[];
  current: NewKind | null;
  onChoose: (kind: NewKind) => void;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col">
      <h3 id={id} className="px-2 pb-1 text-footnote font-medium text-muted-foreground lg:px-2.5 lg:text-caption">{title}</h3>
      {rows.map((k) => (
        <button
          key={k.id}
          type="button"
          aria-current={current === k.id ? "true" : undefined}
          onClick={() => onChoose(k.id)}
          className="flex min-h-14 w-full items-center gap-3 rounded-lg px-2 text-left transition-colors duration-150 hover:bg-accent/60 active:bg-accent aria-[current=true]:bg-[var(--workbench-row-selected)] lg:min-h-0 lg:items-start lg:gap-2.5 lg:p-2.5"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted lg:size-auto lg:bg-transparent lg:pt-0.5">
            <k.icon className="size-5 lg:size-4" aria-hidden />
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

function ThreadPane({ projects, current, onProject, role, onRole, readOnly, session, onStarted }: {
  projects: ProjectView[];
  current: ProjectView;
  onProject: (slug: string) => void;
  role: NodeRole;
  onRole: (role: NodeRole) => void;
  readOnly: boolean;
  session?: string;
  onStarted: () => void;
}) {
  const roles = startableRoles(current);
  return (
    <div className="flex flex-col gap-3">
      <Field label="Project">
        <SelectField value={current.slug} onChange={(e) => onProject(e.currentTarget.value)}>
          {projects.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
        </SelectField>
      </Field>
      {roles.length === 0 && <p className="text-subhead text-muted-foreground">{current.name} is paused, so it starts no threads.</p>}
      {roles.length > 0 && <NodeStartForm key={current.slug} project={current} session={session} readOnly={readOnly}
        role={role} onRole={onRole} onStarted={onStarted} />}
    </div>
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
  return (
    <NewAgentForm defaultCwd={defaultCwdFor(target, data)} defaultMessage={message} liveDirs={liveDirsOf(data)} readOnly={readOnly}
      browsing={browsing} onBrowsing={onBrowsing} onSubmit={(values) => spawnInto(target, values)} />
  );
}

function TabPane({ workspaces, workspaceId, onWorkspace, ...pane }: AgentPaneProps & {
  workspaces: WorkspaceView[];
  workspaceId: string;
  onWorkspace: (id: string) => void;
}) {
  return (
    <div className="flex flex-1 flex-col gap-3">
      {!pane.browsing && (
        <Field label="Workspace">
          <SelectField value={workspaceId} onChange={(e) => onWorkspace(e.currentTarget.value)}>
            {workspaces.map((w) => <option key={w.workspaceId} value={w.workspaceId}>{workspaceName(w)}</option>)}
          </SelectField>
        </Field>
      )}
      <AgentPane key={workspaceId} target={{ kind: "tab", workspaceId }} {...pane} />
    </div>
  );
}

/** The bridge host's home, once known; "" until then or when it can't be listed. */
function useHome(): string {
  const [home, setHome] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    fetchHomeDirs("~", false, abort.signal).then((d) => setHome(d.home), () => undefined);
    return () => abort.abort();
  }, []);
  return home;
}

function ProjectPane({ data, readOnly, browsing, onBrowsing, onDone }: {
  data: HomeData | undefined;
  readOnly: boolean;
  browsing: boolean;
  onBrowsing: (browsing: boolean) => void;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [repo, setRepo] = useState("");
  const [home, setHome] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const onScreen = useOnScreen();
  const fetchedHome = useHome();
  const knownHome = home || fetchedHome;

  async function submit() {
    if (busy || readOnly || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createOrgProject({ name: name.trim(), goal: goal.trim() || undefined, repo: repo || undefined }, data?.session);
      void revalidator.revalidate();
      if (!onScreen.current) return;
      navigate(projectPath(created.project.slug, data?.session));
      onDone();
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  }

  if (browsing) {
    return (
      <Suspense fallback={<p className="px-2 py-3 text-subhead text-muted-foreground">Loading…</p>}>
        <DirPicker home={knownHome} shortcuts={suggestDirs(liveDirsOf(data))} onHome={setHome}
          onPick={(path) => { setRepo(path); onBrowsing(false); }} />
      </Suspense>
    );
  }
  const shown = repo ? tildePath(repo, knownHome) : "";
  return (
    <form className="flex flex-1 flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <Field label="Name">
        <input className={inputField} value={name} required maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Wholesale dashboard" data-autofocus />
      </Field>
      <Field label="Goal">
        {/* Organizations keeps the goal on one line, so a line break becomes a space. */}
        <textarea className={textField} rows={2} maxLength={500} value={goal}
          onChange={(e) => setGoal(e.target.value.replace(/[\r\n]+/g, " "))} placeholder="What should be true when this project is done?" />
      </Field>
      <div className="flex flex-col gap-1.5">
        <span className="text-footnote font-medium text-muted-foreground">Repository</span>
        {repo ? (
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <FolderButton label="Repository" shown={shown} parent={shown.slice(0, -baseName(shown).length - 1) || "/"} onClick={() => onBrowsing(true)} />
            </div>
            <Button type="button" variant="ghost" size="icon" className="size-11" aria-label="Remove repository" onClick={() => setRepo("")}>
              <X className="size-4" />
            </Button>
          </div>
        ) : (
          <Button type="button" variant="outline" className="h-11 justify-start gap-2" onClick={() => onBrowsing(true)}>
            <FolderGit2 className="size-4" aria-hidden />Add folder
          </Button>
        )}
        <span className="text-footnote text-muted-foreground">Threads get their own worktree and branch in it. Agents, models and how many threads run at once are set in the project's PROJECT.md.</span>
      </div>
      {readOnly && <p className="text-subhead text-muted-foreground">Read-only: this device is not authorised to create.</p>}
      {error && <p role="alert" className="text-subhead text-destructive">{error}</p>}
      <div className="mt-auto flex flex-col gap-3 border-t border-border pt-3 lg:-mx-5 lg:flex-row lg:items-start lg:px-5">
        {/* What the bridge runs, for whoever wants it in a terminal; folded away, and only on a desk. */}
        <details className="group min-w-0 flex-1 max-lg:hidden">
          <summary className="flex h-9 w-fit cursor-pointer list-none items-center gap-1 rounded-md text-footnote text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3.5 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" aria-hidden />
            Command
          </summary>
          <code aria-label="Command" className="block pb-1 font-mono text-code text-muted-foreground select-all [overflow-wrap:anywhere]">
            {projectCommand(name, goal, repo)}
          </code>
        </details>
        <Button type="submit" className="h-11 lg:h-9" disabled={busy || readOnly || !name.trim()} aria-busy={busy || undefined}>{busy ? "Creating…" : "Create project"}</Button>
      </div>
    </form>
  );
}

function QuickChatPane({ data, readOnly, message: preset = "", onDone }: { data: HomeData | undefined; readOnly: boolean; message?: string; onDone: () => void }) {
  const [agent, setAgent] = useState<Exclude<SpawnAgent, "shell">>(() => {
    const last = loadAgent();
    return last === "shell" ? "claude" : last;
  });
  const [message, setMessage] = useState(preset);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const spawnInto = useSpawnInto(onDone);
  const scratch = data?.workspaces.find((w) => w.label.toLowerCase() === SCRATCH);

  async function submit() {
    if (busy || readOnly) return;
    setBusy(true);
    setError(null);
    // The scratch workspace is made once, and every later quick chat is a tab in it. No cwd: the
    // bridge creates a workspace on the home folder and a tab inherits its workspace's folder, and
    // spawn() would otherwise record ~ as the last folder picked.
    const target: SpawnTarget = scratch ? { kind: "tab", workspaceId: scratch.workspaceId } : { kind: "workspace" };
    const failure = await spawnInto(target, { agent, cwd: "", name: scratch ? "" : SCRATCH, message, permission: loadPermission(agent) });
    if (failure !== null) {
      setError(failure);
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <Segmented label="Agent" options={SPAWN_AGENTS.filter((a) => a.id !== "shell")} value={agent} onChange={(id) => setAgent(id as typeof agent)} />
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
