import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link, useLocation, useParams } from "react-router";
import { House, Inbox, PanelLeft, Plus, Search, Settings } from "lucide-react";

import { BottomTabBar, type TabBarTab } from "@/components/bottom-tab-bar";
import { looseWorkspaces, needsYou, WorkbenchSidebar, type SidebarRequest } from "@/components/workbench-sidebar";
import { BottomSheet } from "@/components/ui/sheet";
import { openNewDialog } from "@/components/new-agent-sheet";
import { isCatchingUp, isLocked } from "@/lib/idle";
import type { HomeData } from "@/lib/loaders";
import { homePath, projectPath, settingsPath, spacePath } from "@/lib/nav";
import { projectForPane } from "@/lib/projects";
import { isReadOnly } from "@/lib/types";
import { cn } from "@/lib/utils";
import { WorkbenchNavigationContext } from "@/lib/workbench-navigation";

/** What the phone's navigation sheet opened for; null while it is closed. */
type Sheet = "browse" | "needs-you" | "search" | null;
const SHEET_TITLE = { browse: "Navigation", "needs-you": "Needs you", search: "Search" } as const;

/** A page's own search box, which ⌘K focuses instead of opening the sidebar search. */
const PAGE_SEARCH = '.workbench-main [aria-keyshortcuts~="Meta+K"], .workbench-main input[aria-label="Jump to a project or chat"]';

/** ⌘ on Apple keyboards. Elsewhere Ctrl, except in a text field, where Ctrl+K and Ctrl+N edit text. */
function isShortcut(event: KeyboardEvent): boolean {
  if (event.metaKey) return !event.ctrlKey;
  if (!event.ctrlKey || /Mac|iPhone|iPad/.test(navigator.platform)) return false;
  const target = event.target as HTMLElement | null;
  return !target?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable=false])");
}

/** The breakpoint where workbench.css shows the sidebar instead of the tab bar. */
const DESKTOP = "(min-width: 1024px)";
const isDesktop = () => typeof window.matchMedia === "function" && window.matchMedia(DESKTOP).matches;

// Layout adapted from T3 Code AppSidebarLayout / SidebarChrome at 191a4ef.
// Routing, session selection and pane lifecycle remain owned by Nenu.
export function WorkbenchShell({ data, children }: { data: HomeData; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [request, setRequest] = useState<SidebarRequest>();
  const canCreate = !isReadOnly(data.device) && !data.error && data.bridge === "connected";
  const newChat = canCreate ? () => { setSheet(null); openNewDialog(); } : undefined;
  const attention = needsYou(data).length;
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
    if (sheet) setSheet(null);
  }

  function reveal(target: SidebarRequest["target"]) {
    if (isDesktop()) {
      setCollapsed(false);
      setRequest((last) => ({ target, seq: (last?.seq ?? 0) + 1 }));
    } else setSheet(target);
  }
  const search = () => reveal("search");

  // ⌘K searches and ⌘N starts something new. A screen with its own search box (Home's jump box)
  // gets ⌘K: the shell focuses that box, so the outcome does not depend on listener order.
  const latest = useRef({ search, newChat });
  latest.current = { search, newChat };
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.altKey || event.shiftKey || !isShortcut(event) || isLocked() || isCatchingUp()) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        const own = document.querySelector<HTMLInputElement>(PAGE_SEARCH);
        if (own) {
          own.focus();
          own.select();
        } else latest.current.search();
      } else if (key === "n" && latest.current.newChat) {
        event.preventDefault();
        latest.current.newChat();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A pane or project has its own composer at the bottom; the tab bar steps aside there.
  const tabBar = !/^\/(pane|project)\//.test(location.pathname);
  const active: TabBarTab = sheet ?? (location.pathname === "/" ? "home" : null);

  return (
    <div className="workbench-shell" data-sidebar-collapsed={collapsed}>
      <aside id={sidebarId} className="workbench-sidebar" aria-label="Workspace sidebar">
        <div className="workbench-brand-row">
          <Link to={homePath(data.session)} className="workbench-brand">
            <img src="/nenu-mark.png" alt="" width="22" height="22" className="nenu-mark" />
            <span>Nenu</span>
          </Link>
          <button ref={collapseButton} type="button" className="workbench-icon-button" aria-label="Collapse sidebar" aria-expanded={!collapsed} aria-controls={sidebarId} onClick={() => setCollapsed(true)}>
            <PanelLeft aria-hidden="true" size={17} />
          </button>
        </div>
        <WorkbenchSidebar data={data} onNewChat={newChat} request={request} />
      </aside>

      {collapsed && <SidebarRail data={data} attention={attention} expandRef={expandButton} sidebarId={sidebarId}
        onExpand={() => setCollapsed(false)} onNewChat={newChat} onSearch={search} onNeedsYou={() => reveal("needs-you")} />}

      <div className="workbench-main">
        <WorkbenchNavigationContext value={{ open: sheet !== null, onOpen: () => setSheet("browse"), onNewChat: newChat }}>
          {children}
        </WorkbenchNavigationContext>
        {tabBar && <BottomTabBar active={active} homeTo={homePath(data.session)} attention={attention} onNew={newChat}
          onNeedsYou={() => setSheet("needs-you")} onBrowse={() => setSheet("browse")} onSearch={() => setSheet("search")} />}
      </div>

      <BottomSheet open={sheet !== null} onClose={() => setSheet(null)} title={sheet ? SHEET_TITLE[sheet] : undefined}>
        <WorkbenchSidebar key={sheet} data={data} onNavigate={() => setSheet(null)} onNewChat={newChat} actions={!tabBar}
          request={sheet === "search" || sheet === "needs-you" ? { target: sheet, seq: 1 } : undefined} />
      </BottomSheet>
    </div>
  );
}

