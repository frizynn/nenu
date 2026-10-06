import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { PanelLeft } from "lucide-react";

import { NewSpaceSheet } from "@/components/new-space-sheet";
import { WorkbenchSidebar } from "@/components/workbench-sidebar";
import { BottomSheet } from "@/components/ui/sheet";
import { useSpaceActions } from "@/hooks/use-spaces";
import type { HomeData } from "@/lib/loaders";
import { homePath } from "@/lib/nav";
import { isReadOnly } from "@/lib/types";
import { WorkbenchNavigationContext } from "@/lib/workbench-navigation";

// Layout adapted from T3 Code AppSidebarLayout / SidebarChrome at 191a4ef.
// Routing, session selection and pane lifecycle remain owned by Nenu.
export function WorkbenchShell({ data, children }: { data: HomeData; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const { newSpace } = useSpaceActions();
  const canCreate = !isReadOnly(data.device) && !data.error && data.bridge === "connected";
  const newChat = canCreate ? () => { setMobileOpen(false); setNewChatOpen(true); } : undefined;
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
        <WorkbenchSidebar data={data} onNewChat={newChat} />
      </aside>

      {collapsed && <div className="workbench-sidebar-rail">
        <button ref={expandButton} type="button" className="workbench-expand workbench-icon-button" aria-label="Expand sidebar" aria-expanded="false" aria-controls={sidebarId} onClick={() => setCollapsed(false)}><PanelLeft aria-hidden="true" size={18} /></button>
      </div>}

      <div className="workbench-main">
        <WorkbenchNavigationContext value={{ open: mobileOpen, onOpen: () => setMobileOpen(true), onNewChat: newChat }}>
          {children}
        </WorkbenchNavigationContext>
      </div>

      <BottomSheet open={mobileOpen} onClose={() => setMobileOpen(false)} title="Navigation">
        <WorkbenchSidebar data={data} onNavigate={() => setMobileOpen(false)} onNewChat={newChat} />
      </BottomSheet>
      <NewSpaceSheet open={newChatOpen} onClose={() => setNewChatOpen(false)} onCreate={newSpace} />
    </div>
  );
}
