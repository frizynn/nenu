import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigation } from "react-router";
import { ChevronRight, FolderPlus, GripVertical, LayoutGrid, LayoutTemplate, Pending, Sparkle, Workflow, type IconComponent } from "@/components/ui/icon";

import { AgentBar, StateDot } from "@/components/activity/activity-parts";
import { AgentIcon } from "@/components/agent-icon";
import { DiffStat } from "@/components/diff-stat";
import { Fold } from "@/components/fold";
import { PaneMark } from "@/components/nav-rows";
import { useListReorder, type ListReorder } from "@/components/ui/list-reorder";
import { WorkspaceOrderMenu } from "@/components/workspace-order-menu";
import { useHeldTime } from "@/hooks/use-held-time";
import { useMediaQuery } from "@/hooks/use-media-query";
import { agentElapsed, allAgents, workflowElapsed, type ActivityWorkflow } from "@/lib/activity";
import { EnterScope, useEnter } from "@/lib/enter";
import { timeAgo, timeAgoShort } from "@/lib/format";
import { workspaceSessions, type RecentChat, type ReviewEntry, type TabChats, type WorkspaceChats } from "@/lib/home-stats";
import { panePath } from "@/lib/nav";
import { STATUS_LABEL, type AgentStatus, type AgentView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { MOTION_PANEL_MS } from "@/lib/motion";
import { orderWorkspaces, useWorkspaceOrder } from "@/lib/workspace-order";
import { tabFolds, tabStartsOpen } from "@/lib/workspace-tree";

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
 * A Home list: its first `rows` items, and the rest behind "Show N more", which folds them back as
 * "Show less". A fold that would hide one row shows it instead: one row is not worth a tap. A row that
 * joins once the list is drawn eases in where it lands when it asks to (`useEnter`). `name` says whose
 * rows the control shows, for a list among several.
 */
export function FoldedList<T>({ items, rows, name, children }: { items: readonly T[]; rows: number; name?: string; children: (item: T) => ReactNode }) {
  const [all, setAll] = useState(false);
  const folds = items.length > rows + 1;
  const shown = all || !folds ? items : items.slice(0, rows);
  const more = `Show ${items.length - rows} more`;
  return <EnterScope>
    <ul className="flex flex-col max-sm:divide-y max-sm:divide-border">{shown.map(children)}</ul>
    {folds && (
      <button type="button" onClick={() => setAll(!all)} aria-expanded={all}
        aria-label={name ? (all ? `Show less of ${name}` : `${more} in ${name}`) : undefined}
        className="inline-flex min-h-9 items-center self-start px-1 text-footnote font-medium text-muted-foreground hover:text-foreground coarse:min-h-11 sm:px-2.5">
        {all ? "Show less" : more}
      </button>
    )}
  </EnterScope>;
}

const DESK = "(min-width: 1024px)";

/** How many sessions Recents lists before "Show N more". */
export const RECENT_ROWS = 6;

// A state's word takes its colour on a phone only: a desk keeps the word grey and the colour to the row's
// mark, as Cursor keeps it to the dot or the icon.
const STATUS_TEXT: Partial<Record<AgentStatus, string>> = { working: "max-lg:text-status-working", done: "max-lg:text-status-done" };

const sr = (text: string) => <span className="sr-only">{text}</span>;

/** The state word a row leads its second line with, and its colour. */
function stateOf(chat: RecentChat): { word: string; tone?: string } {
  if (chat.agent.kind === "shell") return { word: "Shell" };
  const status = STATUS_LABEL[chat.agent.status];
  return { word: status.charAt(0).toUpperCase() + status.slice(1), tone: STATUS_TEXT[chat.agent.status] };
}

/**
 * Title, then state, place and what tells it apart (its PR or its tab); the place gives up
 * width first. A desk adds the PR's size and the agent. `group` is the name the row sits under, which
 * it then leaves out; under its tab's row (`inTab`) it leaves the tab out too, and a phone takes that
 * row's deeper indent back from its gaps, so the title keeps the width it has one level up.
 */
export function SessionRow({ chat, session, now, opening, group, inTab = false }: { chat: RecentChat; session?: string; now: number; opening: string | null; group?: string; inTab?: boolean }) {
  const { agent, title, diff, at, unseen } = chat;
  const place = chat.place === group ? null : chat.place;
  const detail = inTab && chat.detail === chat.tab ? null : chat.detail;
  const state = stateOf(chat);
  const to = panePath(agent.paneId, session);
  const busy = isOpening(opening, to);
  const enter = useEnter();
  return (
    <li className={enter}>
      <Link to={to} aria-busy={busy || undefined}
        className={cn("relative grid min-h-14 min-w-0 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-3 px-1 py-2 hover:bg-[var(--workbench-row-hover)] sm:min-h-12 sm:rounded-lg sm:px-2.5",
          inTab && "max-sm:gap-x-1.5", busy && "bg-[var(--workbench-row-hover)]")}>
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
/** The phone's segmented track for as many tabs: one column each, as wide as their words need. */
const SEGMENTS: Record<number, string> = { 1: "grid-cols-1 sm:w-32", 2: "grid-cols-2 sm:w-60", 3: "grid-cols-3 sm:w-80" };
// A list remembered that is no longer one opens on Recents.
const LIST_KEY = "nenu:home-list:v2";

function readList(): SessionList {
  try {
    const list = localStorage.getItem(LIST_KEY);
    return LISTS.some(([key]) => key === list) ? list as SessionList : "recents";
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
const WORKSPACE_STATES = [STATUS_LABEL.blocked, STATUS_LABEL.working, STATUS_LABEL.done, STATUS_LABEL.idle, "Shell"]
  .map((word) => word.charAt(0).toUpperCase() + word.slice(1));

function workspaceState(chats: readonly RecentChat[]): { word: string; tone?: string } {
  const states = chats.map(stateOf);
  const word = WORKSPACE_STATES.find((candidate) => states.some((state) => state.word === candidate));
  // What needs you says it in red.
  if (word === WORKSPACE_STATES[0]) return { word, tone: "max-lg:text-status-blocked" };
  return states.find((state) => state.word === word) ?? { word: "Empty" };
}

// Entering Reorder, its handles and controls fade in at a panel's pace (180 ms); on Done, the times and
// controls they replaced fade back at a control's (120 ms).
const ARRIVE_FADE = "duration-180 ease-out animate-in fade-in";
const RETURN_FADE = "duration-120 ease-out animate-in fade-in";

/** What a row that folds rows stands for: its mark, what it counts, and how far in its rows sit. */
const FOLDS = {
  // A tab's rows sit 12px further in on a phone, and take those 12px back from their gaps (SessionRow).
  workspace: { icon: LayoutGrid, one: "session", many: "sessions", rows: "pl-4" },
  tab: { icon: LayoutTemplate, one: "pane", many: "panes", rows: "pl-3 sm:pl-4" },
} as const;

/**
 * A row that folds the rows under it, a Herdr workspace or a tab of several panes: its name, how it
 * is, how many it holds and when the latest moved. A tap folds its rows open in place, or opens `to`
 * when there is nothing to unfold; one opened by the app (`animate` off) is simply there. While its
 * list is reordered it opens nothing and its end is the handle that drags it, which fades in from the
 * end; `settling`, just after, its time fades back.
 */
function FoldRow({ kind, id, name, chats, now, open, onToggle, animate = true, to, busy = false, reorder, settling = false, children }: {
  kind: keyof typeof FOLDS;
  id: string;
  name: string;
  chats: readonly RecentChat[];
  now: number;
  open: boolean;
  onToggle: () => void;
  animate?: boolean;
  to?: string;
  busy?: boolean;
  reorder?: ListReorder;
  settling?: boolean;
  children: ReactNode;
}) {
  const { icon: Icon, one, many, rows } = FOLDS[kind];
  const state = workspaceState(chats);
  const count = `${chats.length} ${chats.length === 1 ? one : many}`;
  const at = Math.max(0, ...chats.map((chat) => chat.at));
  const listId = `home-${kind}-${id}`;
  const label = `${name}, ${state.word}, ${count}`;
  const grid = "grid min-h-14 min-w-0 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-3 px-1 py-2 text-left sm:min-h-12 sm:rounded-lg sm:px-2.5";
  const className = cn(grid, "hover:bg-[var(--workbench-row-hover)]", busy && "bg-[var(--workbench-row-hover)]");
  const body = <>
    <Icon aria-hidden className="row-span-2 size-4 justify-self-center text-muted-foreground" />
    <span className="col-start-2 truncate text-body sm:text-subhead">{name}</span>
    <span className="col-start-2 row-start-2 flex min-w-0 items-baseline gap-1 text-footnote text-muted-foreground">
      <span className={cn("shrink-0", state.tone)}>{state.word}</span><span aria-hidden>·</span><span className="truncate">{count}</span>
    </span>
    {reorder
      ? <button type="button" aria-label={`Move ${name}`} {...reorder.handle(id)}
        className={cn("col-start-3 row-span-2 row-start-1 -my-2 -mr-1 flex size-11 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground hover:text-foreground active:cursor-grabbing sm:-mr-2.5",
          ARRIVE_FADE, "slide-in-from-right-2 motion-reduce:slide-in-from-right-0")}>
        <GripVertical aria-hidden className="size-4" />
      </button>
      : <span className={cn("col-start-3 row-span-2 row-start-1 flex items-center gap-3 text-footnote text-muted-foreground", settling && RETURN_FADE)}>
        {busy ? <OpeningSpinner /> : at > 0 && <span aria-hidden className="min-w-8 text-right tabular-nums">{timeAgoShort(at, now)}</span>}
        {!to && <ChevronRight aria-hidden className={cn("size-4 transition-transform duration-120 motion-reduce:transition-none", open && "rotate-90")} />}
      </span>}
  </>;
  if (reorder) {
    return (
      <li data-reorder-key={id} data-lifted={reorder.dragging === id || undefined} className="workspace-reorder-row flex flex-col">
        <div className={cn(grid, "bg-background")}>{body}</div>
      </li>
    );
  }
  return (
    <li className="flex flex-col">
      {to
        ? <Link to={to} aria-label={label} aria-busy={busy || undefined} className={className}>{body}</Link>
        : <button type="button" aria-expanded={open} aria-controls={open ? listId : undefined} aria-label={label} onClick={onToggle} className={className}>{body}</button>}
      {!to && <Fold value={open} animate={animate}>
        {() => <ul id={listId} aria-label={name} className={cn("flex flex-col max-sm:divide-y max-sm:divide-border", rows)}>{children}</ul>}
      </Fold>}
    </li>
  );
}

/**
 * A Herdr workspace as one row: its name, how it is and how many sessions it holds. A tap opens it in
 * place on its tabs: a one-pane tab is that pane's row, the row Recents draws, and a tab of several
 * panes is a row of its own that folds them (lib/workspace-tree.ts). A workspace of one tab or one
 * session has nothing to unfold: the tap opens its `entry` pane.
 */
function WorkspaceRow({ group, now, open, onToggle, tabOpen, tabTouched, onTab, session, opening, row, reorder, settling }: {
  group: WorkspaceChats;
  now: number;
  open: boolean;
  onToggle: () => void;
  tabOpen: (tab: TabChats) => boolean;
  /** Whether a tap left the tab's fold, rather than its agents (tabStartsOpen). */
  tabTouched: (tab: TabChats) => boolean;
  onTab: (tab: TabChats) => void;
  session?: string;
  opening: string | null;
  row: (chat: RecentChat, inTab: boolean) => ReactNode;
  reorder?: ListReorder;
  settling?: boolean;
}) {
  const to = group.entry && panePath(group.entry, session);
  return (
    <FoldRow kind="workspace" id={group.workspaceId} name={group.name} chats={workspaceSessions(group)} now={now} open={open} onToggle={onToggle}
      to={to} busy={!!to && isOpening(opening, to)} reorder={reorder} settling={settling}>
      {group.tabs.map((tab) => tabFolds(tab.chats.length, group.tabs.length)
        ? <FoldRow key={tab.tabId} kind="tab" id={tab.tabId} name={tab.label} chats={tab.chats} now={now} open={tabOpen(tab)} onToggle={() => onTab(tab)}
          animate={tabTouched(tab)}>
          {tab.chats.map((chat) => row(chat, true))}
        </FoldRow>
        : tab.chats.map((chat) => row(chat, false)))}
    </FoldRow>
  );
}

/**
 * Home's lists under one control: Recents, every session that moved last first (what Needs you shows
 * stays out); Workspaces, one row per Herdr workspace that opens in place on its sessions; or PRs,
 * every pull request, drawn by `pullRequests`, there only while there is one. All read the snapshot
 * Home already has; the list is remembered on this device. Workspaces come in the order chosen on this
 * device: Herdr's, by name, or the operator's, dragged by each row's handle after Reorder
 * (lib/workspace-order.ts).
 */
export function HomeSessions({ recent: everyRecent, workspaces, reviews, pullRequests, session, now, opening }: {
  recent: readonly RecentChat[];
  workspaces: readonly WorkspaceChats[];
  reviews: readonly ReviewEntry[];
  pullRequests: (entries: readonly ReviewEntry[]) => ReactNode;
  session?: string;
  now: number;
  opening: string | null;
}) {
  const [chosen, setList] = useState<SessionList>(readList);
  const lists = LISTS.filter(([key]) => key !== "prs" || reviews.length > 0);
  const list = lists.some(([key]) => key === chosen) ? chosen : lists[0]![0];
  // The workspaces opened in place; none until a tap opens one.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  // Each tab's fold as a tap left it; an untouched tab follows tabStartsOpen.
  const [tabsOpen, setTabsOpen] = useState<Readonly<Record<string, boolean>>>({});
  // A desk draws the switcher as a page's underlined tabs (DeskTabs); a phone keeps the segmented track.
  const desk = useMediaQuery(DESK);
  // Recents keeps the order it came on screen with, so a row never moves under the finger: one that
  // finishes says New where it is. "N updates" puts them in order, as coming back to the page does.
  const held = useHeldTime((chat: RecentChat) => chat.agent.paneId, (chat) => chat.at);
  const { order, set: setOrder } = useWorkspaceOrder();
  // Reordering: each workspace row is its handle, and opens nothing until Done.
  const [arranging, setArranging] = useState(false);
  // Just after Done, while each row's time fades back in place of its handle.
  const [settling, setSettling] = useState(false);
  useEffect(() => {
    if (!settling) return;
    const timer = setTimeout(() => setSettling(false), MOTION_PANEL_MS);
    return () => clearTimeout(timer);
  }, [settling]);
  const reorderList = useRef<HTMLUListElement>(null);
  // Reorder and Done take each other's place, so the focus follows to the one that appears, or to the
  // tab when one workspace leaves nothing to reorder.
  const reorderControl = useRef<HTMLButtonElement>(null);
  const doneControl = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<"done" | "reorder" | null>(null);
  useEffect(() => {
    const next = focusNext.current;
    focusNext.current = null;
    if (next === "done") doneControl.current?.focus({ preventScroll: true });
    else if (next === "reorder") (reorderControl.current ?? document.getElementById("home-list-workspaces"))?.focus({ preventScroll: true });
  }, [arranging]);
  // What an arrow key on a handle did, for a screen reader.
  const [moveSaid, setMoveSaid] = useState("");
  const recent = held.order(everyRecent);
  const updates = list === "recents" ? held.moved(recent) : 0;
  // The pill keeps the count it last said while it fades out.
  const said = useRef(1);
  if (updates) said.current = updates;
  const workspaceId = (group: WorkspaceChats) => group.workspaceId;
  const workspaceName = (group: WorkspaceChats) => group.name;
  const ordered = orderWorkspaces(workspaces, workspaceId, workspaceName, order);
  const shownIds = ordered.map(workspaceId);
  const reorder = useListReorder({
    list: reorderList, keys: shownIds, enabled: arranging && list === "workspaces",
    // A drag is a custom order, whichever order it started from.
    onMove: (shown, key) => {
      setOrder({ mode: "custom", custom: shown });
      const name = ordered.find((group) => group.workspaceId === key)?.name;
      if (name) setMoveSaid(`${name}, ${shown.indexOf(key) + 1} of ${shown.length}`);
    },
  });
  const startArranging = () => {
    setMoveSaid("");
    focusNext.current = "done";
    setSettling(false);
    setArranging(true);
  };
  const stopArranging = () => {
    focusNext.current = "reorder";
    setSettling(true);
    setArranging(false);
  };
  const ordering = list === "workspaces" && (arranging || workspaces.length > 1);
  if (!everyRecent.length && !workspaces.length && !reviews.length) return null;
  const tabOpen = (tab: TabChats) => tabsOpen[tab.tabId] ?? tabStartsOpen(tab.chats.map((chat) => chat.agent));
  const row = (chat: RecentChat, group?: string, inTab?: boolean) => <SessionRow key={chat.agent.paneId} chat={chat} session={session} now={now} opening={opening} group={group} inTab={inTab} />;
  return (
    <section aria-label="Your work" className="flex flex-col gap-2">
      <div className={cn("relative flex items-center gap-2.5", desk && "border-b border-border")}>
        <div role="tablist" aria-label="Your work"
          className={desk ? "flex items-center gap-5" : cn("project-segmented mx-0 max-sm:flex-1", SEGMENTS[lists.length])}>
          {/* The phone's thumb slides under the chosen list, as Segmented's does; the list itself swaps at once. */}
          {!desk && <span aria-hidden className="project-segment-thumb"
            style={{ width: `calc((100% - 6px) / ${lists.length})`, transform: `translateX(${lists.findIndex(([key]) => key === list) * 100}%)` }} />}
          {lists.map(([key, label]) => (
            <button key={key} id={`home-list-${key}`} type="button" role="tab" aria-selected={list === key} aria-controls="home-list"
              onClick={() => { setList(key); rememberList(key); setArranging(false); }} className={desk ? "desk-tab" : "project-segment"}>{label}</button>
          ))}
        </div>
        {/* Always laid out beside the tabs, so its arrival moves neither them nor the rows; a phone gives the
            tabs the row's width and floats it over the list's top instead. */}
        <button type="button" onClick={held.reorder} aria-hidden={updates === 0 || undefined} tabIndex={updates === 0 ? -1 : undefined}
          className={cn("shrink-0 rounded-full border border-border px-2.5 py-1 text-footnote tabular-nums text-muted-foreground hover:text-foreground",
            "max-sm:absolute max-sm:left-1/2 max-sm:top-full max-sm:z-10 max-sm:mt-2 max-sm:-translate-x-1/2 max-sm:bg-background max-sm:shadow-md",
            "transition-[opacity,visibility] duration-120 ease-out motion-reduce:transition-none", !updates && "pointer-events-none invisible opacity-0", "ml-auto")}>
          {said.current} {said.current === 1 ? "update" : "updates"}
        </button>
      </div>
      <p role="status" className="sr-only">{arranging ? moveSaid : ""}</p>
      {/* How the workspaces are sorted, and Reorder, which drags them: above their list, never in the tabs' row. */}
      {ordering && (
        <div className="-mb-1 flex min-h-11 items-center justify-between gap-2 px-1 sm:min-h-9 sm:px-0">
          {arranging
            ? <p className={cn("text-footnote text-muted-foreground", ARRIVE_FADE)}>Drag a handle to move a workspace</p>
            : <WorkspaceOrderMenu order={order} onChoose={(mode) => setOrder({ ...order, mode })} className={cn("-ml-2", settling && RETURN_FADE)} />}
          {arranging
            ? <button ref={doneControl} type="button" onClick={stopArranging} className={cn("quiet-action -mr-2 font-medium text-foreground", ARRIVE_FADE)}>Done</button>
            : <button ref={reorderControl} type="button" aria-label="Reorder workspaces" onClick={startArranging}
              className={cn("quiet-action -mr-2", settling && RETURN_FADE)}>Reorder</button>}
        </div>
      )}
      <div id="home-list" role="tabpanel" aria-labelledby={`home-list-${list}`} className="sm:-mx-2.5">
        {list === "prs"
          ? pullRequests(reviews)
          : list === "recents"
          ? recent.length
            ? <FoldedList items={recent} rows={RECENT_ROWS}>{(chat) => row(chat)}</FoldedList>
            : <p className="px-1 py-3 text-footnote text-muted-foreground sm:px-2.5">Every session is in Needs you.</p>
          : <ul ref={reorderList} aria-label={arranging ? "Workspaces, drag a handle or press its arrow keys to move one" : undefined}
            className="relative flex flex-col max-sm:divide-y max-sm:divide-border">
            {ordered.map((group) => <WorkspaceRow reorder={arranging ? reorder : undefined} settling={settling} key={group.workspaceId} group={group} now={now} session={session} opening={opening} open={opened.has(group.workspaceId)}
              onToggle={() => setOpened((prev) => { const next = new Set(prev); if (!next.delete(group.workspaceId)) next.add(group.workspaceId); return next; })}
              tabOpen={tabOpen} tabTouched={(tab) => tab.tabId in tabsOpen} onTab={(tab) => setTabsOpen((prev) => ({ ...prev, [tab.tabId]: !tabOpen(tab) }))}
              row={(chat, inTab) => row(chat, group.name, inTab)} />)}
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
    <Link to={to} aria-busy={busy || undefined} className={cn("flex min-w-0 flex-col gap-2.5 rounded-xl border border-border bg-card p-4 transition-colors hover:bg-hover", busy && "bg-accent")}>
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
      className="flex min-h-16 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-hover active:bg-muted disabled:pointer-events-none disabled:text-disabled-foreground">
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
        <StarterRow icon={Sparkle} title="More ways to start" hint="A quick question, a tab or a workspace." disabled={disabled} onClick={onMore} />
      </div>
      <p className="text-footnote text-muted-foreground">Agents you start in Herdr show up here too.</p>
    </section>
  );
}

