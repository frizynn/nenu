import { memo, useCallback, useId, useReducer, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { ChevronDown, ChevronRight } from "@/components/ui/icon";

import { OpeningMark, PaneMark, PlaceText } from "@/components/nav-rows";
import { AGENT_STATE, StateMark, StatusDot } from "@/components/status-badge";
import { useDayTurn } from "@/hooks/use-day-turn";
import { useHeldTime, useOnReturn } from "@/hooks/use-held-time";
import { COUNTED, deskChats, type CountedState, type DeskChat } from "@/lib/desk-nav";
import { groupByProject, projectWeight, useProjectView, type ProjectGroup } from "@/lib/desk-projects";
import { displayPlace } from "@/lib/display-name";
import { TITLE_SEP } from "@/lib/pane-name";
import { timeAgoShort } from "@/lib/format";
import type { HomeData } from "@/lib/loaders";
import { panePath } from "@/lib/nav";
import { groupByRecency } from "@/lib/recency";
import { STATUS_LABEL } from "@/lib/types";
import { limitLine, resetTime, usageLimitOf } from "@/lib/usage-limit";
import { cn } from "@/lib/utils";

/** How many chats the bar lists before More; the one on screen always shows. */
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


/** The chats as the bar holds them: each keeps the place it had when the bar drew it. */
export type HeldChats = ReturnType<typeof useHeldChats>;

/**
 * Each chat keeps the place it had when the bar drew it, so a row never moves under the pointer: one that
 * finishes says +1 where it is. "N updates" puts them in order, as coming back to the window does.
 */
export function useHeldChats() {
  return useHeldTime((chat: DeskChat) => chat.paneId, (chat) => chat.at);
}

/**
 * The desk's lists: by default every chat under the project its folder works in, each project a row that
 * folds them; or, as this device chose, every chat under the period it last moved in, as Cursor's agent
 * window draws its own. A tapped count lists only the chats in its state. The tree of workspaces and tabs
 * is Search's (workbench-sidebar.tsx).
 */
export function DeskLists({ data, only, onClear }: { data: HomeData; only?: CountedState; onClear: () => void }) {
  const { paneId } = useParams();
  const { view } = useProjectView();
  const held = useHeldChats();
  const chats = held.order(deskChats(data));
  const now = Date.now();
  const row = (chat: DeskChat) => <ChatRow key={chat.paneId} chat={chat} session={data.session} current={chat.paneId === paneId} now={now} />;
  if (only) return <OnlyList key={only} state={only} chats={chats} row={row} onClear={onClear} className="nav-desk" />;
  if (view === "projects") return <ProjectList chats={chats} held={held} row={row} currentPaneId={paneId} className="nav-desk" />;
  return <DeskChats chats={chats} held={held} row={row} currentPaneId={paneId} now={now} />;
}

/** A chat that waits on you: past More it still shows, after the rows on screen, so nothing moves to say it. */
const needsYou = (chat: DeskChat) => chat.pane.status === "blocked";

/** Says how many chats moved since the bar drew them, and puts them in order. */
function UpdatesButton({ count, onClick }: { count: number; onClick: () => void }) {
  if (count === 0) return null;
  return <button type="button" className="nav-label-updates" onClick={onClick}>{count} {count === 1 ? "update" : "updates"}</button>;
}

function DeskChats({ chats, held, row, currentPaneId, now }: {
  chats: DeskChat[];
  held: HeldChats;
  row: (chat: DeskChat) => ReactNode;
  currentPaneId?: string;
  now: number;
}) {
  const [more, setMore] = useState(false);
  const extra = folded(chats, CHATS_SHOWN, (chat) => chat.paneId === currentPaneId || needsYou(chat));
  const hides = (chat: DeskChat) => !more && extra.has(chat);
  return (
    <section aria-label="Chats" className="nav-desk nav-chats">
      {groupByRecency(chats, held.at, now).map((group, index) => (
        <Reveal key={group.key} folded={group.items.every(hides)}>
          <section aria-label={group.label} className="nav-group">
            {index === 0
              ? <div className="nav-label">
                <h3 className="nav-label-text">{group.label}</h3>
                <UpdatesButton count={held.moved(chats)} onClick={held.reorder} />
              </div>
              : <h3 className="nav-label">{group.label}</h3>}
            {group.items.map((chat) => <Reveal key={chat.paneId} folded={hides(chat)}>{row(chat)}</Reveal>)}
          </section>
        </Reveal>
      ))}
      {extra.size > 0 && <MoreRow open={more} hidden={extra.size} onToggle={() => setMore(!more)} />}
    </section>
  );
}

/**
 * Every chat under the project its folder works in (lib/desk-projects.ts), each project a row that folds
 * them, closed until opened on this device. A project where something needs you or works comes first,
 * then the one that moved last; like the chats, a project keeps its place while it is on screen, until
 * "N updates" or a return to the window puts them in order. `end` sits at the heading's end.
 */
export function ProjectList({ chats, held, row, currentPaneId, end, className }: {
  chats: DeskChat[];
  held: HeldChats;
  row: (chat: DeskChat) => ReactNode;
  currentPaneId?: string;
  end?: ReactNode;
  className?: string;
}) {
  const { open, setOpen } = useProjectView();
  const heldGroups = useHeldTime((group: ProjectGroup<DeskChat>) => group.key, (group) => projectWeight(group, (chat) => chat.at));
  const groups = heldGroups.order(groupByProject(chats, (chat) => chat.pane));
  const reorder = () => {
    held.reorder();
    heldGroups.reorder();
  };
  return (
    <section aria-label="Projects" className={cn("nav-chats nav-repos", className)}>
      <div className="nav-label">
        <h3 className="nav-label-text">Projects</h3>
        <UpdatesButton count={held.moved(chats)} onClick={reorder} />
        {end}
      </div>
      {groups.map((group) => (
        <ProjectFold key={group.key} group={group} open={open[group.key] ?? false} onToggle={(next) => setOpen(group.key, next)} currentPaneId={currentPaneId}>
          {group.items.map(row)}
        </ProjectFold>
      ))}
    </section>
  );
}

/**
 * A project: a row with its name, the most pressing state among its chats and how many it holds, that
 * folds them. Folded, it still says what finished or asked since you last looked (+N) and, filled as a
 * folded workspace is, that it holds the chat on screen. A screen reader hears how many are in each state.
 */
function ProjectFold({ group, open, onToggle, currentPaneId, children }: {
  group: ProjectGroup<DeskChat>;
  open: boolean;
  onToggle: (open: boolean) => void;
  currentPaneId?: string;
  children: ReactNode;
}) {
  const id = useId();
  const unread = group.items.filter((chat) => chat.unread && chat.paneId !== currentPaneId).length;
  const states = COUNTED.map(({ state, label }) => [group.items.filter((chat) => chat.pane.status === state).length, label.toLowerCase()] as const)
    .filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
  const said = [`${group.items.length} ${group.items.length === 1 ? "chat" : "chats"}`, ...states, ...(unread > 0 && !open ? [`${unread} new`] : [])];
  return (
    <section aria-label={group.label} className="nav-repo-group">
      <button type="button" className="nav-row nav-repo-row" aria-expanded={open} aria-controls={id} onClick={() => onToggle(!open)}
        aria-current={!open && group.items.some((chat) => chat.paneId === currentPaneId) ? "true" : undefined}
        data-live={group.state || unread > 0 ? true : undefined}>
        {/* Its state where a chat's sits, its count apart from it, so "◌ 16" never reads as sixteen at work. */}
        <span className="nav-lead" aria-hidden>{group.state && <StatusDot status={group.state} />}</span>
        <span className="nav-row-text">{group.label}</span>
        <span className="sr-only">, {said.join(", ")}</span>
        {unread > 0 && !open && <span className="nav-unread" aria-hidden>+{unread}</span>}
        <span className="nav-row-meta" aria-hidden>{group.items.length}<ChevronRight size={14} className="nav-repo-fold" /></span>
      </button>
      <Reveal folded={!open}><div id={id} className="nav-repo-body">{children}</div></Reveal>
    </section>
  );
}

/**
 * Only the chats in one state, as a tapped count asks, in the bar's order, and a way back to every chat. A
 * chat that leaves the state while the list is on screen stays, drawn in its new state, so no row moves
 * under the pointer; "N updates" or a return to the window lets it go. Keyed by its state, so another tap
 * starts afresh.
 */
export function OnlyList({ state, chats, row, onClear, className }: {
  state: CountedState;
  chats: DeskChat[];
  row: (chat: DeskChat) => ReactNode;
  onClear: () => void;
  className?: string;
}) {
  const { label, none } = COUNTED.find((count) => count.state === state)!;
  const shown = useRef(new Set<string>());
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const release = useCallback(() => {
    shown.current = new Set();
    redraw();
  }, []);
  useOnReturn(release);
  const listed = chats.filter((chat) => chat.pane.status === state || shown.current.has(chat.paneId));
  for (const chat of listed) shown.current.add(chat.paneId);
  const count = chats.filter((chat) => chat.pane.status === state).length;
  return (
    <section aria-label={label} className={cn("nav-chats nav-only", className)}>
      <div className="nav-label">
        <h3 className="nav-label-text">{label} <span className="nav-count">{count}</span></h3>
        <UpdatesButton count={listed.length - count} onClick={release} />
        <button type="button" className="nav-label-updates" onClick={onClear}>Show all</button>
      </div>
      {listed.length > 0 ? listed.map(row) : <p className="nav-empty">{none}</p>}
    </section>
  );
}

/**
 * A chat: its state as a small still glyph, its name and how long ago it moved, then where it lives in
 * the quiet ink (as T3 Code's rows say their repo and branch), so two chats of one name still read
 * apart; and a quiet +1 when it finished or asked for you since you last opened it (the desk's answer to
 * an agent finishing elsewhere, instead of a toast). Drawn again only when its pane changed or its time
 * reads another minute: the bar re-renders on every revalidation, its rows need not.
 */
const ChatRow = memo(function ChatRow({ chat, session, current, now }: { chat: DeskChat; session?: string; current: boolean; now: number }) {
  const { pane } = chat;
  const to = panePath(chat.paneId, session);
  const word = STATUS_LABEL[pane.status];
  // The usage limit outranks the agent's state: it is held until a time, whatever it was doing.
  const limit = usageLimitOf(pane);
  useDayTurn(limit !== undefined);
  // Only what is alive reads in full ink: a chat that waits, works, or finished unseen.
  const live = limit !== undefined || AGENT_STATE[pane.status] !== "idle" || chat.unread;
  const place = displayPlace(pane);
  return (
    <Link className="nav-row nav-chat-row" to={to} aria-current={current ? "page" : undefined} data-live={live || undefined}>
      <span className="nav-lead">
        <OpeningMark to={to}>{limit ? <StateMark state="limit" /> : <PaneMark pane={pane} />}</OpeningMark>
      </span>
      <span className="nav-chat-text">
        <span className="nav-chat-line">
          <span className="nav-row-text">{chat.title}</span>
          {chat.unread && !current && <span className="nav-unread" data-unread aria-hidden>+1</span>}
          {limit
            ? <span className="nav-limit" data-limit title={limitLine(limit)}><span className="sr-only">, usage limit, </span>resets {resetTime(limit.resetsAt)}</span>
            : <span className="sr-only">, {word}</span>}
          {chat.unread && !current && <span className="sr-only">, new</span>}
          {!limit && chat.at > 0 && <span className="nav-chat-time" aria-hidden>{timeAgoShort(chat.at, now)}</span>}
        </span>
        {/* Where it lives tells two chats of one name apart, by ear too; when it moved is for the eye. */}
        <span className="nav-chat-place" aria-hidden><PlaceText place={place} /></span>
        <span className="sr-only">, {place.tab ? `${place.place}${TITLE_SEP}${place.tab}` : place.place}</span>
      </span>
    </Link>
  );
}, (a, b) => a.chat.pane === b.chat.pane && a.chat.title === b.chat.title && a.chat.unread === b.chat.unread && a.chat.at === b.chat.at
  && a.session === b.session && a.current === b.current && timeAgoShort(a.chat.at, a.now) === timeAgoShort(b.chat.at, b.now));
