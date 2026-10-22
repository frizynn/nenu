import { useId, useState, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ChevronRight, GitPullRequest, Plus } from "@/components/ui/icon";

import { AskSections } from "@/components/ask-list";
import { MarkTile } from "@/components/mark-picker";
import { CoordinatorGlyph } from "@/components/project-glyph";
import { NodeDot } from "@/components/node-row";
import { threadAge } from "@/components/project-tasks";
import { Button } from "@/components/ui/button";
import { coordinatorName } from "@/lib/asks";
import { STATE_LABEL, type NodeState, type OrgNode } from "@/lib/org-tree";
import { cardSummary, waitingGroups, type WorkCard } from "@/lib/project-work";
import { nodePath, panePath } from "@/lib/nav";
import { coordinatorPane } from "@/lib/projects";
import { timeAgoShort } from "@/lib/format";
import type { AgentView, AsksList, ProjectView } from "@/lib/types";
import { cn } from "@/lib/utils";

// The parts a desk's project page and coordinator page share (ADR 0102): the heading, the tabs kept in
// the address, a coordinator's card over its threads, and what waits on you by coordinator.

/** Enters a coordinator (ADR 0115), `root` being the project's own: its chat while it runs, its page otherwise. */
export function useOpenCoordinator(project: ProjectView, panes: readonly AgentView[], session?: string): (id: string) => void {
  const navigate = useNavigate();
  return (id) => {
    const pane = coordinatorPane(project, id, panes);
    navigate(pane ? panePath(pane, session) : nodePath(project.slug, id, session));
  };
}

/** Opens a node inside Nenu (ADR 0064): its chat while it runs in a live pane, its page otherwise. */
export function useOpenNode(project: ProjectView, panes: readonly AgentView[], session?: string): (node: OrgNode) => void {
  const navigate = useNavigate();
  return ({ thread }) => navigate(thread.paneId && panes.some((pane) => pane.paneId === thread.paneId)
    ? panePath(thread.paneId, session) : nodePath(project.slug, thread.id, session));
}

