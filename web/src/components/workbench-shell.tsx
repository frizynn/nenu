import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router";
import { PanelLeft, Plus, Search } from "lucide-react";

import { BottomTabBar, type TabBarTab } from "@/components/bottom-tab-bar";
import { SidebarRail } from "@/components/sidebar-rail";
import { needsYou, WorkbenchSidebar, type SidebarRequest } from "@/components/workbench-sidebar";
import { BottomSheet, SideSheet } from "@/components/ui/sheet";
import { openNewDialog } from "@/components/new-agent-sheet";
import { isCatchingUp, isLocked } from "@/lib/idle";
import type { HomeData } from "@/lib/loaders";
import { homePath } from "@/lib/nav";
import { liveCoordinator } from "@/lib/projects";
import { canCreate } from "@/lib/types";
import { WorkbenchNavigationContext } from "@/lib/workbench-navigation";

/** What the phone's tab bar opened its navigation sheet for; null while it is closed. */
type Sheet = "browse" | "needs-you" | "search" | null;
const SHEET_TITLE = { browse: "Navigation", "needs-you": "Needs you", search: "Search" } as const;

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

const COLLAPSED_KEY = "nenu:sidebar-collapsed:v1";
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Whether the desktop sidebar shows as the rail. The operator's choice persists; a docked thread
 * folds it too, to give the split its width, until the operator expands it during that dock.
 */
function useSidebarCollapse() {
  const [chosen, setChosen] = useState(readCollapsed);
  const [docked, setDocked] = useState(false);
  const [expandedInDock, setExpandedInDock] = useState(false);
  if (!docked && expandedInDock) setExpandedInDock(false);
  const choose = (next: boolean) => {
    setChosen(next);
    if (!next && docked) setExpandedInDock(true);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // A blocked store only forgets the choice.
    }
  };
  return { collapsed: chosen || (docked && !expandedInDock), choose, setDocked };
}

