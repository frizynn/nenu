import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { ChatCircle, ChevronRight, GitPullRequest, History, Plus } from "@/components/ui/icon";

import { AskSections } from "@/components/ask-list";
import { CoordinatorHead } from "@/components/coordinator-card";
import { OwnReport } from "@/components/coordinator-summary";
import { DeskAction, DeskHead, DeskTabs, useDeskTab, useOpenNode, WorkRow, type DeskTab } from "@/components/desk-pages";
import { RoutinesPanel } from "@/components/desk-routines";
import { openNewDialog } from "@/components/new-agent-sheet";
import { startableRoles } from "@/components/node-start";
import { NodeDot } from "@/components/node-row";
import { ProjectGlyph } from "@/components/project-glyph";
import { CloseNodeDialog, coordinatedThreads, threadAge, threadTree } from "@/components/project-tasks";
import { Button } from "@/components/ui/button";
import { useAsks } from "@/hooks/use-asks";
import { useRoutines } from "@/hooks/use-routines";
import { useThreadSummaries } from "@/hooks/use-thread-summaries";
import { askSections } from "@/lib/asks";
import { coordinatorState, flatten, nodeState, orgTree, STATE_LABEL, type NodeState, type OrgNode } from "@/lib/org-tree";
import { historyDays, routinesFor, waitingGroups } from "@/lib/project-work";
import { nodePath, panePath, projectHistoryPath, projectPath } from "@/lib/nav";
import { isOpenThread } from "@/lib/projects";
import { isReadOnly, type AgentView, type DeviceAuth, type ProjectThreadView, type ProjectView, type RoutineView } from "@/lib/types";

type Tab = "threads" | "waiting" | "routines" | "status";

/**
 * A coordinator on a desk (ADR 0102): its name, state, threads working and pull request, Open chat and
 * New thread, then Threads (only its live work, finished work one line away in the project's History,
 * ADR 0109), what waits on you there, the routines that reach it, and Status (its card, with what was
 * asked of it, and STATUS.md). `thread` is undefined for the project's own coordinator.
 */
