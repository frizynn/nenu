import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { Bot, ChevronRight, Clock, FolderKanban, House, Inbox, LayoutGrid, Plus, Search, Settings, Terminal } from "lucide-react";

import { ChatGroups, NavRow } from "@/components/chat-groups";
import { SessionSwitcher } from "@/components/session-switcher";
import { StatusDot } from "@/components/status-badge";
import { WorkspaceTree } from "@/components/workspace-tree";
import { cn } from "@/lib/utils";
import { isAttention } from "@/lib/triage";
import { paneSubject, workspaceTree } from "@/lib/workspace-tree";
import { useSidebarPrefs, type SidebarView } from "@/hooks/use-sidebar-prefs";
import type { HomeData } from "@/lib/loaders";
import { homePath, panePath, projectPath, settingsPath } from "@/lib/nav";
import {
  byRecency, chatMatches, isOpenThread, looseChats, matches, paneTitle, projectForPane, projectGroups, projectMatches, type ProjectGroup,
} from "@/lib/projects";
import { paneDisplayName, STATUS_LABEL, type AgentStatus, type AgentView, type ProjectThreadView, type ProjectView, type WorkspaceView } from "@/lib/types";

/** What the sidebar lists: the whole tree, or only what is waiting on the operator. */
export type SidebarMode = "browse" | "needs-you";
export interface SidebarRequest {
  target: "search" | "needs-you";
  seq: number;
}

/**
 * The workbench navigation: New, Search, Needs you and Home, then projects (coordinators and their
 * threads) and the workspaces no project holds, and the host it all runs on.
 */
export function WorkbenchSidebar({ data, onNavigate, onNewChat, request, actions = true }: {
  data: HomeData;
  /** False under the phone's tab bar, which already offers New, Search, Needs you and Home. */
  actions?: boolean;
  onNavigate?: () => void;
  onNewChat?: () => void;
  /** Each new `seq` opens search or the Needs you list (⌘K, the rail, the tab bar). */
  request?: SidebarRequest;
}) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SidebarMode>("browse");
  const searchBox = useRef<HTMLInputElement>(null);
  const attention = needsYou(data);

  const target = request?.target;
  useEffect(() => {
    if (!target) return;
    if (target === "needs-you") {
      setMode("needs-you");
      return;
    }
    setMode("browse");
    setSearching(true);
    searchBox.current?.focus();
    searchBox.current?.select();
  }, [target, request?.seq]);

  function closeSearch() {
    setQuery("");
    setSearching(false);
  }

  return (
    <nav className="workbench-navigation" aria-label="Projects and chats">
      {(actions || searching) && <div className="nav-top">
        {actions && <button type="button" className="nav-row" onClick={onNewChat} disabled={!onNewChat} aria-keyshortcuts="Meta+N">
          <Plus aria-hidden size={16} /><span className="nav-row-text">New</span><kbd className="nav-kbd" aria-hidden>⌘N</kbd>
        </button>}
        {searching ? (
          <label className="nav-row nav-search">
            <Search aria-hidden size={16} />
            <input ref={searchBox} type="search" autoFocus value={query} placeholder="Search" aria-label="Search projects and chats"
              onChange={(event) => setQuery(event.target.value)}
              onBlur={() => { if (!query.trim()) closeSearch(); }}
              onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); closeSearch(); } }} />
          </label>
        ) : actions && (
          <button type="button" className="nav-row" onClick={() => { setMode("browse"); setSearching(true); }} aria-keyshortcuts="Meta+K">
            <Search aria-hidden size={16} /><span className="nav-row-text">Search</span><kbd className="nav-kbd" aria-hidden>⌘K</kbd>
          </button>
        )}
        {actions && <button type="button" className="nav-row" aria-pressed={mode === "needs-you"} aria-label={attention.length ? `Needs you, ${attention.length}` : "Needs you"} onClick={() => setMode(mode === "needs-you" ? "browse" : "needs-you")}>
          <Inbox aria-hidden size={16} /><span className="nav-row-text">Needs you</span>
          {attention.length > 0 && <span className="nav-badge" aria-hidden>{attention.length}</span>}
        </button>}
        {actions && <Link className="nav-row" to={homePath(data.session)} onClick={onNavigate}><House aria-hidden size={16} />Home</Link>}
      </div>}

      <div className="nav-scroll">
        {mode === "needs-you"
          ? <NeedsYouList data={data} panes={attention} onNavigate={onNavigate} />
          : <SidebarTree data={data} query={query} onNavigate={onNavigate} />}
      </div>

      <div className="nav-footer">
        <SessionSwitcher sessions={data.sessions ?? []} current={data.session} />
        <HostRow data={data} onNavigate={onNavigate} />
      </div>
    </nav>
  );
}

