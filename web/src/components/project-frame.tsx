import { lazy, Suspense, type ReactNode } from "react";
import { useNavigate, useRevalidator, useSearchParams } from "react-router";

import type { ProjectChipsSource } from "@/components/composer-chips";
import { CoordinatorSections, waitingAt } from "@/components/coordinator-sections";
import { openNewDialog } from "@/components/new-agent-sheet";
import { startableRoles } from "@/components/node-start";
import { ProjectTasks, coordinatedThreads, threadTree } from "@/components/project-tasks";
import { InspectorToggle, panelLink, SessionInspector, sessionPr, type SessionInspectorState, type SessionPanelLink } from "@/components/session-inspector";
import { DockedThread, ThreadChips, threadChipsShown } from "@/components/split-view";
import { PrList, prLists } from "@/components/threads-panel";
import { loadThreadOverview } from "@/lib/desk-chunks";
import type { HomeData } from "@/lib/loaders";
import { armMotion, useGoUp } from "@/lib/motion";
import { useAsks } from "@/hooks/use-asks";
import { nodePath, panePath, projectHistoryPath } from "@/lib/nav";
import { finishedCount } from "@/lib/project-work";
import { isOpenThread, type PaneProject } from "@/lib/projects";
import { isReadOnly, type ProjectThreadView } from "@/lib/types";

// The Overview tab is a desk's alone: a phone never loads it.
const ThreadOverview = lazy(() => loadThreadOverview().then((module) => ({ default: module.ThreadOverview })));
const CoordinatorOverview = lazy(() => loadThreadOverview().then((module) => ({ default: module.CoordinatorOverview })));

/** What a project gives the chat it wraps. */
export interface ProjectChatSlots {
  title: string;
  /** The header's last control, right of every other: the desk's way back to a folded panel. */
  headerTrail?: ReactNode;
  overlay?: ReactNode;
  strip?: ReactNode;
  projectChips?: ProjectChipsSource;
  /** The desk's session panel beside the chat, absent while a thread is docked there instead. */
  sessionPanel?: SessionPanelLink;
}

/** The search param naming the thread docked beside its coordinator on a desk. */
export const SPLIT_PARAM = "thread";

/** The search param naming a phone's tab, so a reload or a way back lands on the list you left. */
export const VIEW_PARAM = "view";

const PHONE_VIEWS = ["chat", "threads", "prs", "status"] as const;
type PhoneView = (typeof PHONE_VIEWS)[number];

/** Who a pane answers to and which threads sit beside it. */
export function projectScope(owner: PaneProject, data: Pick<HomeData, "agents">) {
  const { project, thread } = owner;
  const coordinating = !thread || thread.role === "coordinator";
  // A coordinator scopes to the threads it runs; a worker to its siblings under the same coordinator.
  const parentId = coordinating ? thread?.id : thread.parentId === "root" ? undefined : thread.parentId;
  const parent = parentId ? project.threads.find((candidate) => candidate.id === parentId) : undefined;
  // Lists and counts cover the whole subtree; chips and tabs only the direct siblings.
  const threads = threadTree(project, parentId);
  const siblings = coordinatedThreads(project, parentId);
  const coordinatorPane = parentId ? parent?.paneId : project.coordinator?.paneId;
  const panelTitle = parent?.title ?? project.name;
  const live = coordinatorPane !== undefined && data.agents.some((pane) => pane.paneId === coordinatorPane);
  const subtitle = parent
    ? `Coordinator under ${project.name} · ${threads.length} ${threads.length === 1 ? "thread" : "threads"}`
    : project.goal;
  return { coordinating, threads, siblings, coordinator: parent, coordinatorPane: live ? coordinatorPane : undefined, panelTitle, subtitle };
}

/**
 * A pane that belongs to a project renders inside this frame. A desk keeps the session panel beside
 * the chat, with the thread's overview as its first tab, or docks a thread there (`?thread=`); the
 * sidebar lists the threads, so the chat carries none of them. On a phone a coordinator and its threads
 * switch between Chat, Threads and PRs in place, in the same band under the title, keeping the chat
 * mounted so its draft and scroll survive; every chat counts the threads around it, their pull requests
 * and the project's routines in the chips above the composer. Moving down the tree pushes, across it
 * replaces the page, and up it goes back (useGoUp), so the history holds one entry per level.
 */
