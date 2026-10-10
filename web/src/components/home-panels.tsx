import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ChevronRight, Workflow } from "lucide-react";

import { AgentBar, StateDot } from "@/components/activity/activity-parts";
import { StatusDot } from "@/components/status-badge";
import { agentElapsed, allAgents, formatDuration, workflowElapsed, type ActivityWorkflow } from "@/lib/activity";
import { timeAgoShort } from "@/lib/format";
import type { RecentChat } from "@/lib/home-stats";
import { panePath } from "@/lib/nav";
import { STATUS_LABEL, type AgentStatus, type AgentView } from "@/lib/types";
import { cn } from "@/lib/utils";

/** A Home section's heading: its name, how many, and an optional note at the far end. */
export function HomeHeading({ id, label, count, note }: { id: string; label: string; count?: number; note?: ReactNode }) {
  return (
    <h2 id={id} className="flex items-center gap-2 text-[12.5px] font-medium text-muted-foreground">
      <span className="text-foreground/85">{label}</span>
      {count !== undefined && count > 0 && <span className="tabular-nums">{count}</span>}
      {note && <span className="ml-auto flex items-center gap-1.5 font-normal">{note}</span>}
    </h2>
  );
}

/** A Home list: its first `rows` items, and the rest behind "Show all". */
export function FoldedList<T>({ items, rows, children }: { items: readonly T[]; rows: number; children: (item: T) => ReactNode }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, rows);
  return <>
    <ul className="flex flex-col max-sm:divide-y max-sm:divide-border">{shown.map(children)}</ul>
    {items.length > shown.length && (
      <button type="button" onClick={() => setAll(true)} className="self-start px-1 py-2 text-[13px] font-medium text-muted-foreground hover:text-foreground sm:px-3.5">
        Show all {items.length}
      </button>
    )}
  </>;
}

/** How many chats Recent lists before "Show all". */
export const RECENT_ROWS = 6;

const STATUS_TEXT: Partial<Record<AgentStatus, string>> = { working: "text-status-working", done: "text-status-done" };

function RecentRow({ chat, session, now }: { chat: RecentChat; session?: string; now: number }) {
  const { agent, title, where, at, unseen } = chat;
  const status = STATUS_LABEL[agent.status];
  return (
    <li>
      <Link to={panePath(agent.paneId, session)}
        className="grid min-h-13 min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 px-1 py-1.5 hover:bg-[var(--workbench-row-hover)] sm:rounded-[10px] sm:px-3.5">
        <StatusDot status={agent.status} className="row-span-2 size-2" />
        <span className="col-start-2 flex min-w-0 items-center gap-1.5">
          <span className={cn("truncate text-[13.5px] leading-tight", unseen && "font-semibold")}>{title}</span>
          {unseen && <span className="shrink-0 rounded border border-status-done/50 px-1 text-[11px] leading-4 text-status-done">New</span>}
        </span>
        <span className="col-start-2 row-start-2 truncate text-xs leading-tight text-muted-foreground">
          <span className={STATUS_TEXT[agent.status]}>{status.charAt(0).toUpperCase() + status.slice(1)}</span>
          {where && ` · ${where}`}
        </span>
        <span className="col-start-3 row-span-2 row-start-1 text-xs text-muted-foreground tabular-nums">{at > 0 && timeAgoShort(at, now)}</span>
      </Link>
    </li>
  );
}

/**
 * Home's "Recent": the chats that moved or were opened last, each one tap from its thread, with how
 * many agents are working right now. "New" marks one that finished since you last opened it.
 */
export function RecentChats({ chats, working, session, now }: { chats: readonly RecentChat[]; working: number; session?: string; now: number }) {
  if (!chats.length) return null;
  return (
    <section aria-labelledby="home-recent" className="flex flex-col gap-1.5">
      <HomeHeading id="home-recent" label="Recent"
        note={working > 0 && <><StatusDot status="working" className="size-1.5" />{working} working now</>} />
      <FoldedList items={chats} rows={RECENT_ROWS}>
        {(chat) => <RecentRow key={chat.agent.paneId} chat={chat} session={session} now={now} />}
      </FoldedList>
    </section>
  );
}

/** A workflow still running, with how far its agents got. */
export function RunningWorkCard({ paneId, workflow, agent, session, now }: { paneId: string; workflow: ActivityWorkflow; agent?: AgentView; session?: string; now: number }) {
  const agents = allAgents(workflow);
  const running = agents.filter((a) => a.state === "running").slice(0, 3);
  const elapsed = formatDuration(workflowElapsed(workflow, now));
  return (
    <Link to={panePath(paneId, session)} className="flex min-w-0 flex-col gap-2.5 rounded-xl border border-border bg-card p-3.5 hover:bg-card/80">
      <span className="flex min-w-0 items-center gap-2.5">
        <Workflow aria-hidden className="size-4 shrink-0 text-status-working" />
        <span className="flex min-w-0 flex-1 flex-col leading-snug">
          <span className="truncate text-[13.5px] font-semibold">{workflow.name}</span>
          <span className="truncate text-[11.5px] text-muted-foreground">{[agent?.workspaceLabel, elapsed].filter(Boolean).join(" · ")}</span>
        </span>
        <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </span>
      <AgentBar states={agents.map((a) => a.state)} />
      {running.length > 0 && (
        <span className="flex flex-col gap-1">
          {running.map((a) => (
            <span key={a.id} className="flex items-center gap-2 text-xs">
              <StateDot state="running" />
              <span className="min-w-0 flex-1 truncate text-foreground/85">{a.label}</span>
              <span className="shrink-0 text-muted-foreground tabular-nums">{formatDuration(agentElapsed(a, now))}</span>
            </span>
          ))}
        </span>
      )}
      <span className="text-[11.5px] text-muted-foreground">{workflow.doneCount} of {workflow.agentCount} agents done</span>
    </Link>
  );
}
