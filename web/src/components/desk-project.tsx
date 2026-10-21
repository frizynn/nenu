import { useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ChatCircle, ChevronDown, ChevronLeft, History, Plus, Search, Workflow } from "@/components/ui/icon";

import { NodeDot } from "@/components/node-row";
import { CoordinatorWorkCard, DeskAction, DeskHead, DeskTabs, useDeskTab, useOpenNode, WaitingByCoordinator, type DeskTab } from "@/components/desk-pages";
import { RoutinesPanel } from "@/components/desk-routines";
import { openNewDialog } from "@/components/new-agent-sheet";
import { startableRoles } from "@/components/node-start";
import { prefetchContext, ProjectContext } from "@/components/project-context";
import { ProjectGlyph } from "@/components/project-glyph";
import { StartProjectCoordinator } from "@/components/project-coordinator";
import { WorkbenchPopover } from "@/components/ui/workbench-popover";
import { useAsks } from "@/hooks/use-asks";
import { useRoutines } from "@/hooks/use-routines";
import { coordinatorState, STATE_LABEL, type OrgNode } from "@/lib/org-tree";
import { finishedCount, historyDays, waitingGroups, workCards, type HistoryRow } from "@/lib/project-work";
import { clockTime } from "@/lib/format";
import { nodePath, panePath, projectsPath } from "@/lib/nav";
import { runningCoordinator } from "@/lib/projects";
import { isReadOnly, type AgentView, type DeviceAuth, type NodeRole, type ProjectView } from "@/lib/types";

