import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { AppWindow, ChevronDown, ChevronLeft, ChevronRight, Folder, FolderGit2, LayoutGrid, MessageCircle, Sparkles, X } from "lucide-react";
import { useNavigate, useParams, useRevalidator, useRouteLoaderData } from "react-router";

import {
  BROWSING_SHEET,
  FolderButton,
  NewAgentForm,
  Segmented,
  defaultCwdFor,
  inputField,
  liveDirsOf,
  useSpawnInto,
  type NewKind,
  type NewRequest,
} from "@/components/new-agent-sheet";
import { NoTemplates, ThreadStartForm, errorMessage, useTemplates } from "@/components/new-thread-menu";
import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/ui/sheet";
import { createOrgProject, fetchHomeDirs } from "@/lib/api";
import { baseName, tildePath } from "@/lib/dir-picker";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { projectPath } from "@/lib/nav";
import { projectForPane } from "@/lib/projects";
import { useHoldReload } from "@/lib/reload-guard";
import { SPAWN_AGENTS, loadAgent, loadPermission, suggestDirs, type SpawnAgent, type SpawnTarget } from "@/lib/spawn";
import { isReadOnly, type ProjectView, type WorkspaceView } from "@/lib/types";
import { cn } from "@/lib/utils";

const DirPicker = lazy(() => import("@/components/dir-picker").then((m) => ({ default: m.DirPicker })));

const KINDS: ReadonlyArray<{ id: NewKind; label: string; title: string; hint: string; icon: typeof Folder }> = [
  { id: "thread", label: "Thread", title: "New thread", hint: "A worker in its own branch, with the project brief", icon: MessageCircle },
  { id: "tab", label: "Tab", title: "New tab", hint: "An agent in this workspace, no coordinator", icon: AppWindow },
  { id: "workspace", label: "Workspace", title: "New workspace", hint: "A Herdr workspace on a folder you pick", icon: LayoutGrid },
  { id: "project", label: "Project", title: "New project", hint: "Coordinator, threads and shared memory", icon: Folder },
  { id: "chat", label: "Quick chat", title: "Quick chat", hint: "One question, no repo, nothing to clean up", icon: Sparkles },
];

/** The workspace a quick chat opens in, created on the first one. */
export const SCRATCH = "scratch";
const DESKTOP = "(min-width: 1024px)";

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

