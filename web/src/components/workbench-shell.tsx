import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router";
import { PanelLeft, Search, SquarePen } from "@/components/ui/icon";

import { BottomTabBar, type TabBarTab } from "@/components/bottom-tab-bar";
import { SidebarRail } from "@/components/sidebar-rail";
import { clampTo, ResizeHandle, type WidthRange } from "@/components/ui/resize-handle";
import { WorkbenchSidebar, type SidebarRequest } from "@/components/workbench-sidebar";
import { BottomSheet, SideSheet } from "@/components/ui/sheet";
import { openNewDialog } from "@/components/new-agent-sheet";
import { isCatchingUp, isLocked } from "@/lib/idle";
import { needsYouCount } from "@/lib/home-stats";
import type { HomeData } from "@/lib/loaders";
import { homePath } from "@/lib/nav";
import { canCreate } from "@/lib/types";
import { WorkbenchNavigationContext } from "@/lib/workbench-navigation";

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
const WIDTH_KEY = "nenu:sidebar-width:v1";
/** The sidebar's widths; nav.css keeps it under 40% of the window whatever was chosen. */
export const SIDEBAR_WIDTH: WidthRange = { min: 220, initial: 272, max: 420, step: 16 };

function readStored<T>(key: string, parse: (raw: string | null) => T): T {
  try {
    return parse(localStorage.getItem(key));
  } catch {
    return parse(null);
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A blocked store only forgets the choice.
  }
}

/** The desktop sidebar's state, kept per device: shown as the rail or not, and its width. */
function useSidebar() {
  const [collapsed, setCollapsed] = useState(() => readStored(COLLAPSED_KEY, (raw) => raw === "1"));
  const [width, setWidth] = useState(() => readStored(WIDTH_KEY, (raw) => raw && Number.isFinite(Number(raw)) ? clampTo(SIDEBAR_WIDTH, Number(raw)) : SIDEBAR_WIDTH.initial));
  return {
    collapsed,
    width,
    collapse: (next: boolean) => {
      setCollapsed(next);
      store(COLLAPSED_KEY, next ? "1" : "0");
    },
    resize: (next: number) => {
      setWidth(next);
      store(WIDTH_KEY, String(next));
    },
  };
}

// Layout adapted from T3 Code AppSidebarLayout / SidebarChrome at 191a4ef.
// Routing, session selection and pane lifecycle remain owned by Nenu.
export function WorkbenchShell({ data, children }: { data: HomeData; children: ReactNode }) {
  const { collapsed, collapse: setCollapsed, width: sidebarWidth, resize: setSidebarWidth } = useSidebar();
  // The phone's Search sheet, which the tab bar opens.
  const [searchSheet, setSearchSheet] = useState(false);
  // The drawer the header's Nenu mark opens; its Search bumps `drawerSearch`.
  const [drawer, setDrawer] = useState(false);
  const [drawerSearch, setDrawerSearch] = useState(0);
  const [request, setRequest] = useState<SidebarRequest>();
  const closeDrawer = () => { setDrawer(false); setDrawerSearch(0); };
  const newChat = canCreate(data) ? () => { setSearchSheet(false); closeDrawer(); openNewDialog(); } : undefined;
  const attention = needsYouCount(data);
  const sidebarId = useId();
  const expandButton = useRef<HTMLButtonElement>(null);
  const collapseButton = useRef<HTMLButtonElement>(null);
  // Only a press moves focus to the counterpart button.
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
    if (searchSheet) setSearchSheet(false);
    if (drawer) closeDrawer();
  }

  function search() {
    if (isDesktop()) {
      setCollapsed(false);
      setRequest((last) => ({ target: "search", seq: (last?.seq ?? 0) + 1 }));
    } else setSearchSheet(true);
  }

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

  // The tab bar steps aside where a chat owns the bottom edge: a pane with its composer and that pane's History.
  const { paneId } = useParams();
  const tabBar = paneId === undefined;
  const active: TabBarTab = searchSheet ? "search" : location.pathname === "/" ? "home" : null;

  return (
    <div className="workbench-shell" data-sidebar-collapsed={collapsed}>
      <aside id={sidebarId} className="workbench-sidebar" aria-label="Workspace sidebar" style={{ width: sidebarWidth }}>
        <div className="workbench-brand-row">
          <Link to={homePath(data.session)} className="workbench-brand">
            <img src="/nenu-mark.png" alt="" width="22" height="22" className="nenu-mark" />
            <span>Nenu</span>
          </Link>
          <button ref={collapseButton} type="button" className="workbench-icon-button" aria-label="Collapse sidebar" aria-expanded={!collapsed} aria-controls={sidebarId} onClick={() => toggle(true)}>
            <PanelLeft aria-hidden="true" size={16} />
          </button>
        </div>
        <WorkbenchSidebar data={data} onNewChat={newChat} request={request} />
        <ResizeHandle label="Resize sidebar" edge="end" width={sidebarWidth} range={SIDEBAR_WIDTH} onChange={setSidebarWidth}
          limit={() => Math.floor(window.innerWidth * 0.4)} />
      </aside>

      {collapsed && <SidebarRail data={data} attention={attention} expandRef={expandButton} sidebarId={sidebarId}
        onExpand={() => toggle(false)} onNewChat={newChat} onSearch={search} />}

      <div className="workbench-main">
        <WorkbenchNavigationContext value={{ open: drawer, onOpen: () => setDrawer(true), onNewChat: newChat }}>
          {children}
        </WorkbenchNavigationContext>
        {tabBar && <BottomTabBar active={active} homeTo={homePath(data.session)} attention={attention} onNew={newChat} onSearch={() => setSearchSheet(true)} />}
      </div>

      <BottomSheet open={searchSheet} onClose={() => setSearchSheet(false)} title="Search">
        {searchSheet && <WorkbenchSidebar data={data} onNewChat={newChat} variant="sheet" request={{ target: "search", seq: 1 }} />}
      </BottomSheet>

      <SideSheet open={drawer} onClose={closeDrawer} title="Navigation"
        heading={<Link to={homePath(data.session)} className="workbench-brand hit-area" onClick={closeDrawer} aria-label="Nenu home">
          <img src="/nenu-mark.png" alt="" width="22" height="22" className="nenu-mark" /><span>Nenu</span>
        </Link>}
        headerAction={<>
          <button type="button" className="workbench-icon-button" aria-label="Search" onClick={() => setDrawerSearch((n) => n + 1)}><Search aria-hidden size={16} /></button>
          <button type="button" className="workbench-icon-button" aria-label="New" onClick={newChat} disabled={!newChat}><SquarePen aria-hidden size={16} /></button>
        </>}>
        <WorkbenchSidebar data={data} onNewChat={newChat} variant="drawer"
          request={drawerSearch ? { target: "search", seq: drawerSearch } : undefined} />
      </SideSheet>
    </div>
  );
}
