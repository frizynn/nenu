import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router";
import { ChevronRight, Folder, FolderKanban, House, PanelLeft, Search, Settings, Terminal } from "lucide-react";

import { SessionSwitcher } from "@/components/session-switcher";
import { BottomSheet } from "@/components/ui/sheet";
import type { HomeData } from "@/lib/loaders";
import { homePath, panePath, projectPath, settingsPath, spacePath } from "@/lib/nav";
import { paneDisplayName, STATUS_LABEL } from "@/lib/types";
import { WorkbenchNavigationContext } from "@/lib/workbench-navigation";
import type { AgentView, TabView, WorkspaceView } from "@/lib/types";

function threadLabel(pane: AgentView): string {
  return pane.paneLabel || pane.sessionName || pane.tabLabel || pane.terminalTitle || paneDisplayName(pane);
}

// Layout adapted from T3 Code AppSidebarLayout / SidebarChrome at 191a4ef.
// Routing, session selection and pane lifecycle remain owned by Nenu.
export function WorkbenchShell({ data, children }: { data: HomeData; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  // One expansion model is shared by the desktop sidebar and the mobile drawer. The drawer mounts
  // its contents only while open, so keeping this state here prevents a closed/reopened drawer from
  // forgetting the tree the operator was browsing. Missing keys intentionally default to expanded,
  // which keeps newly-arrived workspaces/tabs visible without resetting deliberate collapses.
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Record<string, boolean>>({});
  const [expandedTabs, setExpandedTabs] = useState<Record<string, boolean>>({});
  const sidebarId = useId();
  const expandButton = useRef<HTMLButtonElement>(null);
  const collapseButton = useRef<HTMLButtonElement>(null);
  const wasCollapsed = useRef(false);
  useEffect(() => {
    if (collapsed) expandButton.current?.focus({ preventScroll: true });
    else if (wasCollapsed.current) collapseButton.current?.focus({ preventScroll: true });
    wasCollapsed.current = collapsed;
  }, [collapsed]);
  const location = useLocation();
  // A new route closes the drawer synchronously, including browser Back/Forward.
  const [drawerLocation, setDrawerLocation] = useState(location.key);
  if (drawerLocation !== location.key) {
    setDrawerLocation(location.key);
    if (mobileOpen) setMobileOpen(false);
  }

  return (
    <div className="workbench-shell" data-sidebar-collapsed={collapsed}>
      <aside id={sidebarId} className="workbench-sidebar" aria-label="Workspace sidebar">
        <div className="workbench-brand-row">
          <Link to={homePath(data.session)} className="workbench-brand">
            <img src="/nenu-mark.png" alt="" width="22" height="22" className="nenu-mark" />
            <span>Nenu <span className="font-normal text-muted-foreground">Code</span></span>
          </Link>
          <button ref={collapseButton} type="button" className="workbench-icon-button" aria-label="Collapse sidebar" aria-expanded={!collapsed} aria-controls={sidebarId} onClick={() => setCollapsed(true)}>
            <PanelLeft aria-hidden="true" size={17} />
          </button>
        </div>
        <WorkspaceNavigation
          data={data}
          expandedWorkspaces={expandedWorkspaces}
          expandedTabs={expandedTabs}
          onWorkspaceToggle={(workspaceId) => setExpandedWorkspaces((current) => ({
            ...current,
            [workspaceId]: !(current[workspaceId] ?? true),
          }))}
          onTabToggle={(tabId) => setExpandedTabs((current) => ({
            ...current,
            [tabId]: !(current[tabId] ?? true),
          }))}
        />
      </aside>

      {collapsed && <div className="workbench-sidebar-rail">
        <button ref={expandButton} type="button" className="workbench-expand workbench-icon-button" aria-label="Expand sidebar" aria-expanded="false" aria-controls={sidebarId} onClick={() => setCollapsed(false)}><PanelLeft aria-hidden="true" size={18} /></button>
      </div>}

      <div className="workbench-main">
        <WorkbenchNavigationContext value={{ open: mobileOpen, onOpen: () => setMobileOpen(true) }}>
          {children}
        </WorkbenchNavigationContext>
      </div>

      <BottomSheet open={mobileOpen} onClose={() => setMobileOpen(false)} title="Workspaces">
        <WorkspaceNavigation
          data={data}
          onNavigate={() => setMobileOpen(false)}
          expandedWorkspaces={expandedWorkspaces}
          expandedTabs={expandedTabs}
          onWorkspaceToggle={(workspaceId) => setExpandedWorkspaces((current) => ({
            ...current,
            [workspaceId]: !(current[workspaceId] ?? true),
          }))}
          onTabToggle={(tabId) => setExpandedTabs((current) => ({
            ...current,
            [tabId]: !(current[tabId] ?? true),
          }))}
        />
      </BottomSheet>
    </div>
  );
}

interface WorkspaceNavigationProps {
  data: HomeData;
  onNavigate?: () => void;
  expandedWorkspaces: Record<string, boolean>;
  expandedTabs: Record<string, boolean>;
  onWorkspaceToggle: (workspaceId: string) => void;
  onTabToggle: (tabId: string) => void;
}

interface NavigationTab extends TabView {
  panes: AgentView[];
}

interface NavigationWorkspace extends WorkspaceView {
  panes: AgentView[];
  tabs: NavigationTab[];
}

function WorkspaceNavigation({
  data,
  onNavigate,
  expandedWorkspaces,
  expandedTabs,
  onWorkspaceToggle,
  onTabToggle,
}: WorkspaceNavigationProps) {
  const [query, setQuery] = useState("");
  const { paneId, projectSlug, spaceId } = useParams();
  const navLocation = useLocation();
  const navInstance = useId().replaceAll(":", "");
  const needle = query.trim().toLocaleLowerCase();
  const panes = [...data.agents, ...data.shellPanes];
  const registeredProjects = (data.projects ?? []).filter((project) => {
    if (!needle) return true;
    return [project.name, project.slug, project.goal ?? "", ...project.threads.flatMap((thread) => [thread.id, thread.title])]
      .some((value) => value.toLocaleLowerCase().includes(needle));
  });

  // Keep the bridge's tab order, then append a small metadata fallback for older snapshots that only
  // expose panes. This preserves the previous pane links instead of dropping them when `tabs` is
  // temporarily empty during a reconnect or on an older Herdr.
  const navigationGroups: NavigationWorkspace[] = data.workspaces.map((space) => {
    const spacePanes = panes.filter((pane) => pane.workspaceId === space.workspaceId);
    const tabPanes = new Map<string, AgentView[]>();
    for (const pane of spacePanes) {
      const current = tabPanes.get(pane.tabId) ?? [];
      current.push(pane);
      tabPanes.set(pane.tabId, current);
    }
    const declaredTabs = data.tabs.filter((tab) => tab.workspaceId === space.workspaceId);
    const declaredIds = new Set(declaredTabs.map((tab) => tab.tabId));
    const fallbackTabs: TabView[] = [...tabPanes.keys()]
      .filter((tabId) => !declaredIds.has(tabId))
      .map((tabId, index) => {
        const tabPanesForId = tabPanes.get(tabId) ?? [];
        return {
          tabId,
          workspaceId: space.workspaceId,
          number: declaredTabs.length + index + 1,
          label: tabPanesForId[0]?.tabLabel || `Tab ${declaredTabs.length + index + 1}`,
          focused: false,
          paneCount: tabPanesForId.length,
        };
      });
    const allTabs = [...declaredTabs, ...fallbackTabs];
    const spaceMatches = !needle || `${space.label} ${space.number}`.toLocaleLowerCase().includes(needle);
    const tabs = allTabs.map((tab) => {
      const tabPanesForId = tabPanes.get(tab.tabId) ?? [];
      const tabMatches = spaceMatches || !needle || tab.label.toLocaleLowerCase().includes(needle);
      const visiblePanes = tabMatches
        ? tabPanesForId
        : tabPanesForId.filter((pane) => `${threadLabel(pane)} ${pane.cwd} ${pane.agent}`.toLocaleLowerCase().includes(needle));
      return { ...tab, panes: visiblePanes };
    }).filter((tab) => !needle || spaceMatches || tab.label.toLocaleLowerCase().includes(needle) || tab.panes.length > 0);
    return { ...space, panes: spacePanes, tabs };
  });
  const groups = navigationGroups.filter((space) => !needle || space.tabs.length > 0 || space.label.toLocaleLowerCase().includes(needle));

  function sectionId(kind: "workspace" | "tab", id: string): string {
    // encodeURIComponent keeps IDs stable and avoids collisions from workspace/tab IDs containing
    // punctuation, while the useId prefix keeps the desktop tree and mobile drawer distinct.
    return `${navInstance}-${kind}-${encodeURIComponent(id).replaceAll("%", "_")}`;
  }

  return (
    <nav className="workbench-navigation" aria-label="Projects and agents">
      <div className="workbench-nav-top">
        <Link className="workbench-nav-action" to={homePath(data.session)} onClick={onNavigate}><House aria-hidden="true" size={16} />Overview</Link>
        <label className="workbench-search">
          <Search aria-hidden="true" size={15} />
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search threads…" aria-label="Search projects and agents" />
        </label>
      </div>
      <div className="workbench-projects">
        <div className="workbench-section-label">Projects <span>{registeredProjects.length}</span></div>
        {registeredProjects.map((project) => (
          <section className="workbench-project" key={project.slug}>
            <div className="workbench-project-title-row">
              <Link
                className="workbench-project-title"
                to={projectPath(project.slug, data.session)}
                onClick={onNavigate}
                aria-current={projectSlug === project.slug || navLocation.pathname === `/project/${encodeURIComponent(project.slug)}` ? "page" : undefined}
              >
                <FolderKanban aria-hidden="true" size={15} />
                <span>{project.name}</span>
                <span className="workbench-count" aria-hidden="true">
                  {project.threads.filter((thread) => thread.status !== "resolved").length}
                </span>
              </Link>
            </div>
          </section>
        ))}
        {registeredProjects.length === 0 && !needle && <p className="workbench-empty-project">Registered Herdr projects will appear here.</p>}
        <div className="workbench-section-label">Workspaces <span>{groups.length}</span></div>
        {groups.map((space) => {
          const workspaceCanExpand = space.tabs.length > 1;
          const workspaceOpen = !workspaceCanExpand || (expandedWorkspaces[space.workspaceId] ?? true);
          const workspaceSectionId = sectionId("workspace", space.workspaceId);
          return (
            <section className="workbench-project" key={space.workspaceId}>
              <div className="workbench-project-title-row">
                {workspaceCanExpand && <TreeToggle
                    open={workspaceOpen}
                    label={space.label || `Workspace ${space.number}`}
                    controls={workspaceSectionId}
                    onClick={() => onWorkspaceToggle(space.workspaceId)}
                  />}
                <Link className="workbench-project-title" to={spacePath(space.workspaceId, data.session)} onClick={onNavigate} aria-current={spaceId === space.workspaceId ? "page" : undefined}>
                  <Folder aria-hidden="true" size={15} /><span>{space.label || `Workspace ${space.number}`}</span><span className="workbench-count" aria-hidden="true">{space.paneCount}</span>
                </Link>
              </div>
              <div id={workspaceSectionId} hidden={!workspaceOpen} className="workbench-project-children">
                {space.tabs.map((tab) => {
                  const tabCanExpand = tab.panes.length > 1;
                  const tabOpen = !tabCanExpand || (expandedTabs[tab.tabId] ?? true);
                  const tabSectionId = sectionId("tab", tab.tabId);
                  const onlyPane = tab.panes[0];
                  return (
                    <div className="workbench-tab" key={tab.tabId}>
                      {tabCanExpand ? <button
                        type="button"
                        className="workbench-tab-toggle"
                        aria-label={`${tabOpen ? "Collapse" : "Expand"} tab ${tab.label}`}
                        aria-expanded={tabOpen}
                        aria-controls={tabSectionId}
                        data-expanded={tabOpen}
                        onClick={() => onTabToggle(tab.tabId)}
                      >
                        <ChevronRight aria-hidden="true" size={14} />
                        <span className="workbench-tab-name">{tab.label}</span>
                        <span className="workbench-count" aria-hidden="true">{tab.paneCount}</span>
                      </button> : onlyPane ? <Link
                        className="workbench-tab-toggle"
                        to={panePath(onlyPane.paneId, data.session)}
                        onClick={onNavigate}
                        aria-current={paneId === onlyPane.paneId ? "page" : undefined}
                        aria-label={`Open tab ${tab.label}, pane ${threadLabel(onlyPane)}`}
                      >
                        {onlyPane.kind === "shell" ? <Terminal aria-hidden="true" size={13} /> : <span className="workbench-status-dot" data-status={onlyPane.status} aria-hidden="true" />}
                        <span className="workbench-tab-name">{tab.label}</span>
                      </Link> : <div className="workbench-tab-toggle" aria-label={`Tab ${tab.label}, no active panes`}>
                        <span className="workbench-tab-name">{tab.label}</span>
                        <span className="workbench-count">empty</span>
                      </div>}
                      {tabCanExpand && <div id={tabSectionId} hidden={!tabOpen} className="workbench-tab-children">
                        {tab.panes.map((pane) => (
                          <Link key={pane.paneId} className="workbench-thread" to={panePath(pane.paneId, data.session)} onClick={onNavigate} aria-current={paneId === pane.paneId ? "page" : undefined} title={`${threadLabel(pane)} · ${pane.agent} · ${STATUS_LABEL[pane.status]}`}>
                            {pane.kind === "shell" ? <Terminal aria-hidden="true" size={13} /> : <span className="workbench-status-dot" data-status={pane.status} aria-hidden="true" />}
                            <span className="workbench-thread-name">{threadLabel(pane)}</span>
                            <span className="sr-only"> · {STATUS_LABEL[pane.status]}</span>
                          </Link>
                        ))}
                      </div>}
                    </div>
                  );
                })}
                {space.tabs.length === 0 && <div className="workbench-empty-project">No tabs yet</div>}
              </div>
            </section>
          );
        })}
        {groups.length === 0 && <p className="workbench-empty-project">{needle && registeredProjects.length === 0 ? "No matching projects or threads" : needle ? "No matching workspaces" : "Your Herdr workspaces will appear here."}</p>}
      </div>
      <div className="workbench-sidebar-footer">
        <SessionSwitcher sessions={data.sessions ?? []} current={data.session} />
        <Link className="workbench-nav-action" to={settingsPath(data.session)} onClick={onNavigate}><Settings aria-hidden="true" size={16} />Settings</Link>
      </div>
    </nav>
  );
}

function TreeToggle({
  open,
  label,
  controls,
  onClick,
}: {
  open: boolean;
  label: string;
  controls: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="workbench-tree-toggle"
      aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
      aria-expanded={open}
      aria-controls={controls}
      data-expanded={open}
      data-tree-kind="workspace"
      onClick={onClick}
    >
      <ChevronRight aria-hidden="true" size={15} />
    </button>
  );
}
