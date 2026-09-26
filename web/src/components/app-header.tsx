import { useContext, type ReactNode } from "react";
import { Settings } from "lucide-react";
import { useNavigate } from "react-router";

import { isConnecting } from "@/lib/connection";
import { useConnectionLost } from "@/hooks/use-connection-lost";
import { settingsPath } from "@/lib/nav";
import { CollieHome } from "@/components/collie-home";
import type { BridgeStatus } from "@/lib/types";
import { WorkbenchNavigationContext } from "@/lib/workbench-navigation";

interface AppHeaderProps {
  // Brief network failures do not animate the header. A sustained outage mutes the mark.
  bridge: BridgeStatus | undefined;
  error: boolean;

  /** Tapping the Nenu mark returns to the dashboard. A callback, not a `<Link to="/">`: the
   *  dashboard and the drilled-in space view share the "/" route, so a same-route link would no-op. */
  onHome?: () => void;
  /** Show the "Nenu" wordmark beside the mark (dashboard + space). Omit inside a pane — the
   *  breadcrumb in `children` carries the context there, and the mark stands alone to save width. */
  wordmark?: boolean;

  /** Route-specific center content — the pane's `space › tab` breadcrumb. Rendered in a `flex-1
   *  min-w-0` region so a long breadcrumb truncates instead of pushing the pill off the row. Empty on
   *  the dashboard/space, where the region is just the spacer that pushes the right cluster over. */
  children?: ReactNode;
  /** Right-cluster lead items (the dashboard's SessionSwitcher; the pane's StatusBadge). */
  rightLead?: ReactNode;
  /** Right-cluster trailing items (the Settings gear). */
  rightTrail?: ReactNode;

  /** Full-width takeover of the header row (the pane's find bar). When set it replaces the normal
   *  content while it's up — the find bar owns the row one-handed, exactly as before — but it still
   *  lives inside this one shell so the sticky/safe-area/zinc bar is never copy-pasted. */
  override?: ReactNode;
}

// Shared header geometry and connection treatment for every route.
export function AppHeader({
  bridge,
  error,
  onHome,
  wordmark,
  children,
  rightLead,
  rightTrail,
  override,
}: AppHeaderProps) {
  const navigation = useContext(WorkbenchNavigationContext);
  const connecting = isConnecting({ bridge, error });
  const lost = useConnectionLost(connecting);
  return (
    <header className="workbench-app-header sticky top-0 z-20 flex min-h-11 shrink-0 items-center gap-1.5 border-b border-border/60 bg-muted px-2 py-0 sm:gap-2 sm:pl-4 sm:pr-2 sm:py-2">
      {override ?? (
        <>
          {navigation && (
            <CollieHome
              onHome={navigation.onOpen}
              label="Open workspaces"
              expanded={navigation.open}
              trouble={lost}
              lost={lost}
              className="workbench-chat-menu lg:hidden"
            />
          )}
          {(onHome || wordmark || !navigation) && (
            <CollieHome
              onHome={onHome}
              trouble={lost}
              lost={lost}
              wordmark={wordmark}
              className={navigation ? "hidden lg:flex" : !wordmark ? "max-sm:hidden" : undefined}
            />
          )}
          {/* Center region: the breadcrumb (or, on the dashboard/space, an empty flex-1 spacer that
              pushes the right cluster to the edge). min-w-0 so the breadcrumb truncates when tight. */}
          <div className="flex min-w-0 flex-1 items-center">{children}</div>
          {/* gap-1, not gap-3: the icon buttons now carry their own 12px of padding to reach 44px,
              so a 12px gap on top of that reads as a gulf. 4px keeps the apparent spacing between
              icons close to what it was. */}
          <div className="flex shrink-0 items-center gap-1">
            {rightLead}
            {rightTrail}
          </div>
        </>
      )}
    </header>
  );
}

// The Settings gear, shared so the dashboard and space headers don't each hand-roll it. Session-scoped
// so the navigation stays on the session you're viewing.
export function SettingsGear({ session }: { session?: string }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate(settingsPath(session))}
      aria-label="Settings"
      // A real 44px box, NOT padding pulled back by a negative margin. The negative-margin trick
      // keeps icons visually tight but lets adjacent boxes overlap (two -m-3 buttons pull 24px
      // against a 12px gap, so a neighbour steals 12px of this one's hit area) and drags the last
      // one past the header's padding into document overflow. Costs horizontal room, which the
      // breadcrumb absorbs — it already truncates by design.
      className="grid size-11 place-items-center text-muted-foreground transition-colors hover:text-foreground"
    >
      <Settings className="size-5" />
    </button>
  );
}
