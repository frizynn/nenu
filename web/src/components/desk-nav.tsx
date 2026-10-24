import { memo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { ChevronDown } from "@/components/ui/icon";

import { OpeningMark, PaneMark } from "@/components/nav-rows";
import { AGENT_STATE, StateMark } from "@/components/status-badge";
import { useHeldTime } from "@/hooks/use-held-time";
import { deskChats, type DeskChat } from "@/lib/desk-nav";
import type { HomeData } from "@/lib/loaders";
import { panePath } from "@/lib/nav";
import { groupByRecency } from "@/lib/recency";
import { STATUS_LABEL } from "@/lib/types";
import { limitLine, resetTime, usageLimitOf } from "@/lib/usage-limit";

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

/**
 * The desk's lists, drawn as Cursor's agent window draws its own: every chat under the period it last
 * moved in. The tree of workspaces and tabs is Search's (workbench-sidebar.tsx).
 */
export function DeskLists({ data }: { data: HomeData }) {
  return <DeskChats data={data} now={Date.now()} />;
}

/** A chat that waits on you: past More it still shows, after the rows on screen, so nothing moves to say it. */
const needsYou = (chat: DeskChat) => chat.pane.status === "blocked";

function DeskChats({ data, now }: { data: HomeData; now: number }) {
  const { paneId } = useParams();
  const [more, setMore] = useState(false);
  const isCurrent = (chat: DeskChat) => chat.paneId === paneId;
  // Each chat keeps the place it had when the bar drew it, so a row never moves under the pointer: one
  // that finishes says +1 where it is. "N updates" puts them in order, as coming back to the window does.
  const held = useHeldTime((chat: DeskChat) => chat.paneId, (chat) => chat.at);
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
              <Reveal key={chat.paneId} folded={hides(chat)}>
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

/**
 * A chat: its state as a small still glyph, its one name, and a quiet +1 when it finished or asked for
 * you since you last opened it (the desk's answer to an agent finishing elsewhere, instead of a toast).
 * Drawn again only when its pane changed: the bar re-renders on every revalidation, its rows need not.
 */
const ChatRow = memo(function ChatRow({ chat, session, current }: { chat: DeskChat; session?: string; current: boolean }) {
  const { pane } = chat;
  const to = panePath(chat.paneId, session);
  const word = STATUS_LABEL[pane.status];
  // The usage limit outranks the agent's state: it is held until a time, whatever it was doing.
  const limit = usageLimitOf(pane);
  // Only what is alive reads in full ink: a chat that waits, works, or finished unseen.
  const live = limit !== undefined || AGENT_STATE[pane.status] !== "idle" || chat.unread;
  return (
    <Link className="nav-row" to={to} aria-current={current ? "page" : undefined} data-live={live || undefined}>
      <span className="nav-lead">
        <OpeningMark to={to}>{limit ? <StateMark state="limit" /> : <PaneMark pane={pane} />}</OpeningMark>
      </span>
      <span className="nav-row-text">{chat.title}</span>
      {limit
        ? <span className="nav-limit" data-limit title={limitLine(limit)}><span className="sr-only">, usage limit, </span>resets {resetTime(limit.resetsAt)}</span>
        : <span className="sr-only">, {word}</span>}
      {chat.unread && !current && <span className="nav-unread" data-unread aria-hidden>+1</span>}
      {chat.unread && !current && <span className="sr-only">, new</span>}
    </Link>
  );
  // Same pane, same row; a held limit is still redrawn, as its reset drops the weekday when the day turns.
}, (a, b) => a.chat.pane === b.chat.pane && a.chat.title === b.chat.title && a.chat.unread === b.chat.unread
  && a.session === b.session && a.current === b.current && !usageLimitOf(b.chat.pane));
