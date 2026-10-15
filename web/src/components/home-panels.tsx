import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Link, useNavigation } from "react-router";
import { ChevronDown, ChevronRight, FolderPlus, LayoutGrid, ListFilter, Pending, Sparkle, Workflow, type IconComponent } from "@/components/ui/icon";

import { AgentBar, StateDot } from "@/components/activity/activity-parts";
import { AgentIcon } from "@/components/agent-icon";
import { DiffStat } from "@/components/diff-stat";
import { PaneMark } from "@/components/nav-rows";
import { useMediaQuery } from "@/hooks/use-media-query";
import { agentElapsed, allAgents, workflowElapsed, type ActivityWorkflow } from "@/lib/activity";
import { timeAgo, timeAgoShort } from "@/lib/format";
import type { RecentChat, ReviewEntry, WorkspaceChats } from "@/lib/home-stats";
import { panePath } from "@/lib/nav";
import { ASK } from "@/lib/org-tree";
import { projectForPane } from "@/lib/projects";
import { STATUS_LABEL, type AgentStatus, type AgentView, type ProjectView } from "@/lib/types";
import { cn } from "@/lib/utils";

/** How long a tap's navigation may run before its row says it is opening, so a fast read never flashes. */
export const OPENING_MS = 120;

/**
 * The path a navigation is loading (no query), once it has run for OPENING_MS; null otherwise. The
 * pane route waits for its read, so over a slow link the tapped row is the only place to say so.
 * Home reads it once and hands it to every list.
 */
export function useOpeningPath(): string | null {
  const navigation = useNavigation();
  const loading = navigation.state === "loading" ? navigation.location.pathname : null;
  const [late, setLate] = useState<string | null>(null);
  useEffect(() => {
    // Forget a finished load, so tapping the same row again waits its own 120ms.
    if (!loading) return setLate(null);
    const timer = setTimeout(() => setLate(loading), OPENING_MS);
    return () => clearTimeout(timer);
  }, [loading]);
  return loading !== null && late === loading ? loading : null;
}

/** Whether `to` (a path with an optional query) is the one opening. */
export const isOpening = (opening: string | null, to: string) => opening !== null && opening === to.split("?")[0];

/** The 16px spinner an opening row shows in place of its trailing mark (static under reduced motion). */
export function OpeningSpinner({ className }: { className?: string }) {
  return <Pending aria-hidden className={cn("size-4 shrink-0 text-muted-foreground", className)} />;
}

/** A button's label that a spinner covers while its action runs, so the button keeps its width. */
export function BusyLabel({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <span className="relative inline-flex items-center justify-center">
      <span className={cn(busy && "opacity-0")}>{children}</span>
      {busy && <OpeningSpinner className="absolute text-current" />}
    </span>
  );
}

/** A Home section's heading: its name, how many, and an optional note at the far end. */
export function HomeHeading({ id, label, count, note }: { id: string; label: string; count?: number; note?: ReactNode }) {
  return (
    <h2 id={id} className="flex items-center gap-2 text-footnote font-medium text-muted-foreground">
      <span className="text-foreground">{label}</span>
      {count !== undefined && count > 0 && <span className="tabular-nums">{count}</span>}
      {note && <span className="ml-auto flex items-center gap-1.5 font-normal">{note}</span>}
    </h2>
  );
}

/**
 * A Home list: its first `rows` items, and the rest behind "Show all". With `group`, items already
 * ordered by group show under each group's name.
 */
export function FoldedList<T>({ items, rows, group, children }: { items: readonly T[]; rows: number; group?: (item: T) => string; children: (item: T) => ReactNode }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, rows);
  const runs: Array<{ label?: string; items: T[] }> = [];
  for (const item of shown) {
    const label = group?.(item);
    const last = runs.at(-1);
    if (last && last.label === label) last.items.push(item);
    else runs.push({ label, items: [item] });
  }
  return <>
    {runs.map((run) => <Fragment key={run.label ?? ""}>
      {run.label && <h3 className="px-1 pt-2 text-caption font-medium text-muted-foreground first:pt-0 sm:px-2.5">{run.label}</h3>}
      <ul className="flex flex-col max-sm:divide-y max-sm:divide-border">{run.items.map(children)}</ul>
    </Fragment>)}
    {items.length > shown.length && (
      <button type="button" onClick={() => setAll(true)} className="inline-flex min-h-9 items-center self-start px-1 text-footnote font-medium text-muted-foreground hover:text-foreground coarse:min-h-11 sm:px-2.5">
        Show all {items.length}
      </button>
    )}
  </>;
}

