import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Pending, Terminal } from "@/components/ui/icon";

import { useRouterState } from "@/hooks/use-router";
import { StateMark, StatusDot } from "@/components/status-badge";
import { rowSession } from "@/lib/machines";
import { displayName, displayPlace, type DisplayPlace } from "@/lib/display-name";
import { timeAgoShort } from "@/lib/format";
import { panePath } from "@/lib/nav";
import { chatRecency } from "@/lib/recency";
import { matchRange } from "@/lib/nav-search";
import { TITLE_SEP } from "@/lib/pane-name";
import { STATUS_LABEL, type AgentView } from "@/lib/types";

// The parts every list of chats in the navigation shares (the tree, search, Needs you, Recent and
// the pane switcher), so a pane reads the same wherever it is listed: a mark, its name, where it lives.

/** The two-line row: a mark, the name, the line under it, and what sits at the end. */
export function RowBody({ mark, title, detail, end }: { mark: ReactNode; title: ReactNode; detail?: ReactNode; end?: ReactNode }) {
  return <>
    <span className="nav-pane-mark">{mark}</span>
    <span className="nav-pane-text">
      <span className="nav-pane-title">{title}</span>
      {detail && <span className="nav-pane-detail">{detail}</span>}
    </span>
    {end}
  </>;
}

/** A pane's state dot, or the terminal glyph for a shell, which has no agent state. */
export function PaneMark({ pane }: { pane: Pick<AgentView, "kind" | "status" | "turn"> }) {
  if (pane.kind === "shell") return <Terminal aria-hidden size={14} />;
  return pane.turn?.limit ? <StateMark state="limit" /> : <StatusDot status={pane.status} />;
}

/** `text` with the part matching `query` in semibold. */
export function Highlight({ text, query = "" }: { text: string; query?: string }) {
  const range = matchRange(text, query);
  if (!range) return text;
  const [start, end] = range;
  return <>{text.slice(0, start)}<mark className="nav-match">{text.slice(start, end)}</mark>{text.slice(end)}</>;
}

/** Where a pane lives: place then tab, as separate spans so a narrow row gives up the place first. */
export function PlaceText({ place, query }: { place: DisplayPlace; query?: string }) {
  return <>
    <span className="nav-place"><Highlight text={place.place} query={query} /></span>
    {place.tab && <>{TITLE_SEP}<span className="nav-place-tab"><Highlight text={place.tab} query={query} /></span></>}
  </>;
}

/** How long a row's route may load before the row says so; a fast link never flickers. */
const OPENING_DELAY_MS = 120;

/** Whether the route `to` names has been loading for longer than {@link OPENING_DELAY_MS}. */
function useOpening(to: string): boolean {
  // Only this row's answer: a list of rows each reading the navigation redrew all of them twice per poll.
  const path = to.split("?")[0];
  const opening = useRouterState((state) => state.navigation.state === "loading" && state.navigation.location.pathname === path);
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!opening) return;
    const timer = setTimeout(() => setLate(true), OPENING_DELAY_MS);
    return () => {
      clearTimeout(timer);
      setLate(false);
    };
  }, [opening]);
  return opening && late;
}

/**
 * A row's mark, or a spinner in its place while the row's destination loads, so a tap over a slow
 * link shows at the row that was tapped instead of leaving the old screen looking idle.
 */
export function OpeningMark({ to, children }: { to: string; children: ReactNode }) {
  if (!useOpening(to)) return children;
  return <span data-pending className="nav-opening"><Pending aria-hidden size={14} /><span className="sr-only">Opening</span></span>;
}

/** A chat: its state, its one name, where it lives and how long ago it last moved. */
export function ChatRow({ pane, current, now, session }: {
  pane: AgentView;
  current: boolean;
  now: number;
  session?: string;
}) {
  const at = chatRecency(pane);
  const to = panePath(pane.paneId, rowSession(pane, session));
  return (
    <Link className="nav-pane nav-chat" to={to} aria-current={current ? "page" : undefined}>
      <RowBody mark={<OpeningMark to={to}><PaneMark pane={pane} /></OpeningMark>} title={displayName(pane)} detail={<PlaceText place={displayPlace(pane)} />} end={<>
        {pane.kind !== "shell" && <span className="sr-only">, {STATUS_LABEL[pane.status]}</span>}
        {at > 0 && <span className="nav-chat-time">{timeAgoShort(at, now)}</span>}
      </>} />
    </Link>
  );
}

