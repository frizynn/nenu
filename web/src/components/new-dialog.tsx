import { lazy, Suspense, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AppWindow, ChevronRight, Folder, FolderGit2, FolderPlus, ChatCircle, Plus, Sparkle, X, type IconComponent } from "@/components/ui/icon";
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
import { NodeDot } from "@/components/node-row";
import { NodeStartForm, errorMessage, startableRoles } from "@/components/node-start";
import { ProjectGlyph } from "@/components/project-glyph";
import { Button } from "@/components/ui/button";
import { inputField, textField } from "@/components/ui/field";
import { SelectField } from "@/components/ui/select-field";
import { BottomSheet } from "@/components/ui/sheet";
import { useMediaQuery } from "@/hooks/use-media-query";
import { createOrgProject, fetchHomeDirs } from "@/lib/api";
import { baseName, tildePath } from "@/lib/dir-picker";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { nodePath, panePath, projectPath } from "@/lib/nav";
import { STATE_LABEL, coordinatorState, openCoordinators, orgTree } from "@/lib/org-tree";
import { projectForPane, projectSummary, runningCoordinator } from "@/lib/projects";
import { useHoldReload } from "@/lib/reload-guard";
import { workspaceName } from "@/lib/spaces";
import { SPAWN_AGENTS, agentLabel, loadAgent, loadPermission, suggestDirs, type SpawnAgent, type SpawnTarget } from "@/lib/spawn";
import { isReadOnly, type NodeRole, type ProjectView, type WorkspaceView } from "@/lib/types";
import { cn } from "@/lib/utils";

const DirPicker = lazy(() => import("@/components/dir-picker").then((m) => ({ default: m.DirPicker })));

/** `coordinators` is a project's step: its coordinators, and what can start in it. */
export type NewKind = "coordinators" | "thread" | "tab" | "workspace" | "project" | "chat";

/** Where the New flow opens: on a kind and the place it starts in. Without a kind a phone opens on the list. */
export interface NewPreset {
  kind?: NewKind;
  workspaceId?: string;
  project?: string;
  role?: NodeRole;
  /** The coordinator a thread or coordinator starts under; the project's top level when omitted. */
  parent?: string;
  /** A first message already written, as Home's composer hands it over. */
  message?: string;
  /** Called instead of opening `project` once a thread starts in it: the page that asked refreshes itself. */
  onStarted?: () => void;
}

/** How long a new coordinator's chat is waited for before its page opens instead. */
const OPEN_WAIT_MS = 20_000;

/** The workspace a quick chat opens in, created on the first one. */
export const SCRATCH = "scratch";
const DESKTOP = "(min-width: 1024px)";
const matches = (query: string) => typeof window.matchMedia === "function" && window.matchMedia(query).matches;

