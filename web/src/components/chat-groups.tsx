import { Link } from "react-router";

import { StatusDot } from "@/components/status-badge";
import { panePath } from "@/lib/nav";
import { groupChats } from "@/lib/projects";
import { paneDisplayName, STATUS_LABEL, type AgentView } from "@/lib/types";

/** Agent chats bucketed by recency (Today / Last 7 days / Older), one quiet row each. */
export function ChatGroups({ panes, session, currentPaneId, now = Date.now(), onNavigate }: {
  panes: readonly AgentView[];
  session?: string;
  currentPaneId?: string;
  now?: number;
  onNavigate?: () => void;
}) {
  return groupChats(panes, now).map((group) => (
    <section key={group.key} aria-label={group.label}>
      <h3 className="nav-label">{group.label}</h3>
      {group.chats.map((pane) => (
        <Link key={pane.paneId} className="nav-row" to={panePath(pane.paneId, session)} onClick={onNavigate}
          aria-current={currentPaneId === pane.paneId ? "page" : undefined}>
          <StatusDot status={pane.status} surface="bg-transparent" className="size-2" />
          <span className="nav-row-text">{paneDisplayName(pane)}</span>
          <span className="sr-only">, {STATUS_LABEL[pane.status]}</span>
        </Link>
      ))}
    </section>
  ));
}
