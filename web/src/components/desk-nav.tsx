import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { ChevronDown, GitPullRequest, GitPullRequestDraft, Plus } from "@/components/ui/icon";

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

/** Which of `items` More folds away: past the first `count`, unless `keep` holds them in view. */
function folded<T>(items: readonly T[], count: number, keep: (item: T) => boolean): Set<T> {
  return new Set(items.filter((item, index) => index >= count && !keep(item)));
}

/**
 * Rows More folds stay mounted: their height closes to nothing and opens back the same way, so folding
 * and unfolding read as one motion (nav.css). Folded, they leave the tab order and the accessibility tree.
 */
function Reveal({ folded, children }: { folded: boolean; children: ReactNode }) {
  return (
    <div className="nav-reveal" data-folded={folded ? "" : undefined} inert={folded} aria-hidden={folded || undefined}>
      <div className="nav-reveal-inner">{children}</div>
    </div>
  );
}

/** Says how many rows it brings in, and folds them back once they are in. */
function MoreRow({ open, hidden, onToggle }: { open: boolean; hidden: number; onToggle: () => void }) {
  return (
    <button type="button" className="nav-row nav-more" aria-expanded={open} onClick={onToggle}>
      <span className="nav-lead" aria-hidden><ChevronDown size={14} className="nav-more-chevron" /></span>
      <span className="nav-row-text">{open ? "Show less" : `Show ${hidden} more`}</span>
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
  const extra = folded(projects, PROJECTS_SHOWN, current);
  if (!projects.length && !onNewProject) return null;
  return (
    <section aria-label="Projects" className="nav-group nav-desk">
      <div className="nav-label">
        <h3 className="nav-label-text">Projects</h3>
        {onNewProject && <button type="button" className="nav-label-action" aria-label="New project" onClick={onNewProject}><Plus aria-hidden size={14} /></button>}
      </div>
      {projects.map((project) => {
        const to = projectPath(project.slug, data.session);
        const status = liveliest(projectAgents(project, data.agents, data.projects));
        const at = projectActivity(project, data.agents);
        return (
          <Reveal key={project.slug} folded={!more && extra.has(project)}>
          <Link className="nav-row" to={to} aria-current={current(project) ? "page" : undefined}>
            <span className="nav-lead"><OpeningMark to={to}><ProjectGlyph slug={project.slug} pick={project} /></OpeningMark></span>
            <span className="nav-row-text">{project.name}</span>
            <span className="nav-row-meta" aria-hidden>
              {status && <StatusDot status={status} surface="bg-transparent" />}
              {at > 0 && timeAgoShort(at, now)}
            </span>
            <span className="sr-only">{[status && STATUS_LABEL[status], at > 0 && timeAgo(at, now)].filter(Boolean).map((part) => `, ${part}`).join("")}</span>
          </Link>
          </Reveal>
        );
      })}
      {extra.size > 0 && <MoreRow open={more} hidden={extra.size} onToggle={() => setMore(!more)} />}
    </section>
  );
}

/** A chat that waits on you: past More it still shows, after the rows on screen, so nothing moves to say it. */
const needsYou = (chat: DeskChat) => chat.pane?.status === "blocked" || (chat.thread !== undefined && awaits(chat.thread) !== undefined);

function DeskChats({ data, now }: { data: HomeData; now: number }) {
  const { paneId, projectSlug, nodeId } = useParams();
  const [more, setMore] = useState(false);
  const isCurrent = (chat: DeskChat) =>
    (chat.paneId !== undefined && chat.paneId === paneId) || (chat.project === projectSlug && chat.thread?.id === nodeId && nodeId !== undefined);
  // Each chat keeps the place it had when the bar drew it, so a row never moves under the pointer: one
  // that finishes says +1 where it is. "N updates" puts them in order, as coming back to the window does.
  const held = useHeldTime((chat: DeskChat) => chat.key, (chat) => chat.at);
  const chats = held.order(deskChats(data));
  const updates = held.moved(chats);
  const extra = folded(chats, CHATS_SHOWN, (chat) => isCurrent(chat) || needsYou(chat));
  const hides = (chat: DeskChat) => !more && extra.has(chat);
  return (
    <section aria-label="Chats" className="nav-desk nav-chats">
      {groupByRecency(chats, held.at, now).map((group, index) => (
        <Reveal key={group.key} folded={group.items.every(hides)}>
          <section aria-label={group.label} className="nav-group">
            {index === 0
              ? <div className="nav-label">
                <h3 className="nav-label-text">{group.label}</h3>
                {updates > 0 && <button type="button" className="nav-label-updates" onClick={held.reorder}>{updates} {updates === 1 ? "update" : "updates"}</button>}
              </div>
              : <h3 className="nav-label">{group.label}</h3>}
            {group.items.map((chat) => (
              <Reveal key={chat.key} folded={hides(chat)}>
                <ChatRow chat={chat} session={data.session} current={isCurrent(chat)} />
              </Reveal>
            ))}
          </section>
        </Reveal>
      ))}
      {extra.size > 0 && <MoreRow open={more} hidden={extra.size} onToggle={() => setMore(!more)} />}
    </section>
  );
}

type ThreadPr = NonNullable<NonNullable<DeskChat["thread"]>["pr"]>;

/** An open pull request's glyph, its tone and the words a screen reader hears for both; a draft first, whatever its checks say. */
function prMark(pr: ThreadPr): { glyph: typeof GitPullRequest; tone?: "failing" | "approved"; word?: string } {
  if (pr.state === "draft") return { glyph: GitPullRequestDraft, word: "draft" };
  if (pr.checks?.failed) return { glyph: GitPullRequest, tone: "failing", word: "checks failing" };
  if (pr.review === "changes_requested") return { glyph: GitPullRequest, tone: "failing", word: "changes requested" };
  if (pr.review === "approved" && !pr.checks?.pending) return { glyph: GitPullRequest, tone: "approved", word: "approved" };
  return { glyph: GitPullRequest };
}

/**
 * A chat: its state as a small dot, its one name, a quiet +1 when it finished or asked for you since
 * you last opened it (the desk's answer to an agent finishing elsewhere, instead of a toast), and a
 * pull request's glyph when it has one open: a draft's own glyph, red while checks fail or changes
 * are asked, green once approved, grey otherwise.
 */
function ChatRow({ chat, session, current }: { chat: DeskChat; session?: string; current: boolean }) {
  const { thread, pane } = chat;
  const to = chat.paneId ? panePath(chat.paneId, session) : nodePath(chat.project!, thread!.id, session);
  const state = thread ? nodeState(thread) : undefined;
  const ask = thread ? awaits(thread) : undefined;
  const word = ask ? ASK[ask].word : state ? STATE_LABEL[state].toLowerCase() : pane && STATUS_LABEL[pane.status];
  const pr = thread?.pr && (thread.pr.state === "open" || thread.pr.state === "draft") ? thread.pr : undefined;
  const mark = pr && prMark(pr);
  return (
    <Link className="nav-row" to={to} aria-current={current ? "page" : undefined}>
      <span className="nav-lead">
        <OpeningMark to={to}>{state ? <NodeDot state={state} /> : pane && <PaneMark pane={pane} />}</OpeningMark>
      </span>
      <span className="nav-row-text">{chat.title}</span>
      {word && <span className="sr-only">, {word}</span>}
      {chat.unread && !current && <span className="nav-unread" data-unread aria-hidden>+1</span>}
      {pr && mark && <>
        <span className="nav-row-end" data-pr={mark.tone} aria-hidden><mark.glyph size={14} /></span>
        <span className="sr-only">, pull request{pr.number ? ` #${pr.number}` : ""}{mark.word ? `, ${mark.word}` : ""}</span>
      </>}
      {chat.unread && !current && <span className="sr-only">, new</span>}
    </Link>
  );
}
