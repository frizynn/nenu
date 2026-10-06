import { useState } from "react";
import { Link, useParams } from "react-router";
import { FolderKanban, House, Search, Settings, SquarePen } from "lucide-react";

import { ChatGroups } from "@/components/chat-groups";
import { SessionSwitcher } from "@/components/session-switcher";
import { StatusDot } from "@/components/status-badge";
import type { HomeData } from "@/lib/loaders";
import { homePath, projectPath, settingsPath } from "@/lib/nav";
import { chatMatches, looseChats, projectForPane, projectMatches } from "@/lib/projects";
import { STATUS_LABEL } from "@/lib/types";

/** The workbench navigation: new chat, search, projects, then chats by recency. */
export function WorkbenchSidebar({ data, onNavigate, onNewChat }: {
  data: HomeData;
  onNavigate?: () => void;
  onNewChat?: () => void;
}) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const { paneId, projectSlug } = useParams();
  const projects = (data.projects ?? []).filter((project) => projectMatches(project, query));
  const chats = looseChats(data.agents, data.projects).filter((pane) => chatMatches(pane, query));
  const currentProject = projectSlug ?? projectForPane(data.projects, paneId)?.project.slug;

  function closeSearch() {
    setQuery("");
    setSearching(false);
  }

  return (
    <nav className="workbench-navigation" aria-label="Projects and chats">
      <div className="nav-top">
        <button type="button" className="nav-row" onClick={onNewChat} disabled={!onNewChat}><SquarePen aria-hidden size={16} />New chat</button>
        {searching ? (
          <label className="nav-row nav-search">
            <Search aria-hidden size={16} />
            <input type="search" autoFocus value={query} placeholder="Search" aria-label="Search projects and chats"
              onChange={(event) => setQuery(event.target.value)}
              onBlur={() => { if (!query.trim()) closeSearch(); }}
              onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); closeSearch(); } }} />
          </label>
        ) : (
          <button type="button" className="nav-row" onClick={() => setSearching(true)}><Search aria-hidden size={16} />Search</button>
        )}
        <Link className="nav-row" to={homePath(data.session)} onClick={onNavigate}><House aria-hidden size={16} />Home</Link>
      </div>

      <div className="nav-scroll">
        {projects.length > 0 && (
          <section aria-label="Projects">
            <h3 className="nav-label">Projects</h3>
            {projects.map((project) => {
              const status = project.coordinator?.liveStatus;
              return (
                <Link key={project.slug} className="nav-row" to={projectPath(project.slug, data.session)} onClick={onNavigate}
                  aria-current={currentProject === project.slug ? "page" : undefined}>
                  <FolderKanban aria-hidden size={16} />
                  <span className="nav-row-text">{project.name}</span>
                  {status && <StatusDot status={status} surface="bg-transparent" className="ml-auto size-2" />}
                  {status && <span className="sr-only">, coordinator {STATUS_LABEL[status]}</span>}
                </Link>
              );
            })}
          </section>
        )}
        <ChatGroups panes={chats} session={data.session} currentPaneId={paneId} onNavigate={onNavigate} />
        {projects.length + chats.length === 0 && (
          <p className="nav-empty">{query.trim() ? "No matching projects or chats" : "Your agent chats will appear here."}</p>
        )}
      </div>

      <div className="nav-footer">
        <SessionSwitcher sessions={data.sessions ?? []} current={data.session} />
        <Link className="nav-row" to={settingsPath(data.session)} onClick={onNavigate}><Settings aria-hidden size={16} />Settings</Link>
      </div>
    </nav>
  );
}