const DESK = "(min-width: 1024px)";

/** How many sessions Recents lists before "Show all". */
export const RECENT_ROWS = 6;

// A state's word takes its colour on a phone only: a desk keeps the word grey and the colour to the row's
// mark, as Cursor keeps it to the dot or the icon.
const STATUS_TEXT: Partial<Record<AgentStatus, string>> = { working: "max-lg:text-status-working", done: "max-lg:text-status-done" };

const sr = (text: string) => <span className="sr-only">{text}</span>;

/** The state word a row leads its second line with, and its colour. */
function stateOf(chat: RecentChat): { word: string; tone?: string } {
  if (chat.agent.kind === "shell") return { word: "Shell" };
  if (chat.ask === "reply") return { word: ASK.reply.label, tone: "max-lg:text-status-blocked" };
  if (chat.review) return { word: "Ready to review", tone: "max-lg:text-primary" };
  const status = STATUS_LABEL[chat.agent.status];
  return { word: status.charAt(0).toUpperCase() + status.slice(1), tone: STATUS_TEXT[chat.agent.status] };
}

/**
 * Title, then state, place and what tells it apart (its PR, its role or its tab); the place gives up
 * width first. A desk adds the PR's size and the agent. `group` is the name the row sits under, which
 * it then leaves out.
 */
function SessionRow({ chat, session, now, opening, group }: { chat: RecentChat; session?: string; now: number; opening: string | null; group?: string }) {
  const { agent, title, detail, diff, at, unseen } = chat;
  const place = chat.place === group ? null : chat.place;
  const state = stateOf(chat);
  const to = panePath(agent.paneId, session);
  const busy = isOpening(opening, to);
  return (
    <li>
      <Link to={to} aria-busy={busy || undefined}
        className={cn("relative grid min-h-14 min-w-0 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-3 px-1 py-2 hover:bg-[var(--workbench-row-hover)] sm:min-h-12 sm:rounded-lg sm:px-2.5",
          busy && "bg-[var(--workbench-row-hover)]")}>
        <span className="row-span-2 flex justify-center text-muted-foreground"><PaneMark pane={agent} /></span>
        <span className="col-start-2 flex min-w-0 items-center gap-1.5">
          <span className={cn("truncate text-body sm:text-subhead", unseen && "font-semibold")}>{title}</span>
          {unseen && <>{sr(", ")}<span className="shrink-0 rounded-sm border border-status-done/50 px-1 text-micro text-status-done">New</span></>}
        </span>
        <span className="col-start-2 row-start-2 flex min-w-0 items-baseline gap-1 text-footnote text-muted-foreground">
          {sr(", ")}
          <span className={cn("shrink-0", state.tone)}>{state.word}</span>
          {place && <><span aria-hidden className="shrink-0">·</span>{sr(", ")}<span className={cn("truncate", detail ? "max-w-[45%] shrink" : "min-w-0 flex-1")}>{place}</span></>}
          {detail && <><span aria-hidden className="shrink-0">·</span>{sr(", ")}<span className="min-w-0 flex-1 truncate">{detail}</span></>}
        </span>
        <span className="col-start-3 row-span-2 row-start-1 flex items-center gap-3 text-footnote text-muted-foreground">
          {diff && <>{sr(", ")}<DiffStat diff={diff} className="text-caption max-sm:hidden" /></>}
          {agent.kind !== "shell" && <span aria-hidden className="max-sm:hidden"><AgentIcon agent={agent.agent} className="size-4" /></span>}
          {busy
            ? <OpeningSpinner />
            : at > 0 && <span className="min-w-8 text-right tabular-nums">{sr(", ")}<span aria-hidden>{timeAgoShort(at, now)}</span>{sr(timeAgo(at, now))}</span>}
        </span>
      </Link>
    </li>
  );
}

export type SessionList = "recents" | "workspaces" | "prs";