export function ProjectFrame({ owner, paneId, data, inspector, children }: {
  owner: PaneProject;
  paneId: string;
  data: HomeData;
  inspector: SessionInspectorState;
  children: (slots: ProjectChatSlots) => ReactNode;
}) {
  const { project, thread } = owner;
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [search, setSearch] = useSearchParams();
  const desk = inspector.desk;
  const goUp = useGoUp();
  const scope = projectScope(owner, data);
  const readOnly = isReadOnly(data.device);
  const refresh = () => revalidator.revalidate();
  const asked = search.get(VIEW_PARAM);
  // Status is a coordinator's tab only.
  const view: PhoneView = PHONE_VIEWS.find((candidate) => candidate === asked && (candidate !== "status" || scope.coordinating)) ?? "chat";
  const setView = (next: PhoneView) => setSearch((current) => {
    const params = new URLSearchParams(current);
    if (next === "chat") params.delete(VIEW_PARAM);
    else params.set(VIEW_PARAM, next);
    return params;
  }, { replace: true });
  // A coordinator's threads sit below it; a thread's are its siblings, beside it.
  const go = (path: string) => {
    if (scope.coordinating) {
      armMotion("push");
      void navigate(path);
    } else {
      armMotion("fade");
      void navigate(path, { replace: true });
    }
  };
  const openPane = (id: string) => {
    if (id === paneId) setView("chat");
    else if (id === scope.coordinatorPane && !scope.coordinating) goUp(panePath(id, data.session));
    else go(panePath(id, data.session));
  };
  const openNode = (id: string) => {
    const path = nodePath(project.slug, id, data.session);
    if (!scope.coordinating && id === scope.coordinator?.id) goUp(path);
    else go(path);
  };

  // A docked thread is only meaningful beside its own coordinator on a desk.
  const splitPane = search.get(SPLIT_PARAM);
  const docked = desk && scope.coordinating && splitPane
    ? scope.threads.find((candidate): candidate is ProjectThreadView & { paneId: string } => candidate.paneId === splitPane && data.agents.some((pane) => pane.paneId === splitPane))
    : undefined;
  const setDocked = (id: string | null) => setSearch((current) => {
    const next = new URLSearchParams(current);
    if (id) next.set(SPLIT_PARAM, id);
    else next.delete(SPLIT_PARAM);
    return next;
  }, { replace: true });
  const panelShown = desk && inspector.open && !docked;

  // A coordinator's chat holds what its page did (ADR 0115): a desk's panel and a phone's Status tab.
  // A phone reads the asks for its Status tab's count; a desk's Overview reads them while it is on screen.
  const asks = useAsks(scope.coordinating && !desk ? [project] : undefined);
  const coordinatorId = thread?.id ?? "root";
  const waiting = scope.coordinating ? waitingAt(asks.list, project, coordinatorId).count : 0;
  const coordinatorSections = { project, thread, asks: desk ? undefined : asks, panes: data.agents, session: data.session, readOnly, onChanged: refresh };
  const canStart = !readOnly && startableRoles(project).includes("worker");
  const finished = scope.coordinating && desk ? finishedCount(project, thread?.title) : 0;

  const openCount = scope.threads.filter(isOpenThread).length;
  const prCount = prLists(scope.threads).open.length;
  const pr = sessionPr(data, paneId, thread);
  // Who this pane answers to, a step up the tree: its parent coordinator, else (as coordinatedThreads
  // reads a parent it cannot find) the project's.
  const live = (id?: string): id is string => id !== undefined && data.agents.some((pane) => pane.paneId === id);
  const up = (title: string, nodeId: string, paneId?: string) => ({ title, open: () => goUp(live(paneId) ? panePath(paneId, data.session) : nodePath(project.slug, nodeId, data.session)) });
  const parentNode = thread && project.threads.find((candidate) => candidate.id === thread.parentId);
  const parent = !thread ? undefined : parentNode ? up(parentNode.title, parentNode.id, parentNode.paneId) : up(project.name, "root", project.coordinator?.paneId);
  // What a thread's and a coordinator's Overview share.
  const overview = {
    thread, pane: data.agents.find((pane) => pane.paneId === paneId), panes: data.agents, paneId, session: data.session, pr, reading: inspector.reading, parent,
    onShowChanges: () => inspector.setTab("changes"),
    onOpenThread: (candidate: ProjectThreadView) => {
      if (!candidate.paneId) openNode(candidate.id);
      // A tap on a coordinator enters its chat (ADR 0115); a thread docks beside this one.
      else if (scope.coordinating && candidate.role !== "coordinator" && live(candidate.paneId)) setDocked(candidate.paneId);
      else openPane(candidate.paneId);
    },
  };
  const headerTrail = desk && !panelShown && !docked ? <InspectorToggle inspector={inspector} pr={pr} /> : undefined;

  const phoneTabs = !desk ? (
    <div className="project-segmented-band">
      <div role="tablist" aria-label="Project" className="project-segmented">
        {([["chat", "Chat", null], ["threads", "Threads", openCount], ["prs", "PRs", prCount], ...(scope.coordinating ? [["status", "Status", waiting]] as const : [])] as const).map(([key, label, count]) => (
          <button key={key} type="button" role="tab" aria-selected={view === key} onClick={() => setView(key)} className="project-segment">
            {label}{count !== null && count > 0 && <span className="project-segment-count" data-waiting={key === "status" ? "" : undefined}>{count}</span>}
          </button>
        ))}
      </div>
    </div>
  ) : undefined;

  const chipCoordinator = scope.coordinatorPane ? { paneId: scope.coordinatorPane, label: "coordinator" } : undefined;
  // A desk's panel lists the siblings (and their coordinator) already; chips take its place when it is put away.
  const chips = desk && !scope.coordinating && !panelShown && threadChipsShown(scope.siblings, chipCoordinator !== undefined) ? (
    <ThreadChips threads={scope.siblings} currentPaneId={paneId} onOpen={openPane} coordinator={chipCoordinator} />
  ) : undefined;

  // A coordinator's own Threads tab sits under its chat's title, which already names it; a paused project keeps its heading for the mark.
  const tasks = <ProjectTasks project={project} threads={scope.threads} coordinator={scope.coordinator} title={scope.panelTitle} subtitle={scope.subtitle} bare={scope.coordinating && project.status !== "paused"} panes={data.agents} session={data.session}
    currentPaneId={paneId} readOnly={readOnly} onOpenPane={openPane} onOpenNode={openNode} onChanged={refresh} />;
  const overlay = phoneTabs && view !== "chat" ? (
    <div className="flex min-h-0 flex-1 flex-col">{phoneTabs}<div className="project-overlay">
      {view === "threads" ? tasks
        : view === "status" && scope.coordinating ? <CoordinatorSections {...coordinatorSections} />
        : <PrList project={project} threads={scope.threads} session={data.session} readOnly={readOnly} onOpenPane={openPane} onOpenNode={openNode} onChanged={refresh} />}
    </div></div>
  ) : undefined;

  return (
    <div className="project-frame">
      {children({
        title: thread?.title ?? project.name,
        headerTrail,
        overlay,
        // Project chips or tabs replace the workspace tabs; on a desk the panel stands in for them.
        strip: phoneTabs ?? chips ?? (desk ? null : undefined),
        projectChips: { project, thread, threads: scope.threads, session: data.session, readOnly, onOpenPane: openPane, onOpenNode: openNode, onChanged: refresh },
        sessionPanel: desk && !docked ? { ...panelLink(inspector), report: inspector.setReading } : undefined,
      })}
      {docked && (
        <DockedThread thread={docked} project={project} siblings={coordinatedThreads(project, docked.parentId === "root" ? undefined : docked.parentId)} data={data}
          subtitle={[scope.panelTitle, docked.agent].filter(Boolean).join(" · ")} inspector={inspector}
          onSwitch={(id) => setDocked(id)}
          onExpand={() => navigate(panePath(docked.paneId, data.session))}
          onClose={() => setDocked(null)} />
      )}
      {panelShown && (
        <SessionInspector inspector={inspector} paneId={paneId} session={data.session} artifacts={data.agents.some((pane) => pane.paneId === paneId)} pr={pr}
          overview={<Suspense fallback={null}>{scope.coordinating
            ? <CoordinatorOverview key={paneId} {...overview} coordinator={coordinatorSections} threads={scope.threads}
              onNewThread={canStart ? () => openNewDialog({ kind: "thread", project: project.slug, role: "worker", parent: coordinatorId, onStarted: refresh }) : undefined}
              finished={{ count: finished, open: () => navigate(projectHistoryPath(project.slug, data.session, thread?.title)) }} />
            : <ThreadOverview key={paneId} {...overview} threads={scope.siblings} coordinating={false} />}</Suspense>} />
      )}
    </div>
  );
}
