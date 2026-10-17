import { useState } from "react";
import { Link, useParams } from "react-router";
import { GitPullRequest, Plus } from "@/components/ui/icon";

import { NodeDot } from "@/components/node-row";
import { OpeningMark, PaneMark } from "@/components/nav-rows";
import { ProjectGlyph } from "@/components/project-glyph";
import { StatusDot } from "@/components/status-badge";
import { useHeldTime } from "@/hooks/use-held-time";
import { deskChats, liveliest, projectActivity, projectAgents, type DeskChat } from "@/lib/desk-nav";
import { timeAgo, timeAgoShort } from "@/lib/format";
import type { HomeData } from "@/lib/loaders";
import { nodePath, panePath, projectPath } from "@/lib/nav";
import { ASK, awaits, nodeState, STATE_LABEL } from "@/lib/org-tree";
import { groupByRecency } from "@/lib/projects";
import { STATUS_LABEL, type ProjectView } from "@/lib/types";

/** How many projects, and how many chats, the bar lists before More; the one on screen always shows. */
const PROJECTS_SHOWN = 5;
const CHATS_SHOWN = 12;

/** The first `count` of `items` plus any that `keep` holds, in their order, and how many that leaves out. */
function preview<T>(items: readonly T[], count: number, keep: (item: T) => boolean): { shown: T[]; hidden: number } {
  const shown = items.filter((item, index) => index < count || keep(item));
  return { shown, hidden: items.length - shown.length };
}

/** More under a list, Less once it is open; the rows it brings in fade in (nav.css). */
function MoreRow({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="nav-row nav-more" aria-expanded={open} onClick={onToggle}>
      <span className="nav-lead" aria-hidden /><span className="nav-row-text">{open ? "Less" : "More"}</span>
    </button>
  );
}

/**
 * The desk's lists, drawn as Cursor's agent window draws its own: every project as one row with its
 * glyph, its state and when it last moved; then every chat, in a project or outside one, under the
 * period it last moved in. The tree of workspaces, tabs and History is Search's (workbench-sidebar.tsx).
 */
export function DeskLists({ data, onNewProject }: { data: HomeData; onNewProject?: () => void }) {
  const now = Date.now();
  return <>
    <DeskProjects data={data} now={now} onNewProject={onNewProject} />
    <DeskChats data={data} now={now} />
  </>;
}

function DeskProjects({ data, now, onNewProject }: { data: HomeData; now: number; onNewProject?: () => void }) {
  const { paneId, projectSlug, nodeId } = useParams();
  const [more, setMore] = useState(false);
  const projects = data.projects ?? [];
  const current = (project: ProjectView) => (projectSlug === project.slug && !nodeId) || (paneId !== undefined && paneId === project.coordinator?.paneId);
  const { shown, hidden } = more ? { shown: projects, hidden: 0 } : preview(projects, PROJECTS_SHOWN, current);
  if (!projects.length && !onNewProject) return null;
  return (
    <section aria-label="Projects" className="nav-group nav-desk">
      <div className="nav-label">
        <h3 className="nav-label-text">Projects</h3>
        {onNewProject && <button type="button" className="nav-label-action" aria-label="New project" onClick={onNewProject}><Plus aria-hidden size={14} /></button>}
      </div>
      {shown.map((project, index) => {
        const to = projectPath(project.slug, data.session);
        const status = liveliest(projectAgents(project, data.agents, data.projects));
        const at = projectActivity(project, data.agents);
        return (
          <Link key={project.slug} className="nav-row" to={to} aria-current={current(project) ? "page" : undefined}
            data-revealed={more && index >= PROJECTS_SHOWN ? "" : undefined}>
            <span className="nav-lead"><OpeningMark to={to}><ProjectGlyph slug={project.slug} pick={project} /></OpeningMark></span>
            <span className="nav-row-text">{project.name}</span>
            <span className="nav-row-meta" aria-hidden>
              {status && <StatusDot status={status} surface="bg-transparent" className="size-1.5" />}
              {at > 0 && timeAgoShort(at, now)}
            </span>
            <span className="sr-only">{[status && STATUS_LABEL[status], at > 0 && timeAgo(at, now)].filter(Boolean).map((part) => `, ${part}`).join("")}</span>
          </Link>
        );
      })}
      {(hidden > 0 || more) && <MoreRow open={more} onToggle={() => setMore(!more)} />}
    </section>
  );
}

function DeskChats({ data, now }: { data: HomeData; now: number }) {
  const { paneId, projectSlug, nodeId } = useParams();
  const [more, setMore] = useState(false);
  const isCurrent = (chat: DeskChat) =>
    (chat.paneId !== undefined && chat.paneId === paneId) || (chat.project === projectSlug && chat.thread?.id === nodeId && nodeId !== undefined);
  // Each chat keeps the place it had when the bar drew it, so a row never moves under the pointer; one
  // that turns +1 moves up to say so.
  const at = useHeldTime((chat: DeskChat) => chat.key, (chat) => chat.at, (chat) => chat.unread);
  const chats = deskChats(data).sort((a, b) => at(b) - at(a));
  const { shown, hidden } = more ? { shown: chats, hidden: 0 } : preview(chats, CHATS_SHOWN, isCurrent);
  const revealed = new Set(more ? chats.slice(CHATS_SHOWN).map((chat) => chat.key) : []);
  return (
    <section aria-label="Chats" className="nav-desk nav-chats">
      {groupByRecency(shown, at, now).map((group) => (
        <section key={group.key} aria-label={group.label} className="nav-group">
          <h3 className="nav-label">{group.label}</h3>
          {group.items.map((chat) => <ChatRow key={chat.key} chat={chat} session={data.session} current={isCurrent(chat)} revealed={revealed.has(chat.key)} />)}
        </section>
      ))}
      {(hidden > 0 || more) && <MoreRow open={more} onToggle={() => setMore(!more)} />}
    </section>
  );
}

/**
 * A chat: its state as a small dot, its one name, a quiet +1 when it finished or asked for you since
 * you last opened it (the desk's answer to an agent finishing elsewhere, instead of a toast), and a
 * pull request's glyph when it has one open.
 */
function ChatRow({ chat, session, current, revealed }: { chat: DeskChat; session?: string; current: boolean; revealed: boolean }) {
  const { thread, pane } = chat;
  const to = chat.paneId ? panePath(chat.paneId, session) : nodePath(chat.project!, thread!.id, session);
  const state = thread ? nodeState(thread) : undefined;
  const ask = thread ? awaits(thread) : undefined;
  const word = ask ? ASK[ask].word : state ? STATE_LABEL[state].toLowerCase() : pane && STATUS_LABEL[pane.status];
  const pr = thread?.pr && (thread.pr.state === "open" || thread.pr.state === "draft") ? thread.pr : undefined;
  return (
    <Link className="nav-row" to={to} aria-current={current ? "page" : undefined} data-revealed={revealed ? "" : undefined}>
      <span className="nav-lead">
        <OpeningMark to={to}>{state ? <NodeDot state={state} className="size-1.5" /> : pane && <PaneMark pane={pane} />}</OpeningMark>
      </span>
      <span className="nav-row-text">{chat.title}</span>
      {word && <span className="sr-only">, {word}</span>}
      {chat.unread && !current && <span className="nav-unread" data-unread aria-hidden>+1</span>}
      {pr && <>
        <span className="nav-row-end" aria-hidden><GitPullRequest size={14} /></span>
        <span className="sr-only">, pull request{pr.number ? ` #${pr.number}` : ""}</span>
      </>}
      {chat.unread && !current && <span className="sr-only">, new</span>}
    </Link>
  );
}