const LISTS: ReadonlyArray<[SessionList, string]> = [["recents", "Recents"], ["workspaces", "Workspaces"], ["prs", "PRs"]];
const LIST_KEY = "nenu:home-list:v1";

function readList(): SessionList {
  try {
    const list = localStorage.getItem(LIST_KEY);
    return list === "workspaces" || list === "prs" ? list : "recents";
  } catch {
    return "recents";
  }
}
function rememberList(list: SessionList): void {
  try {
    localStorage.setItem(LIST_KEY, list);
  } catch {
    /* Private mode or a full quota: the choice just isn't remembered. */
  }
}

/** How a workspace reads at a glance: the most pressing state among its sessions, in their own words. */
const WORKSPACE_STATES = [ASK.reply.label, STATUS_LABEL.blocked, STATUS_LABEL.working, "Ready to review", STATUS_LABEL.done, STATUS_LABEL.idle, "Shell"]
  .map((word) => word.charAt(0).toUpperCase() + word.slice(1));

function workspaceState(chats: readonly RecentChat[]): { word: string; tone?: string } {
  const states = chats.map(stateOf);
  const word = WORKSPACE_STATES.find((candidate) => states.some((state) => state.word === candidate));
  // A thread waiting for your reply needs you as much as a dialog does, and both say it in red.
  if (word === WORKSPACE_STATES[0] || word === WORKSPACE_STATES[1]) return { word: WORKSPACE_STATES[1]!, tone: "max-lg:text-status-blocked" };
  return states.find((state) => state.word === word) ?? { word: "Empty" };
}

/**
 * A Herdr workspace as one row: its name, how it is and how many sessions it holds. A tap opens it in
 * place on its sessions, each the row Recents draws; its tabs are what tells those rows apart, never
 * rows of their own. A workspace of one tab has nothing to unfold: the tap opens its `entry` pane.
 */
function WorkspaceRow({ group, now, open, onToggle, session, opening, children }: {
  group: WorkspaceChats;
  now: number;
  open: boolean;
  onToggle: () => void;
  session?: string;
  opening: string | null;
  children: (chat: RecentChat) => ReactNode;
}) {
  const state = workspaceState(group.chats);
  const count = `${group.chats.length} ${group.chats.length === 1 ? "session" : "sessions"}`;
  const at = Math.max(0, ...group.chats.map((chat) => chat.at));
  const listId = `home-workspace-${group.workspaceId}`;
  const to = group.entry && panePath(group.entry, session);
  const busy = !!to && isOpening(opening, to);
  const label = `${group.name}, ${state.word}, ${count}`;
  const className = cn("grid min-h-14 min-w-0 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-3 px-1 py-2 text-left hover:bg-[var(--workbench-row-hover)] sm:min-h-12 sm:rounded-lg sm:px-2.5",
    busy && "bg-[var(--workbench-row-hover)]");
  const body = <>
    <LayoutGrid aria-hidden className="row-span-2 size-4 justify-self-center text-muted-foreground" />
    <span className="col-start-2 truncate text-body sm:text-subhead">{group.name}</span>
    <span className="col-start-2 row-start-2 flex min-w-0 items-baseline gap-1 text-footnote text-muted-foreground">
      <span className={cn("shrink-0", state.tone)}>{state.word}</span><span aria-hidden>·</span><span className="truncate">{count}</span>
    </span>
    <span className="col-start-3 row-span-2 row-start-1 flex items-center gap-3 text-footnote text-muted-foreground">
      {busy ? <OpeningSpinner /> : at > 0 && <span aria-hidden className="min-w-8 text-right tabular-nums">{timeAgoShort(at, now)}</span>}
      {!to && <ChevronRight aria-hidden className={cn("size-4 transition-transform duration-150 motion-reduce:transition-none", open && "rotate-90")} />}
    </span>
  </>;
  return (
    <li className="flex flex-col">
      {to
        ? <Link to={to} aria-label={label} aria-busy={busy || undefined} className={className}>{body}</Link>
        : <button type="button" aria-expanded={open} aria-controls={listId} aria-label={label} onClick={onToggle} className={className}>{body}</button>}
      {!to && open && <ul id={listId} className="flex flex-col pl-4 max-sm:divide-y max-sm:divide-border">{group.chats.map(children)}</ul>}
    </li>
  );
}