/** The collapsed sidebar: the same actions as icons, then a letter per project and loose workspace. */
function SidebarRail({ data, attention, expandRef, sidebarId, onExpand, onNewChat, onSearch, onNeedsYou }: {
  data: HomeData;
  attention: number;
  expandRef: RefObject<HTMLButtonElement | null>;
  sidebarId: string;
  onExpand: () => void;
  onNewChat?: () => void;
  onSearch: () => void;
  onNeedsYou: () => void;
}) {
  const { paneId, projectSlug, spaceId } = useParams();
  const currentProject = projectSlug ?? projectForPane(data.projects, paneId)?.project.slug;
  const currentSpace = spaceId ?? data.agents.find((pane) => pane.paneId === paneId)?.workspaceId;
  const initial = (name: string) => name.trim().charAt(0).toUpperCase() || "·";
  return (
    <nav className="workbench-sidebar-rail" aria-label="Collapsed sidebar">
      <button ref={expandRef} type="button" className="workbench-expand workbench-icon-button" aria-label="Expand sidebar" aria-expanded="false" aria-controls={sidebarId} onClick={onExpand}>
        <PanelLeft aria-hidden="true" size={18} />
      </button>
      <button type="button" className="workbench-icon-button" aria-label="New" onClick={onNewChat} disabled={!onNewChat}><Plus aria-hidden size={17} /></button>
      <button type="button" className="workbench-icon-button" aria-label="Search" onClick={onSearch}><Search aria-hidden size={17} /></button>
      <button type="button" className="workbench-icon-button rail-attention" aria-label={attention ? `Needs you, ${attention}` : "Needs you"} onClick={onNeedsYou}>
        <Inbox aria-hidden size={17} />{attention > 0 && <span className="rail-dot" aria-hidden />}
      </button>
      <Link className="workbench-icon-button" to={homePath(data.session)} aria-label="Home"><House aria-hidden size={17} /></Link>
      <span className="rail-divider" aria-hidden />
      {(data.projects ?? []).map((project) => (
        <Link key={project.slug} className={cn("rail-letter", currentProject === project.slug && "rail-letter-current")} to={projectPath(project.slug, data.session)}
          aria-label={project.name} aria-current={currentProject === project.slug ? "page" : undefined} title={project.name}>
          <span className="nav-avatar">{initial(project.name)}</span>
        </Link>
      ))}
      {looseWorkspaces(data).workspaces.map((workspace) => {
        const name = workspace.label || `Workspace ${workspace.number}`;
        return (
          <Link key={workspace.workspaceId} className={cn("rail-letter rail-letter-outline", currentSpace === workspace.workspaceId && "rail-letter-current")}
            to={spacePath(workspace.workspaceId, data.session)} aria-label={name} title={name}
            aria-current={currentSpace === workspace.workspaceId ? "page" : undefined}>{initial(name)}</Link>
        );
      })}
      <span className="flex-1" />
      <Link className="workbench-icon-button" to={settingsPath(data.session)} aria-label="Settings"><Settings aria-hidden size={17} /></Link>
    </nav>
  );
}
