import { Link } from "react-router";

import { StatusDot } from "@/components/status-badge";
import { STATUS_LABEL, type AgentStatus } from "@/lib/types";

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