/**
 * Home's one list of sessions under a control that reorders it: Recents, everything that moved last
 * first (what Needs you shows stays out), Workspaces, one row per Herdr workspace that opens in place
 * on its sessions, or PRs, every pull request, drawn by `pullRequests`; that tab is there only while
 * there is one. A desk narrows each to one project. All read the snapshot Home already has; the list
 * is remembered on this device, the project is not.
 */
export function HomeSessions({ recent: everyRecent, workspaces: everyWorkspace, reviews: everyReview, pullRequests, projects, session, now, opening }: {
  recent: readonly RecentChat[];
  workspaces: readonly WorkspaceChats[];
  reviews: readonly ReviewEntry[];
  pullRequests: (entries: readonly ReviewEntry[]) => ReactNode;
  projects: readonly ProjectView[];
  session?: string;
  now: number;
  opening: string | null;
}) {
  const [chosen, setList] = useState<SessionList>(readList);
  const lists = everyReview.length ? LISTS : LISTS.filter(([key]) => key !== "prs");
  const list = lists.some(([key]) => key === chosen) ? chosen : "recents";
  // A desk narrows both lists to one project's sessions; "" is every project.
  const [only, setOnly] = useState("");
  // The workspaces opened in place; none until a tap opens one.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  // A desk draws the switcher as the session panel's text tabs and the filter as a quiet action; a phone keeps the segmented track.
  const desk = useMediaQuery(DESK);
  if (!everyRecent.length && !everyWorkspace.length && !everyReview.length) return null;
  const project = projects.find((candidate) => candidate.slug === only);
  const inProject = (paneId: string) => !project || projectForPane([project], paneId) !== undefined;
  const kept = (chat: RecentChat) => inProject(chat.agent.paneId);
  const recent = everyRecent.filter(kept);
  const workspaces = everyWorkspace.map((group) => {
    const chats = group.chats.filter(kept);
    // A workspace whose entry pane the project leaves out unfolds what it keeps instead.
    return { ...group, chats, entry: chats.some((chat) => chat.agent.paneId === group.entry) ? group.entry : undefined };
  }).filter((group) => group.chats.length > 0);
  // A pull request belongs to a project through the session or the thread it opens.
  const reviews = everyReview.filter((entry) => !project || (entry.open !== undefined && ("paneId" in entry.open ? inProject(entry.open.paneId) : entry.open.project === project.slug)));
  const row = (chat: RecentChat, group?: string) => <SessionRow key={chat.agent.paneId} chat={chat} session={session} now={now} opening={opening} group={group} />;
  return (
    <section aria-label="Sessions" className="flex flex-col gap-2">
      <div className="flex items-center gap-2.5">
        <div role="tablist" aria-label="Sessions"
          className={desk ? "-ml-2 flex items-center gap-1" : cn("project-segmented mx-0 max-sm:flex-1", lists.length === 3 ? "grid-cols-3 sm:w-80" : "grid-cols-2 sm:w-60")}>
          {lists.map(([key, label]) => (
            <button key={key} id={`home-list-${key}`} type="button" role="tab" aria-selected={list === key} aria-controls="home-list"
              onClick={() => { setList(key); rememberList(key); }} className={desk ? "panel-tab" : "project-segment"}>{label}</button>
          ))}
        </div>
        {projects.length > 0 && (
          <label className={cn("relative ml-auto min-w-0 focus-within:ring-2 focus-within:ring-ring max-sm:hidden",
            desk ? "quiet-action -mr-2" : "inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-footnote text-muted-foreground hover:text-foreground")}>
            <ListFilter aria-hidden className="size-3.5 shrink-0" />
            <span className="max-w-[12rem] truncate">{project?.name ?? "All projects"}</span>
            <ChevronDown aria-hidden className="size-3.5 shrink-0" />
            <select aria-label="Project" value={project?.slug ?? ""} onChange={(event) => setOnly(event.target.value)} className="absolute inset-0 cursor-pointer opacity-0">
              <option value="">All projects</option>
              {projects.map((candidate) => <option key={candidate.slug} value={candidate.slug}>{candidate.name}</option>)}
            </select>
          </label>
        )}
      </div>
      <div id="home-list" role="tabpanel" aria-labelledby={`home-list-${list}`} className="sm:-mx-2.5">
        {list === "prs"
          ? reviews.length
            ? pullRequests(reviews)
            : <p className="px-1 py-3 text-footnote text-muted-foreground sm:px-2.5">No pull request in {project?.name}.</p>
          : list === "recents"
          ? recent.length
            ? <FoldedList items={recent} rows={RECENT_ROWS}>{(chat) => row(chat)}</FoldedList>
            : <p className="px-1 py-3 text-footnote text-muted-foreground sm:px-2.5">{project ? `No other session in ${project.name}.` : "Every session is in Needs you."}</p>
          : <ul className="flex flex-col max-sm:divide-y max-sm:divide-border">
            {workspaces.map((group) => <WorkspaceRow key={group.workspaceId} group={group} now={now} session={session} opening={opening} open={opened.has(group.workspaceId)}
              onToggle={() => setOpened((prev) => { const next = new Set(prev); if (!next.delete(group.workspaceId)) next.add(group.workspaceId); return next; })}>
              {(chat) => row(chat, group.name)}
            </WorkspaceRow>)}
          </ul>}
      </div>
    </section>
  );
}