export function DeskCoordinator({ project, thread, panes, device, session, onChanged }: {
  project: ProjectView;
  thread?: ProjectThreadView;
  panes: readonly AgentView[];
  device?: DeviceAuth;
  session?: string;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const readOnly = isReadOnly(device);
  const [closing, setClosing] = useState(false);
  const id = thread?.id ?? "root";
  // The project coordinator runs the threads started from the project; another, its whole subtree.
  const work = thread ? threadTree(project, thread.id) : coordinatedThreads(project).filter((candidate) => candidate.role !== "coordinator");
  // Read again when its own report or STATUS.md moves: the page draws no other thread's report (ADR 0109).
  const read = useThreadSummaries(project, thread ? [thread] : []);
  // As many as the History "N finished" opens lists, searched for this coordinator's name.
  const finished = historyDays(project, thread?.title ?? "").reduce((sum, day) => sum + day.rows.length, 0);
  const asks = useAsks([project]);
  const routines = useRoutines(project.slug, session);
  // Only what waits on you: what it is doing and what it did are its Status (ADR 0109).
  const mine = asks.list ? askSections(asks.list, [project], { project: project.slug, coordinator: id }).filter((section) => section.group === "waiting") : [];
  const waiting = asks.list ? waitingGroups(asks.list, project).find((group) => group.coordinator.id === id)?.count ?? 0 : 0;
  const reaching = (list: readonly RoutineView[]) => routinesFor(list, id, project.threads);
  const tabs: Array<DeskTab<Tab>> = [
    { id: "threads", label: "Threads", count: work.filter(isOpenThread).length },
    { id: "waiting", label: "Waiting on you", count: waiting, waiting: true },
    { id: "routines", label: "Routines", count: routines.list ? reaching(routines.list.routines).length : undefined },
    { id: "status", label: "Status" },
  ];
  const [tab, setTab] = useDeskTab(tabs);

  const live = (paneId: string | undefined) => paneId !== undefined && panes.some((pane) => pane.paneId === paneId);
  const chat = thread ? (live(thread.paneId) ? thread.paneId : undefined) : project.coordinator && live(project.coordinator.paneId) ? project.coordinator.paneId : undefined;
  const status = thread ? read.summaries.get(thread.id)?.status : read.status ?? undefined;
  const usage = thread ? read.summaries.get(thread.id)?.usage : read.usage ?? undefined;
  const ownStatus = thread ? undefined : project.coordinator?.liveStatus ?? (read.coordinator?.state || undefined);
  const state: NodeState | undefined = thread ? nodeState(thread) : ownStatus && coordinatorState(ownStatus);
  const age = thread && threadAge(thread, Date.now());
  const working = work.filter((candidate) => nodeState(candidate) === "working").length;
  const pr = thread?.pr && (thread.pr.state === "open" || thread.pr.state === "draft") ? thread.pr : undefined;
  const canStart = !readOnly && startableRoles(project).includes("worker") && state !== "resolved";
  const openNode = useOpenNode(project, panes, session);
  const parent = thread && project.threads.find((candidate) => candidate.id === thread.parentId);
  // Close refuses a coordinator with open work under it, which the open tree holds.
  const closable = thread && flatten(orgTree(project.threads).open).find((candidate) => candidate.thread.id === thread.id);

  return <>
    <DeskHead title={thread?.title ?? "Project coordinator"}
      crumb={<>
        <Link to={projectPath(project.slug, session)} className="inline-flex items-center gap-1.5 hover:text-foreground"><ProjectGlyph slug={project.slug} pick={project} size={12} />{project.name}</Link>
        {parent && <><ChevronRight aria-hidden className="size-3" /><Link to={nodePath(project.slug, parent.id, session)} className="hover:text-foreground">{parent.title}</Link></>}
      </>}
      subtitle={<span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-footnote">
        {state && <span className="inline-flex items-center gap-1.5"><NodeDot state={state} className="size-1.5" />{STATE_LABEL[state]}{age && ` · ${age}`}</span>}
        {working > 0 && <span className="inline-flex items-center gap-1.5"><NodeDot state="working" className="size-1.5" />{working} {working === 1 ? "thread" : "threads"} working</span>}
        {pr?.number !== undefined && (pr.url
          ? <a href={pr.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground"><GitPullRequest aria-hidden size={12} />#{pr.number}</a>
          : <span className="inline-flex items-center gap-1"><GitPullRequest aria-hidden size={12} />#{pr.number}</span>)}
      </span>}
      actions={<>
        {chat && <DeskAction onClick={() => navigate(panePath(chat, session))}><ChatCircle aria-hidden className="size-4" />Open chat</DeskAction>}
        {canStart && <DeskAction aria-haspopup="dialog"
          onClick={() => openNewDialog({ kind: "thread", project: project.slug, role: "worker", parent: id, onStarted: onChanged })}>
          <Plus aria-hidden className="size-4" />New thread</DeskAction>}
      </>} />
    <DeskTabs label={thread?.title ?? "Project coordinator"} tabs={tabs} tab={tab} onChange={setTab} />
    <div role="tabpanel" aria-label={tabs.find((candidate) => candidate.id === tab)!.label}>
      {tab === "threads" && <>
        {waiting > 0 && <button type="button" onClick={() => setTab("waiting")}
          className="desk-card mb-4 flex w-full items-center gap-3 border-status-blocked/40 bg-status-blocked/10 px-4 py-3 text-left text-subhead">
          <NodeDot state="needs" className="size-1.5" /><span className="flex-1">{waiting} {waiting === 1 ? "decision waits" : "decisions wait"} on you</span>
          <span className="inline-flex items-center gap-1 text-footnote text-muted-foreground">Review<ChevronRight aria-hidden className="size-3.5" /></span>
        </button>}
        <LiveWork threads={work} finished={finished} onOpenNode={openNode} onHistory={() => navigate(projectHistoryPath(project.slug, session, thread?.title))} />
      </>}
      {tab === "waiting" && (asks.list
        ? mine.length > 0
          ? <AskSections sections={mine} session={session} whose={false} answers={asks.list.answers === true} readOnly={readOnly} />
          : <p className="px-1 text-subhead text-muted-foreground">Nothing waits on you here.</p>
        : <p className="px-1 text-subhead text-muted-foreground">{!asks.loaded ? "Reading…" : asks.failed ?? "This Herdr Organizations can’t list asks yet; update it to see them here."}</p>)}
      {tab === "routines" && <RoutinesPanel routines={routines} shown={reaching} threads={project.threads} readOnly={readOnly}
        empty="No routine reaches this coordinator." />}
      {tab === "status" && <>
        <CoordinatorHead project={project} coordinatorId={id} status={status} usage={usage} listsAgents={false}
          asks={asks} summaries={read.summaries} session={session} readOnly={readOnly} onOpenNode={openNode}
          onOpenStatusNode={(node) => navigate(nodePath(project.slug, node, session))} />
        {thread && <OwnReport project={project} thread={thread} summary={read.summaries.get(thread.id)} />}
        {!status && !thread?.verdict && <p className="px-1 text-subhead text-muted-foreground">This coordinator has no STATUS.md yet.</p>}
        {closable && !readOnly && <Button type="button" variant="outline" className="mt-4 border-destructive/40 bg-transparent text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => setClosing(true)}>Close coordinator</Button>}
      </>}
    </div>
    {closable && <CloseNodeDialog project={project} node={closing ? closable : null}
      session={session} onCancel={() => setClosing(false)} onClosed={() => { setClosing(false); onChanged(); }} />}
  </>;
}

/**
 * A coordinator's live work: its open threads, the most urgent first, each a row that opens it; what
 * finished is one line that opens the project's History, never cards on this page (ADR 0109).
 */
function LiveWork({ threads, finished, onOpenNode, onHistory }: {
  threads: readonly ProjectThreadView[];
  /** The rows the History it opens lists. */
  finished: number;
  onOpenNode: (node: OrgNode) => void;
  onHistory: () => void;
}) {
  const walk = (nodes: readonly OrgNode[], depth: number): Array<{ node: OrgNode; depth: number }> =>
    nodes.flatMap((node) => [{ node, depth }, ...walk(node.children, depth + 1)]);
  const rows = walk(orgTree(threads).open, 0);
  return <>
    <div className="desk-toolbar">
      <span className="min-w-0 flex-1 truncate">{rows.length === 0 ? "Nothing running" : `${rows.length} open`}</span>
    </div>
    {rows.length > 0 && <div className="desk-card">{rows.map(({ node, depth }) => <WorkRow key={node.thread.id} node={node} depth={depth} onOpen={onOpenNode} />)}</div>}
    {finished > 0 && <button type="button" className="quiet-action desk-history-link" onClick={onHistory}>
      <History aria-hidden className="size-3.5" />{finished} finished<ChevronRight aria-hidden className="size-3.5" />
    </button>}
  </>;
}
