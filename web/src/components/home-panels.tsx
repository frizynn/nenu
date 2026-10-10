import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { ChevronRight, FolderKanban, LayoutGrid, Search, Workflow } from "lucide-react";

import { AgentBar, StateDot } from "@/components/activity/activity-parts";
import { StatusDot } from "@/components/status-badge";
import { agentElapsed, allAgents, formatDuration, workflowElapsed, type ActivityWorkflow } from "@/lib/activity";
import { timeAgoShort } from "@/lib/format";
import { jumpTargets, type JumpTarget } from "@/lib/home-stats";
import { panePath, projectPath, spacePath } from "@/lib/nav";
import { paneDisplayName, STATUS_LABEL, type AgentView, type ProjectView, type WorkspaceView } from "@/lib/types";

/** Projects and chats by recency, found by typing; ⌘K (the shell's) focuses it and Enter opens the first match. */
export function QuickJump({ agents, projects, session, now }: { agents: AgentView[]; projects?: ProjectView[]; session?: string; now: number }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const targets = query.trim() ? jumpTargets(agents, projects, query) : [];
  const pathOf = (target: JumpTarget) => target.kind === "project" ? projectPath(target.id, session) : panePath(target.id, session);

  if (!agents.length && !projects?.length) return null;
  return (
    <section aria-labelledby="home-jump">
      <h2 id="home-jump" className="sr-only">Jump to</h2>
      <label className="home-search">
        <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <input type="search" aria-keyshortcuts="Meta+K" value={query} placeholder="Jump to a project or chat" aria-label="Jump to a project or chat"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && targets[0]) navigate(pathOf(targets[0]));
            if (event.key === "Escape") setQuery("");
          }} />
        <kbd className="hidden shrink-0 rounded border border-border px-1.5 font-sans text-[11px] text-muted-foreground lg:inline">⌘K</kbd>
      </label>
      {targets.length > 0 && <ul className="mt-2">
        {targets.map((target) => (
          <li key={`${target.kind}:${target.id}`}>
            <Link to={pathOf(target)} className="home-row">
              {target.kind === "project"
                ? <FolderKanban aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                : <span className="flex size-4 shrink-0 items-center justify-center">{target.status && <StatusDot status={target.status} surface="bg-card" className="size-2" />}</span>}
              <span className="min-w-0 flex-1 truncate">
                {target.label}{" "}
                <span className="text-muted-foreground">· {target.detail}</span>
              </span>
              {target.status && <span className="sr-only">, {STATUS_LABEL[target.status]}</span>}{" "}
              {target.ts > 0 && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{timeAgoShort(target.ts, now)}</span>}
            </Link>
          </li>
        ))}
      </ul>}
      {query.trim() && targets.length === 0 && <p className="px-2 py-3 text-sm text-muted-foreground">No matching projects or chats</p>}
    </section>
  );
}

/** A workspace outside every project: its agents as chips, each one tap from its chat. */
export function WorkspaceSummary({ workspace, agents, session }: { workspace: WorkspaceView; agents: readonly AgentView[]; session?: string }) {
  const tabs = workspace.tabCount;
  return (
    <li className="flex min-w-0 flex-col gap-2 px-1 sm:rounded-[10px] py-2.5 sm:px-3">
      <Link to={spacePath(workspace.workspaceId, session)} className="flex min-w-0 items-center gap-2 text-[13px]">
        <LayoutGrid aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">{workspace.label}</span>
        <span className="shrink-0 text-[11.5px] text-muted-foreground tabular-nums">{tabs} {tabs === 1 ? "tab" : "tabs"}</span>
      </Link>
      {agents.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {agents.map((agent) => (
            <li key={agent.paneId} className="min-w-0">
              <Link to={panePath(agent.paneId, session)}
                className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-[7px] bg-muted px-2.5 text-xs text-foreground/85 hover:bg-muted/70 max-lg:h-9">
                <StatusDot status={agent.status} surface="bg-muted" className="size-1.5" />
                <span className="truncate">{paneDisplayName(agent)}</span>
                <span className="sr-only">, {STATUS_LABEL[agent.status]}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </li>
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