function titleOf(kind: NewKind, role: NodeRole, project: ProjectView | undefined): string {
  switch (kind) {
    case "coordinators": return project?.name ?? "Project";
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

type KindRow = { key: string; label: string; hint: string; icon: IconComponent | ReactNode; current: boolean; onChoose: () => void };

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
  const [project, setProject] = useState(() => preset.project ?? context.project);
  const [role, setRole] = useState<NodeRole>(preset.role ?? "worker");
  const [kind, setKind] = useState<NewKind | null>(() => {
    if (preset.kind) return preset.kind;
    if (!matches(DESKTOP)) return null;
    return context.project ? "coordinators" : context.workspaceId ? "tab" : "workspace";
  });
  // The step Back returns to when it is not the list: a project's, for the form it opened.
  const [from, setFrom] = useState<NewKind | null>(null);
  const [browsing, setBrowsing] = useState(false);
  // A coordinator started here, whose chat opens once it runs.
  const [opening, setOpening] = useState<{ slug: string; id: string; title: string } | null>(null);
  const desk = useMediaQuery(DESKTOP);
  const heading = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLElement>(null);
  useHoldReload("new-dialog", true);

  const readOnly = isReadOnly(data?.device);
  const workspace = workspaces.find((w) => w.workspaceId === workspaceId);
  const chosen = projects.find((p) => p.slug === project);
  const current = chosen ?? projects.find(canStart);
  // The role the form starts, which a project without coordinators turns into a thread.
  const nodeRole = current && startableRoles(current).includes(role) ? role : "worker";
  // A tab opens in a workspace and a thread or a project's step in a project; without one, that kind is not offered.
  const shown = kind === "tab" && !workspace ? null : kind === "thread" && !current ? null : kind === "coordinators" && !chosen ? null : kind;
  const title = browsing ? "Choose a folder" : shown ? titleOf(shown, nodeRole, chosen) : "New";
  const back = browsing ? () => setBrowsing(false) : opening ? undefined : from ? () => choose(from) : shown && !desk ? () => choose(null) : undefined;
  const step = browsing ? "folder" : opening ? "opening" : shown ?? "list";
  const openingPane = opening ? projects.find((p) => p.slug === opening.slug)?.threads.find((t) => t.id === opening.id)?.paneId : undefined;

  // A coordinator's chat opens once Organizations binds its pane and Herdr lists it; a start that
  // takes longer opens its page, which offers the chat as soon as it runs.
  useEffect(() => {
    if (!opening) return;
    if (openingPane) {
      navigate(panePath(openingPane, data?.session));
      onClose();
      return;
    }
    const poll = setInterval(() => void revalidator.revalidate(), 2_000);
    const giveUp = setTimeout(() => {
      navigate(nodePath(opening.slug, opening.id, data?.session));
      onClose();
    }, OPEN_WAIT_MS);
    return () => { clearInterval(poll); clearTimeout(giveUp); };
    // Each poll hands back a new revalidator, which would restart the wait it is part of.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opening, openingPane]);

  // Each step takes focus as it opens, since the control that opened it is hidden or gone by then. A
  // desk lands in the step's field to type; a phone on its title, so no keyboard pops up unasked.
  useEffect(() => {
    const field = matches("(pointer: fine)") ? body.current?.querySelector<HTMLElement>("[data-autofocus]") : null;
    (field ?? heading.current)?.focus({ preventScroll: true });
  }, [step]);

  function choose(next: NewKind | null, back: NewKind | null = null) {
    setBrowsing(false);
    setKind(next);
    setFrom(back);
    // Picking something else on a desk's list stops waiting for a coordinator's chat.
    setOpening(null);
  }
  function openProjectStep(slug: string) {
    setProject(slug);
    choose("coordinators");
  }
  function pickWorkspace(id: string) {
    setWorkspaceId(id);
    const bound = projects.find((p) => p.workspaceIds?.includes(id));
    if (bound && canStart(bound)) setProject(bound.slug);
  }
  function threadStarted(slug: string, id: string, title: string) {
    void revalidator.revalidate();
    // The page that asked refreshes itself; a coordinator started here opens its chat; a thread opens its project.
    if (nodeRole === "coordinator" && !(preset.onStarted && slug === preset.project)) {
      setOpening({ slug, id, title });
      return;
    }
    if (preset.onStarted && slug === preset.project) preset.onStarted();
    else navigate(projectPath(slug, data?.session));
    onClose();
  }

  const row = (id: NewKind, label: string, hint: string, icon: IconComponent): KindRow =>
    ({ key: id, label, hint, icon, current: shown === id, onChoose: () => choose(id) });
  const start: KindRow[] = [
    ...(workspace ? [row("tab", `Here in ${workspaceName(workspace)}`, "Runs in this workspace, in a new tab", AppWindow)] : []),
    row("workspace", "In a new folder", "Pick a folder for a new workspace", FolderPlus),
    row("chat", "Quick question", "No folder, nothing to clean up", Sparkle),
  ];
  // A project is a step of its own: its coordinators, and a new one or a thread in it.
  const organize: KindRow[] = [
    ...projects.map((p) => ({
      key: `project:${p.slug}`, label: p.name, hint: projectHint(p), icon: <ProjectGlyph slug={p.slug} pick={p} size={18} />,
      current: (shown === "coordinators" || shown === "thread") && current?.slug === p.slug, onChoose: () => openProjectStep(p.slug),
    })),
    row("project", "New project", "Agents working toward one goal", Folder),
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
          <KindGroup title="Start an agent" rows={start} />
          <KindGroup title="Projects" rows={organize} />
          <p className="mt-auto hidden p-2.5 text-caption text-muted-foreground lg:block">
            Nenu only asks Herdr for this. Projects, threads and memory live in Herdr Organizations.
          </p>
        </nav>

        <section ref={body} aria-label={title} className={cn("flex min-w-0 flex-1 flex-col px-4 pt-3 lg:overflow-y-auto lg:px-5 lg:pt-4 lg:pb-4", !shown && "max-lg:hidden")}>
          {opening && <OpeningPane title={opening.title} onOpenPage={() => { navigate(nodePath(opening.slug, opening.id, data?.session)); onClose(); }} />}
          {!opening && shown === "coordinators" && chosen && (
            <CoordinatorsPane project={chosen} session={data?.session} readOnly={readOnly}
              onOpen={(path) => { navigate(path); onClose(); }}
              onNew={(next) => { setRole(next); choose("thread", "coordinators"); }} />
          )}
          {!opening && shown === "thread" && current && (
            <ThreadPane projects={projects} current={current} onProject={setProject} role={nodeRole} onRole={setRole} readOnly={readOnly}
              session={data?.session} parent={preset.parent} chosen={from === "coordinators"} onStarted={(id, title) => threadStarted(current.slug, id, title)} />
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
          className="flex min-h-14 w-full items-center gap-3 rounded-lg px-2 text-left transition-colors duration-120 hover:bg-accent/60 active:bg-accent aria-[current=true]:bg-[var(--workbench-row-selected)] lg:min-h-0 lg:items-start lg:gap-2.5 lg:p-2.5"
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

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A project's line in the list: how many coordinators it has, then what its agents are doing. */
function projectHint(project: ProjectView): string {
  const count = openCoordinators(orgTree(project.threads)).length + (runningCoordinator(project) ? 1 : 0);
  return [count > 0 && plural(count, "coordinator"), projectSummary(project)].filter(Boolean).join(" · ");
}

/**
 * A project's step: a new coordinator or thread and the project's page first, so they stay in view
 * over a long list; then its coordinators, the project's own first while it runs, each opening its
 * chat (its page when it runs in no pane).
 */
function CoordinatorsPane({ project, session, readOnly, onOpen, onNew }: {
  project: ProjectView;
  session?: string;
  readOnly: boolean;
  onOpen: (path: string) => void;
  onNew: (role: NodeRole) => void;
}) {
  const root = runningCoordinator(project);
  const coordinators = openCoordinators(orgTree(project.threads));
  const roles = readOnly ? [] : startableRoles(project);
  const rows: ChoiceRow[] = [
    ...(root ? [{
      key: "root", title: "Project coordinator", mark: <NodeDot state={coordinatorState(root.liveStatus) ?? "idle"} />,
      detail: [STATE_LABEL[coordinatorState(root.liveStatus) ?? "idle"], root.agent].join(" · "), onChoose: () => onOpen(panePath(root.paneId, session)),
    }] : []),
    ...coordinators.map(({ node, depth }) => {
      const parent = depth > 0 ? project.threads.find((t) => t.id === node.thread.parentId) : undefined;
      return {
        key: node.thread.id, title: node.thread.title, mark: <NodeDot state={node.state} />,
        detail: [STATE_LABEL[node.state], node.thread.agent, parent && `under ${parent.title}`].filter(Boolean).join(" · "),
        onChoose: () => onOpen(node.thread.paneId ? panePath(node.thread.paneId, session) : nodePath(project.slug, node.thread.id, session)),
      };
    }),
  ];
  const actions: ChoiceRow[] = [
    ...(roles.includes("coordinator") ? [{ key: "new-coordinator", title: "New coordinator", detail: "Its own chat, with threads of its own", mark: <Plus aria-hidden className="size-4" />, onChoose: () => onNew("coordinator") }] : []),
    ...(roles.includes("worker") ? [{ key: "new-thread", title: "New thread", detail: `One task in ${project.name}`, mark: <ChatCircle aria-hidden className="size-4" />, onChoose: () => onNew("worker") }] : []),
    { key: "page", title: "Open project", detail: "Every coordinator and thread, and History", mark: <Folder aria-hidden className="size-4" />, onChoose: () => onOpen(projectPath(project.slug, session)) },
  ];
  return (
    <div className="flex flex-col gap-4 pb-3">
      <ChoiceList title="Start or open" rows={actions} />
      <ChoiceList title="Coordinators" rows={rows} empty={project.status === "paused" ? `${project.name} is paused.` : "No coordinator runs here yet."} />
    </div>
  );
}

type ChoiceRow = { key: string; title: string; detail: string; mark: ReactNode; onChoose: () => void };

function ChoiceList({ title, rows, empty }: { title: string; rows: ChoiceRow[]; empty?: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col">
      <h3 id={id} className="pb-1 text-footnote font-medium text-muted-foreground lg:text-caption">{title}</h3>
      {rows.length === 0 && empty && <p className="py-2 text-subhead text-muted-foreground">{empty}</p>}
      {rows.map((r) => (
        <button key={r.key} type="button" onClick={r.onChoose}
          className="-mx-2 flex min-h-14 items-center gap-3 rounded-lg px-2 text-left transition-colors duration-120 hover:bg-accent/60 active:bg-accent lg:min-h-12">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">{r.mark}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-body font-medium lg:text-subhead">{r.title}</span>
            <span className="block truncate text-footnote text-muted-foreground">{r.detail}</span>
          </span>
          <ChevronRight className="size-4 shrink-0 text-subtle-foreground" aria-hidden />
        </button>
      ))}
    </section>
  );
}

/** A coordinator just started: its chat opens as soon as it runs, and its page is one tap away meanwhile. */
function OpeningPane({ title, onOpenPage }: { title: string; onOpenPage: () => void }) {
  return (
    <div role="status" className="flex flex-col gap-3 py-2">
      <p className="text-body"><span className="font-medium">{title}</span> is starting.</p>
      <p className="text-subhead text-muted-foreground">Its chat opens here as soon as its agent runs.</p>
      <Button type="button" variant="outline" className="h-11 self-start" onClick={onOpenPage}>Open its page</Button>
    </div>
  );
}

function ThreadPane({ projects, current, onProject, role, onRole, readOnly, session, parent, chosen, onStarted }: {
  projects: ProjectView[];
  current: ProjectView;
  onProject: (slug: string) => void;
  role: NodeRole;
  onRole: (role: NodeRole) => void;
  readOnly: boolean;
  session?: string;
  parent?: string;
  /** The project's step picked the project and the role, so the form asks for neither again. */
  chosen: boolean;
  onStarted: (id: string, title: string) => void;
}) {
  const roles = startableRoles(current);
  return (
    <div className="flex flex-col gap-3">
      {!chosen && <Field label="Project">
        <SelectField value={current.slug} onChange={(e) => onProject(e.currentTarget.value)}>
          {projects.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
        </SelectField>
      </Field>}
      {roles.length === 0 && <p className="text-subhead text-muted-foreground">{current.name} is paused, so it starts no threads.</p>}
      {roles.length > 0 && <NodeStartForm key={current.slug} project={current} session={session} readOnly={readOnly}
        role={role} onRole={chosen ? undefined : onRole} parent={parent} onStarted={onStarted} />}
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
  // A new folder can be on any machine that is connected; a tab is in its workspace's.
  const machines = target.kind === "workspace" ? (data?.machines ?? []).filter((m) => m.state === "connected") : [];
  const [session, setSession] = useState(data?.session);
  const picked = machines.find((m) => m.session === session);
  const form = (
    <NewAgentForm key={session ?? ""} machine={machines.length > 1 ? { session } : undefined}
      defaultCwd={picked && session !== data?.session ? "" : defaultCwdFor(target, data)} defaultMessage={message}
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
            <ChevronRight className="size-3.5 transition-transform duration-120 group-open:rotate-90 motion-reduce:transition-none" aria-hidden />
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
