import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { FolderKanban, Search } from "lucide-react";

import { StatusDot } from "@/components/status-badge";
import { timeAgoShort } from "@/lib/format";
import { jumpTargets, type JumpTarget } from "@/lib/home-stats";
import { panePath, projectPath } from "@/lib/nav";
import { triage } from "@/lib/triage";
import { paneDisplayName, STATUS_LABEL, type AgentView, type ProjectView } from "@/lib/types";

/** Needs you, ready and working agents, each one tap from its chat, with how long it has been so. */
export function LiveCard({ agents, session, now }: { agents: AgentView[]; session?: string; now: number }) {
  const sections = triage(agents).filter((section) => section.key !== "recent" && section.agents.length);
  const idle = agents.length - sections.reduce((sum, section) => sum + section.agents.length, 0);
  return (
    <section aria-labelledby="home-live" className="home-card">
      <div className="home-card-head">
        <h2 id="home-live">Live</h2>
        {idle > 0 && <span>{idle} idle</span>}
      </div>
      {sections.length === 0 && <p className="mt-3 text-sm text-muted-foreground">{agents.length ? "Nothing needs you right now." : "Agents you start show up here while they work."}</p>}
      {sections.map((section) => (
        <div key={section.key} className="mt-3 first-of-type:mt-2">
          <h3 className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
            {section.label}<span className="tabular-nums">{section.agents.length}</span>
          </h3>
          <ul>
            {section.agents.map((agent) => (
              <li key={agent.paneId}>
                <Link to={panePath(agent.paneId, session)} className="home-row">
                  <StatusDot status={agent.status} surface="bg-card" className="size-2" />
                  <span className="min-w-0 flex-1 truncate">
                    {paneDisplayName(agent)}{" "}
                    <span className="text-muted-foreground">· {agent.workspaceLabel}</span>
                  </span>
                  <span className="sr-only">, {STATUS_LABEL[agent.status]}</span>{" "}
                  {agent.lastActiveAt ? <span className="shrink-0 text-xs text-muted-foreground tabular-nums" title={`Since ${new Date(agent.lastActiveAt).toLocaleTimeString()}`}>{timeAgoShort(agent.lastActiveAt, now)}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

const JUMP_PREVIEW = 6;

/** Projects and chats by recency, filterable; ⌘K focuses the filter and Enter opens the first match. */
export function QuickJump({ agents, projects, session, now }: { agents: AgentView[]; projects?: ProjectView[]; session?: string; now: number }) {
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const targets = jumpTargets(agents, projects, query);
  const shown = query.trim() || expanded ? targets : targets.slice(0, JUMP_PREVIEW);
  const pathOf = (target: JumpTarget) => target.kind === "project" ? projectPath(target.id, session) : panePath(target.id, session);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      input.current?.focus();
      input.current?.select();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!agents.length && !projects?.length) return null;
  return (
    <section aria-labelledby="home-jump" className="home-card">
      <h2 id="home-jump" className="sr-only">Jump to</h2>
      <label className="home-search">
        <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <input ref={input} type="search" value={query} placeholder="Jump to a project or chat" aria-label="Jump to a project or chat"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && targets[0]) navigate(pathOf(targets[0]));
            if (event.key === "Escape") setQuery("");
          }} />
        <kbd className="hidden shrink-0 rounded border border-border px-1.5 font-sans text-[11px] text-muted-foreground lg:inline">⌘K</kbd>
      </label>
      <ul className="mt-2">
        {shown.map((target) => (
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
      </ul>
      {query.trim() && targets.length === 0 && <p className="px-2 py-3 text-sm text-muted-foreground">No matching projects or chats</p>}
      {!query.trim() && targets.length > JUMP_PREVIEW && (
        <button type="button" className="quiet-action mt-1" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show fewer" : `Show all ${targets.length}`}
        </button>
      )}
    </section>
  );
}