/** Agent panes waiting on the operator, the same set the Home headline and the rail's dot count. */
export function needsYou(data: Pick<HomeData, "agents">): AgentView[] {
  return data.agents.filter((pane) => isAttention(pane.status));
}

function NeedsYouList({ data, panes, onNavigate }: { data: HomeData; panes: AgentView[]; onNavigate?: () => void }) {
  const { paneId } = useParams();
  if (panes.length === 0) return <p className="nav-empty">Nothing needs you right now.</p>;
  return (
    <section aria-label="Needs you">
      <h3 className="nav-label">Needs you</h3>
      {panes.map((pane) => {
        const owner = projectForPane(data.projects, pane.paneId);
        return <NavRow key={pane.paneId} to={panePath(pane.paneId, data.session)} status={pane.status} title={paneTitle(pane, owner)}
          note={owner?.project.name ?? pane.workspaceLabel} current={pane.paneId === paneId} onNavigate={onNavigate} />;
      })}
    </section>
  );
}

/** Projects first, then the workspaces no project holds a pane in. */
function SidebarTree({ data, query, onNavigate }: { data: HomeData; query: string; onNavigate?: () => void }) {
  const { paneId, projectSlug } = useParams();
  const { prefs, setExpanded, setWorkspaceOpen } = useSidebarPrefs();
  const searching = query.trim() !== "";
  const groups = projectGroups(data.projects, query);
  const loose = looseWorkspaces(data);
  const currentProject = projectSlug ?? projectForPane(data.projects, paneId)?.project.slug;
  useRevealProject(currentProject, setExpanded);
  const workspaces = <WorkspaceTree compact source={{ ...data, ...loose }} query={query} session={data.session} currentPaneId={paneId}
    expanded={prefs.workspaces} onExpand={setWorkspaceOpen} onNavigate={onNavigate} />;
  const hasWorkspaces = workspaceTree({ ...data, ...loose }, query, paneId).length > 0;

  return <>
    {groups.length > 0 && (
      <section aria-label="Projects" className="nav-group">
        <h3 className="nav-label">Projects</h3>
        {groups.map((group) => (
          <ProjectSection key={group.project.slug} group={group} data={data} open={searching || (prefs.expanded[group.project.slug] ?? true)}
            searching={searching} expanded={prefs.expanded} onExpand={setExpanded} onNavigate={onNavigate} withPanes />
        ))}
      </section>
    )}
    {hasWorkspaces && (
      <section aria-label="Workspaces" className="nav-group">
        <h3 className="nav-label">Workspaces</h3>
        {workspaces}
      </section>
    )}
    {groups.length === 0 && !hasWorkspaces && <Empty query={query} />}
  </>;
}

/**
 * Workspaces no project holds a live pane in; all of them when there are no projects. A project's
 * panes are listed under the project, so the workspace tree leaves them out, and a workspace left
 * with only those (a bridge that did not report `workspaceIds`) is not loose either.
 */
export function looseWorkspaces(data: Pick<HomeData, "workspaces" | "projects" | "agents" | "shellPanes">): { workspaces: WorkspaceView[]; agents: AgentView[]; shellPanes: AgentView[] } {
  const held = new Set((data.projects ?? []).flatMap((project) => project.workspaceIds ?? []));
  const free = (pane: AgentView) => !projectForPane(data.projects, pane.paneId);
  const agents = data.agents.filter(free);
  const shellPanes = data.shellPanes.filter(free);
  const panes = [...data.agents, ...data.shellPanes];
  const workspaces = data.workspaces.filter((workspace) => {
    if (held.has(workspace.workspaceId)) return false;
    const inside = panes.filter((pane) => pane.workspaceId === workspace.workspaceId);
    return inside.length === 0 || inside.some(free);
  });
  return { workspaces, agents, shellPanes };
}