/** One place to create a thread, tab, workspace, project or quick chat: a sheet on a phone, a two-pane dialog on a desk. */
export default function NewDialog({ request, onClose }: { request: NewRequest; onClose: () => void }) {
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData | undefined;
  const params = useParams();
  const [context] = useState(() => newContext(data, params));
  const [workspaceId, setWorkspaceId] = useState(context.workspaceId);
  const [project, setProject] = useState(context.project ?? data?.projects?.[0]?.slug);
  const [kind, setKind] = useState<NewKind | null>(() => {
    if (request.kind) return request.kind;
    const desktop = typeof window.matchMedia === "function" && window.matchMedia(DESKTOP).matches;
    return desktop ? (context.project ? "thread" : "tab") : null;
  });
  const [browsing, setBrowsing] = useState(false);
  useHoldReload("new-dialog", true);

  const readOnly = isReadOnly(data?.device);
  const workspaces = data?.workspaces ?? [];
  const projects = data?.projects ?? [];
  const chosen = KINDS.find((k) => k.id === kind);
  const choose = (next: NewKind) => {
    setBrowsing(false);
    setKind(next);
  };
  const pickWorkspace = (id: string) => {
    setWorkspaceId(id);
    const bound = projects.find((p) => p.workspaceIds?.includes(id));
    if (bound) setProject(bound.slug);
  };

  return (
    <BottomSheet
      open
      onClose={onClose}
      title={browsing ? "Choose a folder" : "New"}
      className={cn(
        "sm:mx-auto sm:my-auto sm:max-w-lg sm:rounded-2xl sm:border sm:pb-4",
        "outline-none lg:max-w-[760px] lg:pb-0 lg:[&>div:first-child]:hidden",
        browsing && BROWSING_SHEET,
      )}
    >
      <div className="new-dialog flex flex-1 flex-col lg:-mx-4 lg:-my-3 lg:min-h-[30rem] lg:flex-row">
        <nav aria-label="Create" className={cn("flex flex-col gap-1 lg:w-[220px] lg:flex-none lg:border-r lg:border-border lg:p-2.5", kind && "max-lg:hidden")}>
          <span className="hidden px-2.5 pt-1 pb-2 text-xs text-muted-foreground lg:block">Create</span>
          {workspaces.length > 0 && (
            <PlaceSelect workspaces={workspaces} projects={projects} value={workspaceId} onChange={pickWorkspace} />
          )}
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              aria-current={kind === k.id ? "true" : undefined}
              onClick={() => choose(k.id)}
              className={cn(
                "flex min-h-16 w-full items-center gap-3.5 rounded-xl px-2 text-left hover:bg-accent/60 active:bg-accent lg:min-h-0 lg:items-start lg:gap-2.5 lg:rounded-lg lg:p-2.5",
                kind === k.id && "bg-accent",
              )}
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted lg:size-auto lg:bg-transparent lg:pt-px">
                <k.icon className="size-5 lg:size-4" aria-hidden />
              </span>
              <span className="min-w-0 flex-1 leading-snug">
                <span className="block text-base font-medium lg:text-[13px]">{k.label}</span>
                <span className="block text-[13px] text-muted-foreground lg:text-xs">{k.hint}</span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground/60 lg:hidden" aria-hidden />
            </button>
          ))}
          <p className="mt-auto hidden p-2.5 text-xs leading-relaxed text-muted-foreground lg:block">
            Nenu only asks Herdr for this. Projects, threads and memory live in Herdr Organizations.
          </p>
        </nav>

        <section aria-label={chosen?.title} className={cn("flex min-w-0 flex-1 flex-col lg:px-5 lg:py-4", !kind && "max-lg:hidden")}>
          {chosen && !browsing && (
            <div className="mb-3 flex items-center gap-1">
              <Button type="button" variant="ghost" size="icon" className="-ml-2 size-10 lg:hidden" aria-label="All kinds" onClick={() => setKind(null)}>
                <ChevronLeft className="size-5" />
              </Button>
              <h2 className="flex-1 text-base font-semibold lg:text-[17px]">{chosen.title}</h2>
              <Button type="button" variant="ghost" size="icon" className="hidden size-9 lg:inline-flex" aria-label="Close" onClick={onClose}>
                <X className="size-4" />
              </Button>
            </div>
          )}
          {kind === "thread" && (
            <ThreadPane projects={projects} project={project} onProject={setProject} readOnly={readOnly} session={data?.session}
              onDone={onClose} onNewProject={() => choose("project")} />
          )}
          {kind === "tab" && (
            <TabPane workspaces={workspaces} workspaceId={workspaceId} onWorkspace={pickWorkspace} data={data} readOnly={readOnly}
              onBrowsing={setBrowsing} onDone={onClose} onNewWorkspace={() => choose("workspace")} />
          )}
          {kind === "workspace" && <AgentPane target={{ kind: "workspace" }} data={data} readOnly={readOnly} onBrowsing={setBrowsing} onDone={onClose} />}
          {kind === "project" && <ProjectPane data={data} readOnly={readOnly} onBrowsing={setBrowsing} onDone={onClose} />}
          {kind === "chat" && <QuickChatPane data={data} readOnly={readOnly} onDone={onClose} />}
        </section>
      </div>
    </BottomSheet>
  );
}

/** "In AWAM › rediseño mobile": the workspace a tab opens in, and the project a thread starts in. */
function PlaceSelect({ workspaces, projects, value, onChange }: {
  workspaces: WorkspaceView[];
  projects: ProjectView[];
  value: string | undefined;
  onChange: (workspaceId: string) => void;
}) {
  const name = (w: WorkspaceView) => {
    const bound = projects.find((p) => p.workspaceIds?.includes(w.workspaceId));
    return bound ? `${bound.name} › ${w.label}` : w.label;
  };
  const current = workspaces.find((w) => w.workspaceId === value);
  return (
    <label className="relative mx-0.5 mb-1.5 flex h-11 items-center gap-2 rounded-xl bg-muted px-3 text-sm text-muted-foreground lg:hidden">
      <Folder className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">In <span className="font-medium text-foreground">{current ? name(current) : "—"}</span></span>
      <ChevronDown className="size-3.5 shrink-0" aria-hidden />
      <select aria-label="In" value={value} onChange={(e) => onChange(e.currentTarget.value)} className="absolute inset-0 cursor-pointer opacity-0">
        {workspaces.map((w) => <option key={w.workspaceId} value={w.workspaceId}>{name(w)}</option>)}
      </select>
    </label>
  );
}

