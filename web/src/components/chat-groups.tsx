import { Link } from "react-router";

import { StatusDot } from "@/components/status-badge";
import { panePath } from "@/lib/nav";
import { groupChats, paneTitle, projectForPane } from "@/lib/projects";
import { STATUS_LABEL, type AgentStatus, type AgentView, type ProjectView } from "@/lib/types";

/** One quiet sidebar row: a status dot, a title and, optionally, where it belongs. */
export function NavRow({ to, status, title, note, current, nested, onNavigate }: {
  to: string;
  status: AgentStatus;
  title: string;
  note?: string;
  current?: boolean;
  nested?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link className={nested ? "nav-row nav-row-nested" : "nav-row"} to={to} onClick={onNavigate} aria-current={current ? "page" : undefined}>
      <StatusDot status={status} surface="bg-transparent" className="size-2" />
      <span className="nav-row-text">{title}</span>
      {note && <span className="nav-row-note">{note}</span>}
      <span className="sr-only">, {STATUS_LABEL[status]}</span>
    </Link>
  );
}

/** Agent chats bucketed by recency (Today / Last 7 days / Older); a project's panes say which project. */
export function ChatGroups({ panes, projects, session, currentPaneId, now = Date.now(), onNavigate }: {
  panes: readonly AgentView[];
  projects?: readonly ProjectView[];
  session?: string;
  currentPaneId?: string;
  now?: number;
  onNavigate?: () => void;
}) {
  return groupChats(panes, now).map((group) => (
    <section key={group.key} aria-label={group.label}>
      <h3 className="nav-label">{group.label}</h3>
      {group.chats.map((pane) => {
        const owner = projectForPane(projects, pane.paneId);
        return (
          <NavRow key={pane.paneId} to={panePath(pane.paneId, session)} status={pane.status} title={paneTitle(pane, owner)}
            note={owner?.project.name} current={currentPaneId === pane.paneId} onNavigate={onNavigate} />
        );
      })}
    </section>
  ));
}