/** Arriving in a project reveals it once; collapsing it again afterwards is the operator's call. */
function useRevealProject(currentProject: string | undefined, setExpanded: (slug: string, open: boolean) => void) {
  const revealed = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!currentProject || revealed.current === currentProject) return;
    revealed.current = currentProject;
    setExpanded(currentProject, true);
  }, [currentProject, setExpanded]);
}

/** The host Nenu reaches Herdr on, whether that link is up, and how much it holds. */
function HostRow({ data, onNavigate }: { data: HomeData; onNavigate?: () => void }) {
  const connected = data.bridge === "connected" && !data.error;
  const { hostname } = window.location;
  const host = /^[\d.]+$|:/.test(hostname) ? hostname : hostname.split(".")[0] || "local";
  const agents = data.agents.length;
  return (
    <div className="nav-host">
      <span className={cn("size-2 shrink-0 rounded-full", connected ? "bg-status-done" : "bg-status-blocked")} aria-hidden />
      <span className="nav-host-text">
        <span className="nav-host-name">herdr · {host}</span>
        <span className="nav-host-meta">
          {connected ? `${data.workspaces.length} ${data.workspaces.length === 1 ? "workspace" : "workspaces"} · ${agents} ${agents === 1 ? "agent" : "agents"}` : "Not connected"}
        </span>
      </span>
      <Link className="workbench-icon-button" to={settingsPath(data.session)} onClick={onNavigate} aria-label="Settings"><Settings aria-hidden size={16} /></Link>
    </div>
  );
}

/** The view switch and the chosen view; the sidebar, the drawer and Home share it and its stored choice. */
export function ChatBrowser({ data, query, onNavigate }: { data: HomeData; query: string; onNavigate?: () => void }) {
  const { paneId, projectSlug } = useParams();
  const { prefs, setView, setExpanded, setWorkspaceOpen } = useSidebarPrefs();
  const hasProjects = (data.projects ?? []).length > 0;
  const chosen = prefs.view ?? "workspaces";
  const view: SidebarView = chosen === "projects" && !hasProjects ? "workspaces" : chosen;
  const currentProject = projectSlug ?? projectForPane(data.projects, paneId)?.project.slug;
  useRevealProject(currentProject, setExpanded);

  return <>
    <ViewToggle value={view} options={hasProjects ? VIEWS : VIEWS.filter((option) => option.value !== "projects")} onChange={setView} />
    {view === "workspaces" ? (
      <WorkspaceTree source={data} query={query} session={data.session} currentPaneId={paneId}
        expanded={prefs.workspaces} onExpand={setWorkspaceOpen} onNavigate={onNavigate} empty={<Empty query={query} />} />
    ) : view === "projects"
      ? <ProjectsView data={data} query={query} expanded={prefs.expanded} onExpand={setExpanded} onNavigate={onNavigate} />
      : <RecentView data={data} query={query} currentProject={currentProject} onNavigate={onNavigate} />}
  </>;
}

const VIEWS: Array<{ value: SidebarView; label: string; Icon: typeof Clock }> = [
  { value: "workspaces", label: "Workspaces", Icon: LayoutGrid },
  { value: "projects", label: "Projects", Icon: FolderKanban },
  { value: "recent", label: "Recent", Icon: Clock },
];

