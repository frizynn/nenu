import { Link } from "react-router";
import { House, Inbox, Layers, Plus, Search } from "lucide-react";

/** Which tab reads as selected: a sheet the bar opened, else Home while Home is on screen. */
export type TabBarTab = "home" | "needs-you" | "browse" | "search" | null;

/** The phone's primary navigation: Home, Needs you, New in the middle, Browse and Search. */
export function BottomTabBar({ active, homeTo, attention, onNeedsYou, onNew, onBrowse, onSearch }: {
  active: TabBarTab;
  homeTo: string;
  /** How many panes are waiting on the operator; the badge hides at zero. */
  attention: number;
  onNeedsYou: () => void;
  /** Absent while creating is not allowed (read-only device, no connection). */
  onNew?: () => void;
  onBrowse: () => void;
  onSearch: () => void;
}) {
  return (
    <nav className="bottom-tab-bar" aria-label="Primary">
      <Link className="bottom-tab" to={homeTo} aria-current={active === "home" ? "page" : undefined}>
        <House aria-hidden size={22} strokeWidth={1.6} />Home
      </Link>
      <button type="button" className="bottom-tab" aria-pressed={active === "needs-you"} onClick={onNeedsYou}
        aria-label={attention > 0 ? `Needs you, ${attention}` : "Needs you"}>
        <Inbox aria-hidden size={22} strokeWidth={1.6} />Needs you
        {attention > 0 && <span className="bottom-tab-badge" aria-hidden>{attention}</span>}
      </button>
      <button type="button" className="bottom-tab-new" aria-label="New" onClick={onNew} disabled={!onNew}>
        <Plus aria-hidden size={22} strokeWidth={2} />
      </button>
      <button type="button" className="bottom-tab" aria-pressed={active === "browse"} onClick={onBrowse}>
        <Layers aria-hidden size={22} strokeWidth={1.6} />Browse
      </button>
      <button type="button" className="bottom-tab" aria-pressed={active === "search"} onClick={onSearch}>
        <Search aria-hidden size={22} strokeWidth={1.6} />Search
      </button>
    </nav>
  );
}