const selectField = cn(inputField, "appearance-auto");

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-[13px] font-medium text-muted-foreground">
      {label}
      {children}
      {hint && <span className="text-xs font-normal">{hint}</span>}
    </label>
  );
}

function ThreadPane({ projects, project, onProject, readOnly, session, onDone, onNewProject }: {
  projects: ProjectView[];
  project: string | undefined;
  onProject: (slug: string) => void;
  readOnly: boolean;
  session?: string;
  onDone: () => void;
  onNewProject: () => void;
}) {
  const current = projects.find((p) => p.slug === project);
  const load = useTemplates(current?.slug ?? "", session, current !== undefined);
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  if (!current) {
    return (
      <div className="flex flex-col items-start gap-3 text-sm text-muted-foreground">
        <p>A thread runs inside a project, with its coordinator and brief. There is no project yet.</p>
        <Button type="button" variant="outline" className="h-11" onClick={onNewProject}>New project</Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col">
      <Field label="Project">
        <select className={selectField} value={current.slug} onChange={(e) => onProject(e.currentTarget.value)}>
          {projects.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
        </select>
      </Field>
      {load.kind === "loading" && <p className="py-3 text-sm text-muted-foreground">Loading templates…</p>}
      {load.kind === "error" && <p role="alert" className="py-3 text-sm text-destructive">{load.message}</p>}
      {load.kind === "ready" && load.templates.length === 0 && <NoTemplates />}
      {load.kind === "ready" && load.templates.length > 0 && (
        <ThreadStartForm key={current.slug} project={current} session={session} templates={load.templates} readOnly={readOnly}
          onStarted={() => {
            void revalidator.revalidate();
            navigate(projectPath(current.slug, session));
            onDone();
          }} />
      )}
    </div>
  );
}

function AgentPane({ target, data, readOnly, onBrowsing, onDone }: {
  target: SpawnTarget;
  data: HomeData | undefined;
  readOnly: boolean;
  onBrowsing: (browsing: boolean) => void;
  onDone: () => void;
}) {
  const spawnInto = useSpawnInto(onDone);
  return (
    <NewAgentForm defaultCwd={defaultCwdFor(target, data)} liveDirs={liveDirsOf(data)} readOnly={readOnly}
      onBrowsing={onBrowsing} onSubmit={(values) => spawnInto(target, values)} />
  );
}

function TabPane({ workspaces, workspaceId, onWorkspace, data, readOnly, onBrowsing, onDone, onNewWorkspace }: {
  workspaces: WorkspaceView[];
  workspaceId: string | undefined;
  onWorkspace: (id: string) => void;
  data: HomeData | undefined;
  readOnly: boolean;
  onBrowsing: (browsing: boolean) => void;
  onDone: () => void;
  onNewWorkspace: () => void;
}) {
  const [browsing, setBrowsing] = useState(false);
  if (!workspaceId) {
    return (
      <div className="flex flex-col items-start gap-3 text-sm text-muted-foreground">
        <p>A tab opens inside a workspace, and there is none yet.</p>
        <Button type="button" variant="outline" className="h-11" onClick={onNewWorkspace}>New workspace</Button>
      </div>
    );
  }
  return (
    <div className="flex flex-1 flex-col gap-3">
      {!browsing && (
        <Field label="Workspace">
          <select className={selectField} value={workspaceId} onChange={(e) => onWorkspace(e.currentTarget.value)}>
            {workspaces.map((w) => <option key={w.workspaceId} value={w.workspaceId}>{w.label}</option>)}
          </select>
        </Field>
      )}
      <AgentPane key={workspaceId} target={{ kind: "tab", workspaceId }} data={data} readOnly={readOnly} onDone={onDone}
        onBrowsing={(next) => { setBrowsing(next); onBrowsing(next); }} />
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

function ProjectPane({ data, readOnly, onBrowsing, onDone }: {
  data: HomeData | undefined;
  readOnly: boolean;
  onBrowsing: (browsing: boolean) => void;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [repo, setRepo] = useState("");
  const [home, setHome] = useState("");
  const [browsing, setBrowsingState] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const fetchedHome = useHome();
  const knownHome = home || fetchedHome;
  const setBrowsing = (next: boolean) => {
    setBrowsingState(next);
    onBrowsing(next);
  };

  async function submit() {
    if (busy || readOnly || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createOrgProject({ name: name.trim(), goal: goal.trim() || undefined, repo: repo || undefined }, data?.session);
      void revalidator.revalidate();
      navigate(projectPath(created.project.slug, data?.session));
      onDone();
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  }

  if (browsing) {
    return (
      <Suspense fallback={<p className="px-2 py-3 text-sm text-muted-foreground">Loading…</p>}>
        <DirPicker home={knownHome} shortcuts={suggestDirs(liveDirsOf(data))} onHome={setHome} onBack={() => setBrowsing(false)}
          onPick={(path) => { setRepo(path); setBrowsing(false); }} />
      </Suspense>
    );
  }
  const shown = repo ? tildePath(repo, knownHome) : "";
  return (
    <form className="flex flex-1 flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <Field label="Name">
        <input className={inputField} value={name} required maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Panel mayorista" />
      </Field>
      <Field label="Goal">
        {/* Organizations keeps the goal on one line, so a line break becomes a space. */}
        <textarea className={cn(inputField, "h-auto resize-none py-2")} rows={2} maxLength={500} value={goal}
          onChange={(e) => setGoal(e.target.value.replace(/[\r\n]+/g, " "))} placeholder="What should be true when this project is done?" />
      </Field>
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium text-muted-foreground">Repository</span>
        {repo ? (
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <FolderButton label="Repository" shown={shown} parent={shown.slice(0, -baseName(shown).length - 1) || "/"} onClick={() => setBrowsing(true)} />
            </div>
            <Button type="button" variant="ghost" size="icon" className="size-11" aria-label="Remove repository" onClick={() => setRepo("")}>
              <X className="size-4" />
            </Button>
          </div>
        ) : (
          <Button type="button" variant="outline" className="h-11 justify-start gap-2" onClick={() => setBrowsing(true)}>
            <FolderGit2 className="size-4" aria-hidden />Add folder
          </Button>
        )}
        <span className="text-xs text-muted-foreground">Threads get their own worktree and branch in it. Agents, models and how many threads run at once are set in the project's PROJECT.md.</span>
      </div>
      {readOnly && <p className="text-sm text-muted-foreground">Read-only: this device is not authorised to create.</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="mt-auto flex flex-col gap-3 border-t border-border pt-3 lg:-mx-5 lg:flex-row lg:items-center lg:px-5 lg:pb-3">
        <code aria-label="Command" className="min-w-0 flex-1 overflow-x-auto font-mono text-[11.5px] whitespace-nowrap text-muted-foreground [scrollbar-width:none]">
          {projectCommand(name, goal, repo)}
        </code>
        <Button type="submit" className="h-11 lg:h-9" disabled={busy || readOnly || !name.trim()}>{busy ? "Creating…" : "Create project"}</Button>
      </div>
    </form>
  );
}

function QuickChatPane({ data, readOnly, onDone }: { data: HomeData | undefined; readOnly: boolean; onDone: () => void }) {
  const [agent, setAgent] = useState<Exclude<SpawnAgent, "shell">>(() => {
    const last = loadAgent();
    return last === "shell" ? "claude" : last;
  });
  const [message, setMessage] = useState("");
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
        placeholder="Ask anything" className={cn(inputField, "h-auto resize-none py-2")} />
      <p className="text-xs text-muted-foreground">
        Opens in the <span className="font-medium text-foreground">{SCRATCH}</span> workspace on <code>~</code>
        {scratch ? "." : ", which is created the first time."}
      </p>
      {readOnly && <p className="text-sm text-muted-foreground">Read-only: this device is not authorised to create.</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="submit" className="h-11" disabled={busy || readOnly}>{busy ? "Starting…" : "Start chat"}</Button>
    </form>
  );
}