// Layout adapted from T3 Code AppSidebarLayout / SidebarChrome at 191a4ef.
// Routing, session selection and pane lifecycle remain owned by Nenu.
export function WorkbenchShell({ data, children }: { data: HomeData; children: ReactNode }) {
  const { collapsed, choose: setCollapsed, setDocked } = useSidebarCollapse();
  const [sheet, setSheet] = useState<Sheet>(null);
  // The drawer the header's Nenu mark opens; its Search bumps `drawerSearch`.
  const [drawer, setDrawer] = useState(false);
  const [drawerSearch, setDrawerSearch] = useState(0);
  const [request, setRequest] = useState<SidebarRequest>();
  const closeDrawer = () => { setDrawer(false); setDrawerSearch(0); };
  const newChat = canCreate(data) ? () => { setSheet(null); closeDrawer(); openNewDialog(); } : undefined;
  const attention = needsYou(data).length;
  const sidebarId = useId();
  const expandButton = useRef<HTMLButtonElement>(null);
  const collapseButton = useRef<HTMLButtonElement>(null);
  // Only a press moves focus to the counterpart button; a dock folding the sidebar leaves it alone.
  const toggled = useRef(false);
  useEffect(() => {
    if (!toggled.current) return;
    toggled.current = false;
    (collapsed ? expandButton : collapseButton).current?.focus({ preventScroll: true });
  }, [collapsed]);
  const toggle = (next: boolean) => {
    toggled.current = true;
    setCollapsed(next);
  };
  const location = useLocation();
  // A new route closes the drawer synchronously, including browser Back/Forward.
  const [drawerLocation, setDrawerLocation] = useState(location.key);
  if (drawerLocation !== location.key) {
    setDrawerLocation(location.key);
    if (sheet) setSheet(null);
    if (drawer) closeDrawer();
  }

  function reveal(target: SidebarRequest["target"]) {
    if (isDesktop()) {
      setCollapsed(false);
      setRequest((last) => ({ target, seq: (last?.seq ?? 0) + 1 }));
    } else setSheet(target);
  }
  const search = () => reveal("search");

  // ⌘K searches and ⌘N starts something new.
  const latest = useRef({ search, newChat });
  latest.current = { search, newChat };
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.altKey || event.shiftKey || !isShortcut(event) || isLocked() || isCatchingUp()) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        latest.current.search();
      } else if (key === "n" && latest.current.newChat) {
        event.preventDefault();
        latest.current.newChat();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The tab bar steps aside where a chat owns the bottom edge: a pane with its composer, that pane's
  // History, and a project whose live coordinator is opening its pane (the URL stays on the project while
  // the pane loads). A project without one, and every node page, keep it.
  const { paneId, projectSlug, nodeId } = useParams();
  const opensPane = projectSlug !== undefined && nodeId === undefined
    && liveCoordinator(data.projects?.find((project) => project.slug === projectSlug), data.agents) !== undefined;
  const tabBar = paneId === undefined && !opensPane;
  const active: TabBarTab = sheet ?? (location.pathname === "/" ? "home" : null);

  return (
    <div className="workbench-shell" data-sidebar-collapsed={collapsed}>
      <aside id={sidebarId} className="workbench-sidebar" aria-label="Workspace sidebar">
        <div className="workbench-brand-row">
          <Link to={homePath(data.session)} className="workbench-brand">
            <img src="/nenu-mark.png" alt="" width="22" height="22" className="nenu-mark" />
            <span>Nenu</span>
          </Link>
          <button ref={collapseButton} type="button" className="workbench-icon-button" aria-label="Collapse sidebar" aria-expanded={!collapsed} aria-controls={sidebarId} onClick={() => toggle(true)}>
            <PanelLeft aria-hidden="true" size={17} />
          </button>
        </div>
        <WorkbenchSidebar data={data} onNewChat={newChat} request={request} />
      </aside>

      {collapsed && <SidebarRail data={data} attention={attention} expandRef={expandButton} sidebarId={sidebarId}
        onExpand={() => toggle(false)} onNewChat={newChat} onSearch={search} onNeedsYou={() => reveal("needs-you")} />}

      <div className="workbench-main">
        <WorkbenchNavigationContext value={{ open: drawer, onOpen: () => setDrawer(true), onNewChat: newChat, onDock: setDocked }}>
          {children}
        </WorkbenchNavigationContext>
        {tabBar && <BottomTabBar active={active} homeTo={homePath(data.session)} attention={attention} onNew={newChat}
          onNeedsYou={() => setSheet("needs-you")} onBrowse={() => setSheet("browse")} onSearch={() => setSheet("search")} />}
      </div>

      <BottomSheet open={sheet !== null} onClose={() => setSheet(null)} title={sheet ? SHEET_TITLE[sheet] : undefined}>
        <WorkbenchSidebar key={sheet} data={data} onNewChat={newChat} variant="sheet"
          request={sheet === "search" || sheet === "needs-you" ? { target: sheet, seq: 1 } : undefined} />
      </BottomSheet>

      <SideSheet open={drawer} onClose={closeDrawer} title="Navigation"
        heading={<Link to={homePath(data.session)} className="workbench-brand hit-area" onClick={closeDrawer} aria-label="Nenu home">
          <img src="/nenu-mark.png" alt="" width="22" height="22" className="nenu-mark" /><span>Nenu</span>
        </Link>}
        headerAction={<>
          <button type="button" className="workbench-icon-button" aria-label="Search" onClick={() => setDrawerSearch((n) => n + 1)}><Search aria-hidden size={18} /></button>
          <button type="button" className="workbench-icon-button" aria-label="New" onClick={newChat} disabled={!newChat}><Plus aria-hidden size={18} /></button>
        </>}>
        <WorkbenchSidebar data={data} onNewChat={newChat} variant="drawer"
          request={drawerSearch ? { target: "search", seq: drawerSearch } : undefined} />
      </SideSheet>
    </div>
  );
}