/** A segmented switch; arrows move the choice, as in any radio group. */
function ViewToggle({ value, options, onChange }: { value: SidebarView; options: typeof VIEWS; onChange: (view: SidebarView) => void }) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = options[(options.findIndex((view) => view.value === value) + step + options.length) % options.length];
    onChange(next.value);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-view="${next.value}"]`)?.focus();
  }
  return (
    <div className="nav-views" role="radiogroup" aria-label="Group by" onKeyDown={onKeyDown}>
      {options.map(({ value: option, label, Icon }) => (
        <button key={option} type="button" role="radio" data-view={option} aria-checked={value === option} tabIndex={value === option ? 0 : -1}
          onClick={() => onChange(option)}>
          <Icon aria-hidden size={14} />{label}
        </button>
      ))}
    </div>
  );
}

interface ViewProps {
  data: HomeData;
  query: string;
  onNavigate?: () => void;
}

/** Each project with its coordinator and tasks; panes outside every project close the list. */
function ProjectsView({ data, query, expanded, onExpand, onNavigate }: ViewProps & TreeFolds) {
  const { paneId } = useParams();
  const groups = projectGroups(data.projects, query);
  const chats = byRecency(looseChats(data.agents, data.projects).filter((pane) => chatMatches(pane, query)));
  const searching = query.trim() !== "";
  return <>
    {groups.map((group) => (
      <ProjectSection key={group.project.slug} group={group} data={data} open={searching || (expanded[group.project.slug] ?? true)}
        searching={searching} expanded={expanded} onExpand={onExpand} onNavigate={onNavigate} />
    ))}
    {chats.length > 0 && (
      <section aria-label="Other chats">
        <h3 className="nav-label">Other chats</h3>
        {chats.map((pane) => (
          <NavRow key={pane.paneId} status={pane.status} title={paneDisplayName(pane)} to={panePath(pane.paneId, data.session)}
            current={pane.paneId === paneId} onNavigate={onNavigate} />
        ))}
      </section>
    )}
    {groups.length + chats.length === 0 && <Empty query={query} />}
  </>;
}

interface TreeFolds {
  /** Explicit folds, keyed by project slug or by `slug/threadId` for a coordinator thread. */
  expanded: Record<string, boolean>;
  onExpand: (key: string, open: boolean) => void;
}

/** A thread with the threads it coordinates, as Organizations nests them. */
export interface ThreadNode {
  thread: ProjectThreadView;
  children: ThreadNode[];
}

/** Nests threads under their parent; one whose parent is missing (resolved, filtered out) is a root. */
export function threadTree(threads: readonly ProjectThreadView[]): ThreadNode[] {
  const nodes = new Map(threads.map((thread) => [thread.id, { thread, children: [] as ThreadNode[] }]));
  const parentOf = (node: ThreadNode) => {
    // A corrupt record could loop its parents; such a thread is listed at the root instead.
    for (let seen = 0, id = node.thread.parentId; seen <= nodes.size; seen++) {
      const ancestor = nodes.get(id);
      if (!ancestor) return nodes.get(node.thread.parentId);
      if (ancestor === node) return undefined;
      id = ancestor.thread.parentId;
    }
    return undefined;
  };
  const roots: ThreadNode[] = [];
  for (const node of nodes.values()) (parentOf(node)?.children ?? roots).push(node);
  return roots;
}

/** What a thread's dot says: a pull request ready for review reads as its own state. */
type ThreadState = AgentStatus | "review";
function threadState(thread: ProjectThreadView): ThreadState {
  const live = thread.paneId ? thread.liveStatus ?? "unknown" : "unknown";
  return thread.group === "ready-for-review" && live !== "blocked" ? "review" : live;
}
const STATE_WORD: Partial<Record<ThreadState, string>> = { blocked: "needs you", review: "review" };

function StateDot({ state, className = "size-2" }: { state: ThreadState; className?: string }) {
  return state === "review"
    ? <span aria-hidden className={cn("inline-flex shrink-0 rounded-full bg-primary", className)} />
    : <StatusDot status={state} surface="bg-transparent" className={className} />;
}

function ProjectSection({ group, data, open, searching, expanded, onExpand, onNavigate, withPanes = false }: TreeFolds & {
  group: ProjectGroup;
  data: HomeData;
  open: boolean;
  searching: boolean;
  onNavigate?: () => void;
  /** Also list the project's workspace panes outside every thread; the sidebar has no "Other chats". */
  withPanes?: boolean;
}) {
  const { paneId, projectSlug } = useParams();
  const listId = useId();
  const { project, coordinator } = group;
  const session = data.session;
  const status = project.coordinator?.liveStatus;
  const openCount = project.threads.filter(isOpenThread).length;
  const others = withPanes && !searching ? projectPanes(data, project) : [];
  const row = (thread: ProjectThreadView, depth: number) => (
    <ThreadRow key={thread.id} thread={thread} depth={depth} slug={project.slug} session={session} current={thread.paneId !== undefined && thread.paneId === paneId} onNavigate={onNavigate} />
  );
  const branch = (node: ThreadNode, depth: number): ReactNode => {
    if (node.children.length === 0) return row(node.thread, depth);
    const key = `${project.slug}/${node.thread.id}`;
    const nodeOpen = searching || (expanded[key] ?? true);
    return (
      <div key={node.thread.id} role="group" aria-label={node.thread.title}>
        <ThreadRow thread={node.thread} depth={depth} slug={project.slug} session={session} current={node.thread.paneId !== undefined && node.thread.paneId === paneId}
          onNavigate={onNavigate} fold={{ open: nodeOpen, disabled: searching, onToggle: () => onExpand(key, !nodeOpen) }} kids={node.children.map((child) => threadState(child.thread))} />
        {nodeOpen && node.children.map((child) => branch(child, depth + 1))}
      </div>
    );
  };
  return (
    <section aria-label={project.name} className="nav-project-section">
      <div className="nav-project">
        <Link className="nav-row" to={projectPath(project.slug, session)} onClick={onNavigate} aria-current={projectSlug === project.slug ? "page" : undefined}>
          <span className="nav-avatar" aria-hidden>{project.name.trim().charAt(0).toUpperCase() || "P"}</span>
          <span className="nav-row-text">{project.name}</span>
          {status && <StatusDot status={status} surface="bg-transparent" className="size-2" />}
          {status && <span className="sr-only">, coordinator {STATUS_LABEL[status]}</span>}
          {openCount > 0 && <span className="nav-count" aria-hidden>{openCount}</span>}
          {openCount > 0 && <span className="sr-only">{`, ${openCount} open ${openCount === 1 ? "task" : "tasks"}`}</span>}
        </Link>
        <button type="button" className="nav-disclosure nav-disclosure-end" aria-label={`${project.name} tasks`} aria-expanded={open} aria-controls={listId}
          disabled={searching} onClick={() => onExpand(project.slug, !open)}>
          <ChevronRight aria-hidden size={14} />
        </button>
      </div>
      {open && (
        <div id={listId}>
          {coordinator && project.coordinator && (
            <Link className="nav-row nav-tree-row" style={depthStyle(1)} to={panePath(project.coordinator.paneId, session)} onClick={onNavigate}
              aria-current={project.coordinator.paneId === paneId ? "page" : undefined}>
              <Bot aria-hidden size={14} />
              <span className="nav-row-text">Coordinator</span>
              <span className="sr-only">, {STATUS_LABEL[project.coordinator.liveStatus]}</span>
              {isAttention(project.coordinator.liveStatus)
                ? <span className="nav-row-word text-status-blocked">needs you</span>
                : <span className="nav-row-note">{project.coordinator.agent}</span>}
            </Link>
          )}
          {threadTree(group.open).map((node) => branch(node, 1))}
          {others.map((pane) => (
            <Link key={pane.paneId} className="nav-row nav-tree-row" style={depthStyle(1)} to={panePath(pane.paneId, session)} onClick={onNavigate}
              aria-current={pane.paneId === paneId ? "page" : undefined}>
              {pane.kind === "shell" ? <Terminal aria-hidden size={14} /> : <StatusDot status={pane.status} surface="bg-transparent" className="size-2" />}
              <span className="nav-row-text">{paneSubject(pane)}</span>
              {pane.kind !== "shell" && <span className="sr-only">, {STATUS_LABEL[pane.status]}</span>}
              <span className="nav-row-note">{pane.kind === "shell" ? "shell" : pane.agent}</span>
            </Link>
          ))}
          {group.resolved.length > 0 && (
            <details className="nav-history" open={searching || group.resolved.some((thread) => thread.paneId !== undefined && thread.paneId === paneId)}>
              <summary className="nav-row nav-row-nested"><ChevronRight aria-hidden size={14} />History <span className="nav-count">{group.resolved.length}</span></summary>
              {group.resolved.map((thread) => row(thread, 2))}
            </details>
          )}
        </div>
      )}
    </section>
  );
}

/** Panes in a project's workspaces that run neither its coordinator nor one of its threads. */
function projectPanes(data: HomeData, project: ProjectView): AgentView[] {
  const held = new Set(project.workspaceIds ?? []);
  if (held.size === 0) return [];
  return [...data.agents, ...data.shellPanes].filter((pane) => held.has(pane.workspaceId) && !projectForPane(data.projects, pane.paneId));
}

const depthStyle = (depth: number) => ({ "--nav-depth": depth }) as CSSProperties;

function ThreadRow({ thread, depth, slug, session, current, onNavigate, fold, kids }: {
  thread: ProjectThreadView;
  depth: number;
  slug: string;
  session?: string;
  current: boolean;
  onNavigate?: () => void;
  /** Present on a coordinator thread with threads under it. */
  fold?: { open: boolean; disabled: boolean; onToggle: () => void };
  /** The states of the threads it coordinates, shown as dots while it is folded or open. */
  kids?: ThreadState[];
}) {
  const state = threadState(thread);
  const word = STATE_WORD[state];
  const note = thread.paneId || !isOpenThread(thread) ? undefined : thread.status === "open" ? "not running" : thread.status;
  return (
    <div className="nav-thread">
      {fold && (
        <button type="button" className="nav-disclosure" style={depthStyle(depth)} aria-label={`${thread.title} threads`} aria-expanded={fold.open}
          disabled={fold.disabled} onClick={fold.onToggle}>
          <ChevronRight aria-hidden size={13} />
        </button>
      )}
      <Link className={cn("nav-row nav-tree-row", fold && "nav-tree-head")} style={depthStyle(depth)} to={thread.paneId ? panePath(thread.paneId, session) : projectPath(slug, session)}
        onClick={onNavigate} aria-current={current ? "page" : undefined}>
        {!fold && <StateDot state={state} />}
        <span className="nav-row-text">{thread.title}</span>
        <span className="sr-only">, {state === "review" ? "ready for review" : STATUS_LABEL[state]}</span>
        {kids && kids.length > 0 && <span className="nav-dots" aria-hidden>{kids.slice(0, 6).map((kid, index) => <StateDot key={index} state={kid} className="size-1.5" />)}</span>}
        {!kids && word && <span aria-hidden className={cn("nav-row-word", state === "review" ? "text-primary" : "text-status-blocked")}>{word}</span>}
        {note && !word && !kids?.length && <span className="nav-row-note">{note}</span>}
      </Link>
    </div>
  );
}

/** The projects list, then every agent pane by recency; a project's panes carry its name. */
function RecentView({ data, query, currentProject, onNavigate }: ViewProps & { currentProject?: string }) {
  const { paneId } = useParams();
  const projects = (data.projects ?? []).filter((project) => projectMatches(project, query));
  const panes = data.agents.filter((pane) => {
    const owner = projectForPane(data.projects, pane.paneId);
    return chatMatches(pane, query) || matches(query, paneTitle(pane, owner), owner?.project.name);
  });
  return <>
    {projects.length > 0 && (
      <section aria-label="Projects">
        <h3 className="nav-label">Projects</h3>
        {projects.map((project) => {
          const status = project.coordinator?.liveStatus;
          return (
            <Link key={project.slug} className="nav-row" to={projectPath(project.slug, data.session)} onClick={onNavigate}
              aria-current={currentProject === project.slug ? "page" : undefined}>
              <FolderKanban aria-hidden size={16} />
              <span className="nav-row-text">{project.name}</span>
              {status && <StatusDot status={status} surface="bg-transparent" className="ml-auto size-2" />}
              {status && <span className="sr-only">, coordinator {STATUS_LABEL[status]}</span>}
            </Link>
          );
        })}
      </section>
    )}
    <ChatGroups panes={panes} projects={data.projects} session={data.session} currentPaneId={paneId} onNavigate={onNavigate} />
    {projects.length + panes.length === 0 && <Empty query={query} />}
  </>;
}

function Empty({ query }: { query: string }) {
  return <p className="nav-empty">{query.trim() ? "No matching projects or chats" : "Your agent chats will appear here."}</p>;
}