/** A workflow still running, with how far its agents got. */
export function RunningWorkCard({ paneId, workflow, agent, session, now, opening }: {
  paneId: string;
  workflow: ActivityWorkflow;
  agent?: AgentView;
  session?: string;
  now: number;
  opening: string | null;
}) {
  const agents = allAgents(workflow);
  const running = agents.filter((a) => a.state === "running").slice(0, 3);
  const elapsed = workflowElapsed(workflow, now);
  const to = panePath(paneId, session);
  const busy = isOpening(opening, to);
  return (
    <Link to={to} aria-busy={busy || undefined} className={cn("flex min-w-0 flex-col gap-2.5 rounded-xl border border-border bg-card p-4 transition-colors hover:bg-accent", busy && "bg-accent")}>
      <span className="flex min-w-0 items-center gap-2.5">
        <Workflow aria-hidden className="size-4 shrink-0 text-status-working" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-subhead font-semibold">{workflow.name}</span>
          <span className="truncate text-footnote text-muted-foreground">{[agent?.workspaceLabel, elapsed].filter(Boolean).join(" · ")}</span>
        </span>
        {busy ? <OpeningSpinner /> : <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
      </span>
      <AgentBar states={agents.map((a) => a.state)} />
      {running.length > 0 && (
        <span className="flex flex-col gap-1">
          {running.map((a) => (
            <span key={a.id} className="flex items-center gap-2 text-footnote">
              <StateDot state="running" />
              <span className="min-w-0 flex-1 truncate">{a.label}</span>
              <span className="shrink-0 text-muted-foreground tabular-nums">{agentElapsed(a, now)}</span>
            </span>
          ))}
        </span>
      )}
      <span className="text-footnote text-muted-foreground tabular-nums">{workflow.doneCount} of {workflow.agentCount} agents done</span>
    </Link>
  );
}

/** One way to start, as a 64px row: what it starts and the one line that tells it apart. */
function StarterRow({ icon: Icon, title, hint, disabled, onClick }: { icon: IconComponent; title: string; hint: string; disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className="flex min-h-16 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-accent active:bg-muted disabled:pointer-events-none disabled:text-disabled-foreground">
      <Icon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-body font-medium">{title}</span>
        <span className="text-footnote text-pretty text-muted-foreground">{hint}</span>
      </span>
      <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

/**
 * An empty herd's first screen: the two ways to start an agent from here, and where else they come
 * from. Each opens the same create surface the composer and the New button do.
 */
export function HomeStarters({ disabled, onFolder, onMore }: { disabled: boolean; onFolder: () => void; onMore: () => void }) {
  return (
    <section aria-label="Get started" className="flex flex-col gap-2">
      <div className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        <StarterRow icon={FolderPlus} title="Start an agent in a folder" hint="Pick the agent, then the folder." disabled={disabled} onClick={onFolder} />
        <StarterRow icon={Sparkle} title="Start a project or a quick chat" hint="Many threads, or one question." disabled={disabled} onClick={onMore} />
      </div>
      <p className="text-footnote text-muted-foreground">Agents you start in Herdr show up here too.</p>
    </section>
  );
}