/** A page's crumb (where the header's back does not already say it), title, second line and actions. */
export function DeskHead({ crumb, title, mark, subtitle, actions }: { crumb?: ReactNode; title: string; mark?: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return <header className="mb-5">
    {crumb && <nav aria-label="Breadcrumb" className="mb-1 flex items-center gap-1 text-footnote text-muted-foreground">{crumb}<ChevronRight aria-hidden className="size-3" /></nav>}
    <div className="flex items-center gap-3">
      <h1 className="flex min-w-0 flex-1 items-center gap-2.5 text-title break-words">{mark}{title}</h1>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
    {subtitle && <div className="mt-1.5 text-subhead text-muted-foreground">{subtitle}</div>}
  </header>;
}

/**
 * A page's header action: every one the same button (height, radius, padding and fill), so Open chat
 * and New thread read as a pair and neither looks like another kind of control (ADR 0109).
 */
export function DeskAction({ className, ...props }: ComponentProps<typeof Button>) {
  return <Button type="button" variant="secondary" className={cn("desk-head-action desk-head-action-quiet", className)} {...props} />;
}

export interface DeskTab<T extends string> {
  id: T; label: string; count?: number; waiting?: boolean;
  /** Starts the tab's read when a pointer comes over it or it takes focus, before the tap. */
  prefetch?: () => void;
}

/** The page's tab, in the address (`?tab=`) so a reload and Back keep it; the first tab is the bare address. */
export function useDeskTab<T extends string>(tabs: ReadonlyArray<DeskTab<T>>): [T, (tab: T) => void] {
  const [params, setParams] = useSearchParams();
  const asked = params.get("tab");
  const tab = tabs.find((candidate) => candidate.id === asked)?.id ?? tabs[0]!.id;
  const choose = (next: T) => setParams((current) => {
    const kept = new URLSearchParams(current);
    if (next === tabs[0]!.id) kept.delete("tab");
    else kept.set("tab", next);
    return kept;
  }, { replace: true });
  return [tab, choose];
}

export function DeskTabs<T extends string>({ label, tabs, tab, onChange }: { label: string; tabs: ReadonlyArray<DeskTab<T>>; tab: T; onChange: (tab: T) => void }) {
  return <div role="tablist" aria-label={label} className="desk-tabs">
    {tabs.map((candidate) => (
      <button key={candidate.id} type="button" role="tab" className="desk-tab" aria-selected={candidate.id === tab} onClick={() => onChange(candidate.id)}
        onPointerEnter={candidate.prefetch} onFocus={candidate.prefetch}>
        {candidate.label}
        {candidate.count !== undefined && candidate.count > 0 && <span className="desk-tab-count" data-waiting={candidate.waiting ? "" : undefined}>{candidate.count}</span>}
      </button>
    ))}
  </div>;
}

/** What a row says at its end: needs you, to review (or merged, about to close), idle and how long, or how long ago it moved. */
function rowEnd(node: OrgNode, now: number): string | undefined {
  const age = threadAge(node.thread, now);
  if (node.state === "needs") return "needs you";
  if (node.state === "closing") return STATE_LABEL.closing.toLowerCase();
  if (node.state === "review") return "to review";
  if (node.state === "idle") return age && `idle ${age}`;
  return age;
}

/** A thread in a card: its state as a dot, its name, its open pull request, and its end. */
export function WorkRow({ node, onOpen, depth = 0, now = Date.now() }: { node: OrgNode; onOpen: (node: OrgNode) => void; depth?: number; now?: number }) {
  const { thread } = node;
  // A pull request that merged or closed still shows, with its state: without it the row read as work left to do.
  const pr = thread.pr;
  // A merged one's end already says so.
  const settled = pr && pr.state !== "open" && pr.state !== "draft" && node.state !== "closing" ? pr.state : undefined;
  // A thread under a nested coordinator sits one step in, as the tree draws it.
  return <button type="button" className="desk-row" style={depth ? { paddingLeft: 22 + depth * 20 } : undefined} onClick={() => onOpen(node)}>
    <NodeDot state={node.state} />
    <span className="min-w-0 flex-1 truncate">{thread.title}</span>
    {pr?.number !== undefined && <span className="desk-chip"><GitPullRequest aria-hidden size={12} />#{pr.number}{settled && ` ${settled}`}</span>}
    <span className="desk-row-end">{rowEnd(node, now)}</span>
  </button>;
}

/** Rows a card shows before Show more: a coordinator can run dozens at once. */
const CARD_ROWS = 20;

/**
 * A coordinator's row on its project (ADR 0115, ADR 0122): its own mark, its name and what is live there,
 * which enters its chat wherever it is tapped; a chevron before it, on a row with threads, folds them
 * down in place; + starts a thread under it, shown on a desk's hover. Its mark opens the picker where
 * the operator may pick. A coordinator under another sits one step in. On a desk what is live reads as
 * aligned columns, on a phone as the line under its name. The project coordinator's row holds the
 * threads started from the project and draws the project's mark.
 */
export function CoordinatorWorkCard({ project, card, waiting, open, onToggle, onOpenNode, onOpenCoordinator, onNewThread, own, session, editable, onChanged, now = Date.now() }: {
  project: ProjectView;
  card: WorkCard;
  waiting: number;
  open: boolean;
  onToggle: () => void;
  onOpenNode: (node: OrgNode) => void;
  onOpenCoordinator: () => void;
  /** Absent where nothing can be started (a paused project, a read-only device). */
  onNewThread?: () => void;
  /** What the coordinator itself is doing, when it is live: its own needs or work. */
  own?: NodeState;
  session?: string;
  /** The device may pick the coordinator's mark. */
  editable: boolean;
  onChanged: () => void;
  now?: number;
}) {
  const [limit, setLimit] = useState(CARD_ROWS);
  const summaryId = useId();
  const id = card.coordinator?.thread.id ?? "root";
  const name = card.coordinator?.thread.title ?? "Project coordinator";
  const parts = liveLine(card.rows, waiting, own);
  const hidden = card.rows.length - limit;
  // A row with no threads has nothing to unfold, and draws no chevron.
  const foldable = card.rows.length > 0;
  // A column's count, or just its glyph for the coordinator's own state ("needs you", "working").
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  // What it holds, said where nothing is live: a coordinator over others is not one with nothing.
  const holds = [card.coordinators > 0 && plural(card.coordinators, "coordinator"), foldable && plural(card.rows.length, "thread")].filter(Boolean).join(" · ") || "No threads";
  const column = (state: NodeState) => {
    const said = parts.filter((part) => part.state === state);
    return { shown: said.length > 0, count: said.reduce((sum, part) => sum + part.count, 0) };
  };
  return <li aria-label={name} className="coord-item" style={{ "--depth": card.depth } as CSSProperties}>
    <div className="coord-head">
      {foldable
        ? <button type="button" className="desk-icon-button coord-fold" aria-label={`${open ? "Hide" : "Show"} ${name} threads`} aria-expanded={open} onClick={onToggle}>
          <ChevronRight aria-hidden className={cn("desk-fold size-3.5", open && "rotate-90")} />
        </button>
        : <span aria-hidden className="coord-fold" />}
      <MarkTile project={project} id={id} name={name} session={session} editable={editable && id !== "root"} onChanged={onChanged} />
      {/* Named for what it does; what is live there is said as its description. */}
      <button type="button" className="coord-open" aria-label={`Open ${name}`} aria-describedby={summaryId} onClick={onOpenCoordinator}>
        <span className="min-w-0 flex-1">
          <span className="coord-name">{name}</span>
          <span id={summaryId} className="coord-line">
            {parts.length === 0 && <span>{holds}</span>}
            {parts.map((part) => <span key={part.text} className="inline-flex items-center gap-1.5"><NodeDot state={part.state} />{part.text}</span>)}
          </span>
          <span aria-hidden className="coord-line-desk">{holds}</span>
        </span>
        <span aria-hidden className="coord-counts">
          {(["needs", "review", "working"] as const).map((state) => {
            const { shown, count } = column(state);
            return <span key={state} className="coord-count" data-state={state}>{shown && <><NodeDot state={state} />{count > 0 && count}</>}</span>;
          })}
        </span>
        <span className="coord-when">{card.at > 0 && timeAgoShort(card.at, now)}</span>
      </button>
      {onNewThread && <button type="button" className="desk-icon-button desk-card-add" aria-label={`New thread under ${name}`} aria-haspopup="dialog" onClick={onNewThread}><Plus aria-hidden size={16} /></button>}
    </div>
    {open && foldable && <div role="group" aria-label={`${name} threads`} className="desk-reveal coord-threads">
      {card.rows.slice(0, limit).map((node) => <WorkRow key={node.thread.id} node={node} onOpen={onOpenNode} />)}
      {hidden > 0 && <button type="button" className="desk-row justify-center text-muted-foreground" onClick={() => setLimit(limit + CARD_ROWS)}>
        Show {Math.min(CARD_ROWS, hidden)} more
      </button>}
    </div>}
  </li>;
}

/** A row's one line: what waits on you, then what works, the coordinator's own work said once. */
function liveLine(rows: readonly OrgNode[], waiting: number, own?: NodeState): ReturnType<typeof cardSummary> {
  const parts = cardSummary(rows, waiting);
  // The coordinator's own state counts no thread: its column draws the glyph alone.
  if (own === "needs" && !parts.some((part) => part.state === "needs")) parts.unshift({ text: "needs you", state: "needs", count: 0 });
  if (own === "working" && !parts.some((part) => part.state === "working")) parts.push({ text: "working", state: "working", count: 0 });
  return parts;
}

/** Questions a group shows before Show more. */
const GROUP_ROWS = 5;

/** What waits on you in a project, one card per coordinator, each answered in place (ADR 0093). */
export function WaitingByCoordinator({ list, project, session, readOnly }: { list: AsksList; project: ProjectView; session?: string; readOnly: boolean }) {
  const groups = waitingGroups(list, project);
  if (groups.length === 0) return <p className="px-1 text-subhead text-muted-foreground">Nothing waits on you here.</p>;
  return <div>{groups.map((group) => <WaitingGroup key={group.coordinator.id} group={group} list={list} project={project} session={session} readOnly={readOnly} />)}</div>;
}

function WaitingGroup({ group, list, project, session, readOnly }: {
  group: ReturnType<typeof waitingGroups>[number]; list: AsksList; project: ProjectView; session?: string; readOnly: boolean;
}) {
  const [all, setAll] = useState(false);
  const name = group.coordinator.id === "root" ? "Project coordinator" : coordinatorName(group.coordinator);
  const entries = all ? group.entries : group.entries.slice(0, GROUP_ROWS);
  return <section aria-label={name} className="desk-card">
    <div className="desk-card-head min-h-11">
      <h2 className="flex flex-1 items-center gap-2 text-footnote font-semibold"><CoordinatorGlyph project={project} id={group.coordinator.id} />{name}<span className="desk-tab-count" data-waiting="">{group.count}</span></h2>
      <Link to={nodePath(project.slug, group.coordinator.id, session)} className="quiet-action">Open coordinator<ChevronRight aria-hidden className="size-3.5" /></Link>
    </div>
    <div className="px-3 py-1">
      <AskSections sections={[{ group: "waiting", label: "Waiting on you", entries }]} headings={false} session={session} whose={false} answers={list.answers === true} readOnly={readOnly} />
    </div>
    {group.entries.length > entries.length && <button type="button" className="desk-row justify-center border-t border-border text-muted-foreground" onClick={() => setAll(true)}>
      Show {group.entries.length - entries.length} more
    </button>}
  </section>;
}
