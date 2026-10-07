import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Link, useParams } from "react-router";
import { ChevronRight, Clock, FolderKanban, House, Search, Settings, SquarePen } from "lucide-react";

import { ChatGroups, NavRow } from "@/components/chat-groups";
import { SessionSwitcher } from "@/components/session-switcher";
import { StatusDot } from "@/components/status-badge";
import { useSidebarPrefs, type SidebarView } from "@/hooks/use-sidebar-prefs";
import type { HomeData } from "@/lib/loaders";
import { homePath, panePath, projectPath, settingsPath } from "@/lib/nav";
import {
  byRecency, chatMatches, isOpenThread, looseChats, matches, paneTitle, projectForPane, projectGroups, projectMatches, type ProjectGroup,
} from "@/lib/projects";
import { paneDisplayName, STATUS_LABEL, type ProjectThreadView } from "@/lib/types";

/** The workbench navigation: new chat, search, then the herd either by project or by recency. */
export function WorkbenchSidebar({ data, onNavigate, onNewChat }: {
  data: HomeData;
  onNavigate?: () => void;
  onNewChat?: () => void;
}) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const { paneId, projectSlug } = useParams();
  const { prefs, setView, setExpanded } = useSidebarPrefs();
  const hasProjects = (data.projects ?? []).length > 0;
  const view: SidebarView = hasProjects ? prefs.view ?? "projects" : "recent";
  const currentProject = projectSlug ?? projectForPane(data.projects, paneId)?.project.slug;

  // Arriving in a project reveals it once; collapsing it again afterwards is the operator's call.
  const revealed = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!currentProject || revealed.current === currentProject) return;
    revealed.current = currentProject;
    setExpanded(currentProject, true);
  }, [currentProject, setExpanded]);

  function closeSearch() {
    setQuery("");
    setSearching(false);
  }

  return (
    <nav className="workbench-navigation" aria-label="Projects and chats">
      <div className="nav-top">
        <button type="button" className="nav-row" onClick={onNewChat} disabled={!onNewChat}><SquarePen aria-hidden size={16} />New chat</button>
        {searching ? (
          <label className="nav-row nav-search">
            <Search aria-hidden size={16} />
            <input type="search" autoFocus value={query} placeholder="Search" aria-label="Search projects and chats"
              onChange={(event) => setQuery(event.target.value)}
              onBlur={() => { if (!query.trim()) closeSearch(); }}
              onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); closeSearch(); } }} />
          </label>
        ) : (
          <button type="button" className="nav-row" onClick={() => setSearching(true)}><Search aria-hidden size={16} />Search</button>
        )}
        <Link className="nav-row" to={homePath(data.session)} onClick={onNavigate}><House aria-hidden size={16} />Home</Link>
      </div>

      <div className="nav-scroll">
        {hasProjects && <ViewToggle value={view} onChange={setView} />}
        {view === "projects"
          ? <ProjectsView data={data} query={query} expanded={prefs.expanded} onExpand={setExpanded} onNavigate={onNavigate} />
          : <RecentView data={data} query={query} currentProject={currentProject} onNavigate={onNavigate} />}
      </div>

      <div className="nav-footer">
        <SessionSwitcher sessions={data.sessions ?? []} current={data.session} />
        <Link className="nav-row" to={settingsPath(data.session)} onClick={onNavigate}><Settings aria-hidden size={16} />Settings</Link>
      </div>
    </nav>
  );
}

const VIEWS: Array<{ value: SidebarView; label: string; Icon: typeof Clock }> = [
  { value: "projects", label: "Projects", Icon: FolderKanban },
  { value: "recent", label: "Recent", Icon: Clock },
];

/** A two-way segmented switch; arrows move the choice, as in any radio group. */
function ViewToggle({ value, onChange }: { value: SidebarView; onChange: (view: SidebarView) => void }) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = VIEWS[(VIEWS.findIndex((view) => view.value === value) + step + VIEWS.length) % VIEWS.length];
    onChange(next.value);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-view="${next.value}"]`)?.focus();
  }
  return (
    <div className="nav-views" role="radiogroup" aria-label="Group by" onKeyDown={onKeyDown}>
      {VIEWS.map(({ value: option, label, Icon }) => (
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
function ProjectsView({ data, query, expanded, onExpand, onNavigate }: ViewProps & {
  expanded: Record<string, boolean>;
  onExpand: (slug: string, open: boolean) => void;
}) {
  const { paneId } = useParams();
  const groups = projectGroups(data.projects, query);
  const chats = byRecency(looseChats(data.agents, data.projects).filter((pane) => chatMatches(pane, query)));
  const searching = query.trim() !== "";
  return <>
    {groups.map((group) => (
      <ProjectSection key={group.project.slug} group={group} session={data.session} open={searching || (expanded[group.project.slug] ?? true)}
        searching={searching} onToggle={(open) => onExpand(group.project.slug, open)} onNavigate={onNavigate} />
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

function ProjectSection({ group, session, open, searching, onToggle, onNavigate }: {
  group: ProjectGroup;
  session?: string;
  open: boolean;
  searching: boolean;
  onToggle: (open: boolean) => void;
  onNavigate?: () => void;
}) {
  const { paneId, projectSlug } = useParams();
  const listId = useId();
  const { project, coordinator } = group;
  const status = project.coordinator?.liveStatus;
  const openCount = project.threads.filter(isOpenThread).length;
  const row = (thread: ProjectThreadView) => (
    <NavRow key={thread.id} nested status={thread.paneId ? thread.liveStatus ?? "unknown" : "unknown"} title={thread.title}
      to={thread.paneId ? panePath(thread.paneId, session) : projectPath(project.slug, session)}
      note={thread.paneId || !isOpenThread(thread) ? undefined : thread.status === "open" ? "not running" : thread.status}
      current={thread.paneId !== undefined && thread.paneId === paneId} onNavigate={onNavigate} />
  );
  return (
    <section aria-label={project.name}>
      <div className="nav-project">
        <button type="button" className="nav-disclosure" aria-label={`${project.name} tasks`} aria-expanded={open} aria-controls={listId}
          disabled={searching} onClick={() => onToggle(!open)}>
          <ChevronRight aria-hidden size={14} />
        </button>
        <Link className="nav-row" to={projectPath(project.slug, session)} onClick={onNavigate} aria-current={projectSlug === project.slug ? "page" : undefined}>
          <span className="nav-row-text">{project.name}</span>
          {status && <StatusDot status={status} surface="bg-transparent" className="size-2" />}
          {status && <span className="sr-only">, coordinator {STATUS_LABEL[status]}</span>}
          {openCount > 0 && <span className="nav-count" aria-hidden>{openCount}</span>}
          {openCount > 0 && <span className="sr-only">{`, ${openCount} open ${openCount === 1 ? "task" : "tasks"}`}</span>}
        </Link>
      </div>
      {open && (
        <div id={listId}>
          {coordinator && project.coordinator && (
            <NavRow nested status={project.coordinator.liveStatus} title="Coordinator" to={panePath(project.coordinator.paneId, session)}
              current={project.coordinator.paneId === paneId} onNavigate={onNavigate} />
          )}
          {group.open.map(row)}
          {group.resolved.length > 0 && (
            <details className="nav-history" open={searching || group.resolved.some((thread) => thread.paneId !== undefined && thread.paneId === paneId)}>
              <summary className="nav-row nav-row-nested"><ChevronRight aria-hidden size={14} />History <span className="nav-count">{group.resolved.length}</span></summary>
              {group.resolved.map(row)}
            </details>
          )}
        </div>
      )}
    </section>
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