type Tab = "work" | "waiting" | "routines" | "context";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * A project on a desk (ADR 0102): its name and goal, Project chat and New, then Work (a card per
 * coordinator with its threads, the project coordinator's last), Waiting on you by coordinator,
 * Routines and Context. It never redirects to the coordinator's chat: Project chat opens it.
 */
export function DeskProject({ project, panes, device, session, onChanged }: {
  project: ProjectView;
  panes: readonly AgentView[];
  device?: DeviceAuth;
  session?: string;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const readOnly = isReadOnly(device);
  const asks = useAsks([project]);
  const routines = useRoutines(project.slug, session);
  const waiting = asks.list ? waitingGroups(asks.list, project) : [];
  const waitingCount = asks.list ? waiting.reduce((sum, group) => sum + group.count, 0) : project.waitingAsks ?? 0;
  const tabs: Array<DeskTab<Tab>> = [
    { id: "work", label: "Work" },
    { id: "waiting", label: "Waiting on you", count: waitingCount, waiting: true },
    { id: "routines", label: "Routines", count: routines.list?.routines.length },
    { id: "context", label: "Context", prefetch: () => prefetchContext(project.slug) },
  ];
  const [tab, setTab] = useDeskTab(tabs);
  const coordinator = runningCoordinator(project);
  const openNode = useOpenNode(project, panes, session);
  const roles = readOnly ? [] : startableRoles(project);

  return <>
    <DeskHead crumb={<Link to={projectsPath(session)} className="hover:text-foreground">Projects</Link>} title={project.name}
      mark={<ProjectGlyph slug={project.slug} pick={project} size={20} />} subtitle={project.goal}
      actions={<>
        {coordinator
          ? <DeskAction onClick={() => navigate(panePath(coordinator.paneId, session))}><ChatCircle aria-hidden className="size-4" />Project chat</DeskAction>
          : !readOnly && <StartProjectCoordinator project={project} session={session} onStarted={onChanged} action />}
        {roles.length > 0 && <NewMenu project={project} roles={roles} onStarted={onChanged} />}
      </>} />
    <DeskTabs label={project.name} tabs={tabs} tab={tab} onChange={setTab} />
    <div role="tabpanel" aria-label={tabs.find((candidate) => candidate.id === tab)!.label}>
      {tab === "work" && <Work project={project} waiting={(id) => waiting.find((group) => group.coordinator.id === id)?.count ?? 0}
        coordinator={coordinator} canStart={roles.includes("worker")} onOpenNode={openNode} onChanged={onChanged}
        onOpenCoordinator={(id) => navigate(nodePath(project.slug, id, session))} />}
      {tab === "waiting" && (asks.list
        ? <WaitingByCoordinator list={asks.list} project={project} session={session} readOnly={readOnly} />
        : <p className="px-1 text-subhead text-muted-foreground">{!asks.loaded ? "Reading…" : asks.failed ?? "This Herdr Organizations can’t list asks yet; update it to see them here."}</p>)}
      {tab === "routines" && <RoutinesPanel routines={routines} shown={(list) => [...list]} threads={project.threads} readOnly={readOnly} empty="No routines yet." />}
      {tab === "context" && <ProjectContext project={project} threads={project.threads} />}
    </div>
  </>;
}

/**
 * The open work, a card per coordinator; finished work is History (`?work=finished`), one quiet step away
 * (ADR 0106): by day, newest first, with a search.
 */
function Work({ project, coordinator, waiting, canStart, onOpenNode, onOpenCoordinator, onChanged }: {
  project: ProjectView;
  coordinator: ReturnType<typeof runningCoordinator>;
  waiting: (coordinatorId: string) => number;
  canStart: boolean;
  onOpenNode: (node: OrgNode) => void;
  onOpenCoordinator: (id: string) => void;
  onChanged: () => void;
}) {
  const [params, setParams] = useSearchParams();
  const history = params.get("work") === "finished";
  const showHistory = (on: boolean) => setParams((current) => {
    const kept = new URLSearchParams(current);
    if (on) kept.set("work", "finished");
    else { kept.delete("work"); kept.delete("q"); }
    return kept;
  }, { replace: true });
  // Cards start open; a fold the person changed lasts while the page does.
  const [folds, setFolds] = useState<Record<string, boolean>>({});
  // A fold re-renders Work; the tree is read again only when a poll brings new threads.
  const finished = useMemo(() => finishedCount(project), [project]);
  const cards = useMemo(() => workCards(project), [project]);
  if (history) return <WorkHistory project={project} count={finished} search={params.get("q") ?? ""} onBack={() => showHistory(false)} onOpenNode={onOpenNode} />;

  const rootState = coordinator && coordinatorState(coordinator.liveStatus);
  const newThread = (parent: string) => openNewDialog({ kind: "thread", project: project.slug, role: "worker", parent, onStarted: onChanged });
  const threads = cards.reduce((sum, card) => sum + card.rows.length, 0);
  return <>
    <div className="desk-toolbar">
      <span className="min-w-0 flex-1 truncate">{cards.length > 1 && `${plural(cards.length - 1, "coordinator")} · `}{plural(threads, "thread")} open</span>
    </div>
    {cards.map((card) => {
      const id = card.coordinator?.thread.id ?? "root";
      const open = folds[id] ?? true;
      const own = card.coordinator ? (card.coordinator.state === "working" ? "working" : undefined)
        : rootState ? `coordinator ${STATE_LABEL[rootState].toLowerCase()}` : undefined;
      return <CoordinatorWorkCard key={id} card={card} waiting={waiting(id)} open={open} ownState={own}
        onToggle={() => setFolds((current) => ({ ...current, [id]: !open }))}
        onOpenNode={onOpenNode} onOpenCoordinator={() => onOpenCoordinator(id)}
        onNewThread={canStart ? () => newThread(id) : undefined} />;
    })}
    {/* What finished is reachable, never in the way: one quiet line after the live work (ADR 0109). */}
    {finished > 0 && <button type="button" className="quiet-action desk-history-link" onClick={() => showHistory(true)}>
      <History aria-hidden className="size-3.5" />History<span className="tabular-nums text-subtle-foreground">{finished}</span>
    </button>}
  </>;
}

/** Rows History draws before Show more: a project finishes hundreds of threads. */
const HISTORY_ROWS = 100;

function WorkHistory({ project, count, search, onBack, onOpenNode }: {
  project: ProjectView; count: number;
  /** What a coordinator's "N finished" opened it searching: its own name (ADR 0109). */
  search: string;
  onBack: () => void; onOpenNode: (node: OrgNode) => void;
}) {
  const [query, setQuery] = useState(search);
  const [limit, setLimit] = useState(HISTORY_ROWS);
  const days = useMemo(() => historyDays(project, query), [project, query]);
  const shown = days.reduce((sum, day) => sum + day.rows.length, 0);
  let left = limit;
  return <>
    <div className="desk-toolbar">
      <button type="button" className="quiet-action -ml-2" onClick={onBack}><ChevronLeft aria-hidden className="size-3.5" />Open work</button>
      <span className="flex-1" />
      <label className="desk-search">
        <Search aria-hidden className="size-3.5 shrink-0" />
        <span className="sr-only">Search finished work</span>
        <input type="search" value={query} placeholder={`Search ${count} finished`} onChange={(event) => { setQuery(event.target.value); setLimit(HISTORY_ROWS); }} />
      </label>
    </div>
    {days.length === 0 && <p className="px-1 text-subhead text-muted-foreground">{query ? "Nothing finished matches." : "Nothing has finished yet."}</p>}
    {days.map((day) => {
      if (left <= 0) return null;
      const rows = day.rows.slice(0, left);
      left -= rows.length;
      return <section key={day.key} aria-label={day.label} className="desk-history-day">
        <h2 className="desk-history-label">{day.label}<span className="tabular-nums">{day.rows.length} finished</span></h2>
        <div className="desk-card">{rows.map((row) => <HistoryItem key={row.node.thread.id} row={row} onOpen={onOpenNode} />)}</div>
      </section>;
    })}
    {shown > limit && <button type="button" className="quiet-action mt-3" onClick={() => setLimit(limit + HISTORY_ROWS)}>Show {Math.min(HISTORY_ROWS, shown - limit)} more</button>}
  </>;
}

/** A finished thread, by whom; or a finished coordinator, with the threads it ran. Its end is when it finished. */
function HistoryItem({ row, onOpen }: { row: HistoryRow; onOpen: (node: OrgNode) => void }) {
  const { thread } = row.node;
  const at = Date.parse(thread.updated ?? "");
  return <button type="button" className="desk-row" onClick={() => onOpen(row.node)}>
    <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
      {row.threads !== undefined ? <Workflow aria-hidden size={14} /> : <NodeDot state="resolved" />}
    </span>
    <span className="min-w-0 flex-1 truncate">{thread.title}
      <span className="desk-row-by">{row.threads !== undefined ? `Coordinator · ${plural(row.threads, "thread")}` : row.by}</span>
    </span>
    {Number.isFinite(at) && <span className="desk-row-end">{clockTime(at)}</span>}
  </button>;
}

/** New: a thread or a coordinator at the project's top level. */
function NewMenu({ project, roles, onStarted }: { project: ProjectView; roles: readonly NodeRole[]; onStarted: () => void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const start = (role: NodeRole) => { setOpen(false); openNewDialog({ kind: "thread", project: project.slug, role, onStarted }); };
  const items: Array<{ role: NodeRole; label: string; detail: string; icon: typeof ChatCircle }> = [
    { role: "worker", label: "Thread", detail: "One task, with its own agent", icon: ChatCircle },
    { role: "coordinator", label: "Coordinator", detail: "Owns a front and starts its threads", icon: Workflow },
  ];
  return <>
    <DeskAction ref={trigger} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Plus aria-hidden className="size-4" />New<ChevronDown aria-hidden className="-mr-0.5 size-3.5 opacity-60" />
    </DeskAction>
    <WorkbenchPopover open={open} onDismiss={() => setOpen(false)} anchorRef={trigger} label="New" className="w-72 [&>div:first-child]:hidden [&>div:last-child]:p-1.5">
      {items.filter((item) => roles.includes(item.role)).map(({ role, label, detail, icon: Icon }) => (
        <button key={role} type="button" onClick={() => start(role)} className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-accent">
          <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span><span className="block text-subhead">{label}</span><span className="block text-footnote text-muted-foreground">{detail}</span></span>
        </button>
      ))}
    </WorkbenchPopover>
  </>;
}
