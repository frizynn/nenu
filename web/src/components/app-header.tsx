import { useContext, type ReactNode } from "react";
import { ChevronLeft, Settings2 } from "@/components/ui/icon";
import { Link, matchPath, useLocation, useNavigate, type LinkProps } from "react-router";

import { isConnecting } from "@/lib/connection";
import { useConnectionLost } from "@/hooks/use-connection-lost";
import { armMotion, useGoBack } from "@/lib/motion";
import { homePath, settingsPath } from "@/lib/nav";
import { useSession } from "@/lib/session";
import { CollieHome } from "@/components/collie-home";
import type { BridgeStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { WorkbenchNavigationContext } from "@/lib/workbench-navigation";

/**
 * A link to `to` whose plain tap runs `go` instead, a step back or up through the history (lib/motion.ts);
 * a modified click and a long-press still open the address as a link does.
 */
export function StepLink({ to, go, ...props }: Omit<LinkProps, "to" | "onClick"> & { to: string; go: (to: string) => void }) {
  return <Link {...props} to={to} onClick={(event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    go(to);
  }} />;
}

/** Where a screen's back control leads: the parent and its name, read out as "Back to <label>". */
export interface HeaderBack {
  label: string;
  /** The parent's path. */
  to?: string;
  /** Runs instead of following `to`: a parent the caller routes to itself, or one shown in place. */
  onClick?: () => void;
  /** The parent is shown in place (a subagent's Main): its name sits beside the chevron, and the back
   *  stays on a desk, where the sidebar cannot reach it. */
  inPlace?: boolean;
}

interface AppHeaderProps {
  // Brief network failures do not animate the header. A sustained outage mutes the mark.
  bridge: BridgeStatus | undefined;
  error: boolean;

  /** The screen's name in the bar and its h1: the 17 px headline on a phone, with an optional 13 px line under it. */
  title?: ReactNode;
  subtitle?: ReactNode;
  /** The page is showing the title as its own heading right now (ColumnPage), so the bar leaves it out. */
  titleHidden?: boolean;
  /** Where the phone's back control goes. Without one it goes Home. */
  back?: HeaderBack;

  /** Route-specific center content beside or instead of the title (a chat's own title). Rendered in a
   *  `flex-1 min-w-0` region so it truncates instead of pushing the right cluster off the row. */
  children?: ReactNode;
  /** Right-cluster lead items (the pane's tools). */
  rightLead?: ReactNode;
  /** Right-cluster trailing items (the Settings gear). */
  rightTrail?: ReactNode;

  /** Full-width takeover of the header row (the pane's find bar). When set it replaces the normal
   *  content while it's up — the find bar owns the row one-handed, exactly as before — but it still
   *  lives inside this one shell so the sticky/safe-area/zinc bar is never copy-pasted. */
  override?: ReactNode;
}

/** The one route whose phone header leads with the mark, which opens navigation: Home. Every other
 *  screen leads with a back; a chat's title opens the navigation instead. */
const HOME_ROUTE = "/";

// A real 44 px box on a phone, its chevron at the leading edge so the stroke lines up with the 16 px page
// gutter without a negative margin (which would push the focus ring off screen). On a desk the sidebar
// is the way around, so the back steps aside, unless its parent is shown in place or not listed there.
const BACK_CONTROL = "flex h-11 min-w-11 shrink-0 items-center rounded-md pl-1 text-foreground transition-opacity active:opacity-60";

// Shared header and connection treatment for every route; its size and padding live in workbench.css.
export function AppHeader({
  bridge,
  error,
  title,
  subtitle,
  titleHidden = false,
  back,
  children,
  rightLead,
  rightTrail,
  override,
}: AppHeaderProps) {
  const navigation = useContext(WorkbenchNavigationContext);
  const { pathname } = useLocation();
  const session = useSession();
  const goBack = useGoBack();
  const lost = useConnectionLost(isConnecting({ bridge, error }));
  // Home's bar is the brand: the page's headline sits right under it, so it carries no title of its own.
  const home = matchPath(HOME_ROUTE, pathname) !== null;
  const mark = !back && home;
  const icon = <ChevronLeft aria-hidden className="size-6 shrink-0" strokeWidth={2.25} />;
  const parent = back?.to ?? homePath(session);
  const backClass = cn(BACK_CONTROL, back?.inPlace ? "pr-2" : "lg:hidden");
  // A desk draws no line under a bar with nothing in its middle (Home): an empty band under a rule
  // reads as a missing title. A phone keeps its line.
  const titled = (title !== undefined && !home && !titleHidden) || Boolean(children) || Boolean(override);
  return (
    <header className={cn("workbench-app-header sticky top-0 z-20 flex shrink-0 items-center border-b border-border/60 bg-muted", !titled && "lg:border-b-transparent")}>
      {override ?? (
        <>
          {mark ? (
            // With the workbench navigation, the sidebar carries the brand on a desktop.
            <CollieHome
              onHome={navigation?.onOpen}
              label={navigation ? "Open navigation" : undefined}
              expanded={navigation?.open}
              lost={lost}
              className="workbench-chat-menu lg:hidden"
            />
          ) : back?.onClick ? (
            <button type="button" onClick={() => { armMotion("pop"); back.onClick?.(); }} aria-label={`Back to ${back.label}`} className={backClass}>
              {icon}{back.inPlace && <span className="text-body">{back.label}</span>}
            </button>
          ) : (
            // A tap goes back to where you came from (useGoBack).
            <StepLink to={parent} go={goBack} aria-label={`Back to ${back?.label ?? "Home"}`} className={backClass}>
              {icon}
            </StepLink>
          )}
          {/* Center region: the title, the route's own content, or on Home an empty flex-1 spacer that
              pushes the right cluster to the edge. min-w-0 so a long title truncates when tight. */}
          <div className="flex min-w-0 flex-1 items-center">
            {title !== undefined && !home && (
              <div
                aria-hidden={titleHidden || undefined}
                className={cn("flex min-w-0 flex-col transition-opacity duration-120 ease-out motion-reduce:duration-120", titleHidden && "opacity-0")}
              >
                <h1 className="truncate text-headline font-semibold lg:text-subhead lg:tracking-normal">{title}</h1>
                {subtitle && <span className="truncate text-footnote text-muted-foreground">{subtitle}</span>}
              </div>
            )}
            {children}
          </div>
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
/** The bar's way to Settings on a phone; a desk reaches it from the sidebar's foot or the rail's. */
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
      className="grid size-11 place-items-center text-muted-foreground transition-colors hover:text-foreground lg:hidden"
    >
      <Settings2 className="size-5" />
    </button>
  );
}
