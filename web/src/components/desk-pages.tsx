import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ChatCircle, ChevronRight, GitPullRequest, Plus, Workflow } from "@/components/ui/icon";

import { AskSections } from "@/components/ask-list";
import { NodeDot } from "@/components/node-row";
import { threadAge } from "@/components/project-tasks";
import { Button } from "@/components/ui/button";
import { coordinatorName } from "@/lib/asks";
import { MERGED_TO_CLOSE, mergedToClose, type OrgNode } from "@/lib/org-tree";
import { cardSummary, waitingGroups, type WorkCard } from "@/lib/project-work";
import { nodePath, panePath } from "@/lib/nav";
import type { AgentView, AsksList, ProjectView } from "@/lib/types";
import { cn } from "@/lib/utils";

// The parts a desk's project page and coordinator page share (ADR 0102): the heading, the tabs kept in
// the address, a coordinator's card over its threads, and what waits on you by coordinator.

/** Opens a node inside Nenu (ADR 0064): its chat while it runs in a live pane, its page otherwise. */
export function useOpenNode(project: ProjectView, panes: readonly AgentView[], session?: string): (node: OrgNode) => void {
  const navigate = useNavigate();
  return ({ thread }) => navigate(thread.paneId && panes.some((pane) => pane.paneId === thread.paneId)
    ? panePath(thread.paneId, session) : nodePath(project.slug, thread.id, session));
}

/** A page's crumb, title, second line and actions. */
export function DeskHead({ crumb, title, mark, subtitle, actions }: { crumb: ReactNode; title: string; mark?: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return <header className="mb-5">
    <nav aria-label="Breadcrumb" className="mb-1 flex items-center gap-1 text-footnote text-muted-foreground">{crumb}<ChevronRight aria-hidden className="size-3" /></nav>
    <div className="flex items-center gap-3">
      <h1 className="flex min-w-0 flex-1 items-center gap-2.5 text-title break-words">{mark}{title}</h1>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
    {subtitle && <div className="mt-1.5 text-subhead text-muted-foreground">{subtitle}</div>}
  </header>;
}

/**
 * A page's header action: every one the same button (height, radius, padding and fill), so Open chat
 * and New thread read as a pair and neither looks like another kind of control (ADR 0108).
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
  if (mergedToClose(node)) return MERGED_TO_CLOSE;
  if (node.state === "review") return "to review";
  if (node.state === "idle") return age && `idle ${age}`;
  return age;
}

/** A thread in a card: its state as a dot, its name, its open pull request, and its end. */
export function WorkRow({ node, onOpen, depth = 0, now = Date.now() }: { node: OrgNode; onOpen: (node: OrgNode) => void; depth?: number; now?: number }) {
  const { thread } = node;
  // A pull request that merged or closed still shows, with its state: without it the row read as work left to do.
  const pr = thread.pr;
  const merging = mergedToClose(node);
  const settled = pr && pr.state !== "open" && pr.state !== "draft" && !merging ? pr.state : undefined;
  // A thread under a nested coordinator sits one step in, as the tree draws it.
  return <button type="button" className="desk-row" style={depth ? { paddingLeft: 22 + depth * 20 } : undefined} onClick={() => onOpen(node)}>
    <NodeDot state={merging ? "merging" : node.state} className="size-1.5" />
    <span className="min-w-0 flex-1 truncate">{thread.title}</span>
    {pr?.number !== undefined && <span className="desk-chip"><GitPullRequest aria-hidden size={12} />#{pr.number}{settled && ` ${settled}`}</span>}
    <span className="desk-row-end">{rowEnd(node, now)}</span>
  </button>;
}

/** Rows a card shows before Show more: a coordinator can run dozens at once. */
const CARD_ROWS = 20;

/**
 * A coordinator's card: its fold, then its name and what its threads are doing, which opens its page
 * wherever it is tapped (ADR 0108), and + to start a thread under it; its threads under it. The project
 * coordinator's card holds the threads started from the project.
 */
export function CoordinatorWorkCard({ card, waiting, open, onToggle, onOpenNode, onOpenCoordinator, onNewThread, ownState }: {
  card: WorkCard;
  waiting: number;
  open: boolean;
  onToggle: () => void;
  onOpenNode: (node: OrgNode) => void;
  onOpenCoordinator: () => void;
  /** Absent where nothing can be started (a paused project, a read-only device). */
  onNewThread?: () => void;
  /** What the coordinator itself is doing, said after its threads. */
  ownState?: string;
}) {
  const [limit, setLimit] = useState(CARD_ROWS);
  const summaryId = useId();
  const name = card.coordinator?.thread.title ?? "Project coordinator";
  const parts = cardSummary(card.rows, waiting);
  const Mark = card.coordinator ? Workflow : ChatCircle;
  const hidden = card.rows.length - limit;
  // A card with no threads has nothing to unfold: its head says so and draws no chevron.
  const foldable = card.rows.length > 0;
  const head = <>
    <span className="desk-card-mark"><Mark aria-hidden size={15} /></span>
    <span className="min-w-0 flex-1">
      <span className="block truncate text-subhead font-medium">{name}</span>
      <span id={summaryId} className="flex flex-wrap items-center gap-x-3 text-footnote text-muted-foreground">
        {!card.coordinator && <span>{foldable ? "Threads started straight from the project" : "No threads started from the project"}</span>}
        {card.coordinator && parts.length === 0 && <span>{foldable ? `${card.rows.length} ${card.rows.length === 1 ? "thread" : "threads"}` : "No open threads"}</span>}
        {parts.map((part) => <span key={part.text} className="inline-flex items-center gap-1.5"><NodeDot state={part.state} className="size-1.5" />{part.text}</span>)}
        {ownState && <span>{ownState}</span>}
      </span>
    </span>
  </>;
  return <section aria-label={name} className="desk-card">
    <div className="desk-card-head">
      {foldable
        ? <button type="button" className="desk-icon-button -mr-2 -ml-1.5" aria-label={`${open ? "Hide" : "Show"} ${name} threads`} aria-expanded={open} onClick={onToggle}>
          <ChevronRight aria-hidden className={cn("desk-fold size-3.5", open && "rotate-90")} />
        </button>
        : <span aria-hidden className="w-3.5 shrink-0" />}
      {/* Named for what it does; what its threads are doing is said as its description. */}
      <button type="button" className="desk-card-open" aria-label={`Open ${name}`} aria-describedby={summaryId} onClick={onOpenCoordinator}>{head}</button>
      {onNewThread && <button type="button" className="desk-icon-button" aria-label={`New thread under ${name}`} aria-haspopup="dialog" onClick={onNewThread}><Plus aria-hidden size={15} /></button>}
      {/* The head already opens the page; the chevron only says so, and is not a second stop for the keyboard. */}
      <button type="button" tabIndex={-1} aria-hidden className="desk-icon-button" onClick={onOpenCoordinator}><ChevronRight aria-hidden size={15} /></button>
    </div>
    {open && foldable && <div role="group" aria-label={`${name} threads`} className="desk-reveal">
      {card.rows.slice(0, limit).map((node) => <WorkRow key={node.thread.id} node={node} onOpen={onOpenNode} />)}
      {hidden > 0 && <button type="button" className="desk-row justify-center text-muted-foreground" onClick={() => setLimit(limit + CARD_ROWS)}>
        Show {Math.min(CARD_ROWS, hidden)} more
      </button>}
    </div>}
  </section>;
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
      <h2 className="flex flex-1 items-center gap-2 text-footnote font-semibold">{name}<span className="desk-tab-count" data-waiting="">{group.count}</span></h2>
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
