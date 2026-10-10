import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useRevalidator, useSearchParams } from "react-router";
import { ListChecks, MessageSquare, PanelRightClose } from "lucide-react";

import { PrBar } from "@/components/pr-bar";
import { ProjectTasks, coordinatedThreads, threadTree } from "@/components/project-tasks";
import { DockedThread, ThreadChips, threadChipsShown } from "@/components/split-view";
import { ThreadCards } from "@/components/thread-cards";
import { PrList, ThreadsPanel, prThreads } from "@/components/threads-panel";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { HomeData } from "@/lib/loaders";
import { panePath } from "@/lib/nav";
import { isOpenThread, type PaneProject } from "@/lib/projects";
import { isReadOnly, type ProjectThreadView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { WorkbenchNavigationContext } from "@/lib/workbench-navigation";

/** What a project gives the chat it wraps. */
export interface ProjectChatSlots {
  title: string;
  headerAction?: ReactNode;
  overlay?: ReactNode;
  conversationFooter?: ReactNode;
  strip?: ReactNode;
  composerTop?: ReactNode;
}

const PANEL_KEY = "nenu:project-panel:v1";
/** The search param naming the thread docked beside its coordinator on a wide screen. */
export const SPLIT_PARAM = "thread";

function readPanelPref(): boolean {
  try {
    return localStorage.getItem(PANEL_KEY) !== "closed";
  } catch {
    return true;
  }
}

type PhoneView = "chat" | "threads" | "prs";

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
  return { coordinating, threads, siblings, coordinatorPane: live ? coordinatorPane : undefined, panelTitle, subtitle };
}

/**
 * A pane that belongs to a project renders inside this frame. A coordinator's chat carries its
 * threads as cards; a wide screen keeps the project panel beside it, or docks a thread there
 * (`?thread=`). A phone switches the coordinator between Chat, Threads and PRs in place, keeping
 * the chat mounted so its draft and scroll survive; a thread shows its siblings as chips, a header
 * button to the project's threads, and its pull request above the composer.
 */
export function ProjectFrame({ owner, paneId, data, children }: {
  owner: PaneProject;
  paneId: string;
  data: HomeData;
  children: (slots: ProjectChatSlots) => ReactNode;
}) {
  const { project, thread } = owner;
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [search, setSearch] = useSearchParams();
  const wide = useMediaQuery("(min-width: 1280px)");
  const [panelOpen, setPanelOpenState] = useState(readPanelPref);
  const [view, setView] = useState<PhoneView>("chat");
  const scope = projectScope(owner, data);
  const readOnly = isReadOnly(data.device);
  const refresh = () => revalidator.revalidate();
  const openPane = (id: string) => { setView("chat"); if (id !== paneId) navigate(panePath(id, data.session)); };

  // A docked thread is only meaningful beside its own coordinator on a wide screen.
  const splitPane = search.get(SPLIT_PARAM);
  const docked = wide && scope.coordinating && splitPane
    ? scope.threads.find((candidate): candidate is ProjectThreadView & { paneId: string } => candidate.paneId === splitPane && data.agents.some((pane) => pane.paneId === splitPane))
    : undefined;
  const setDocked = (id: string | null) => setSearch((current) => {
    const next = new URLSearchParams(current);
    if (id) next.set(SPLIT_PARAM, id);
    else next.delete(SPLIT_PARAM);
    return next;
  }, { replace: true });
  const panelShown = wide && panelOpen && !docked;
  const onDock = useContext(WorkbenchNavigationContext)?.onDock;
  const isDocked = docked !== undefined;
  useEffect(() => {
    if (!onDock || !isDocked) return;
    onDock(true);
    return () => onDock(false);
  }, [onDock, isDocked]);

  // Toggling unmounts the button that was pressed; hand focus to its counterpart.
  const toggleFocus = useRef<HTMLButtonElement>(null);
  const toggled = useRef(false);
  useEffect(() => {
    if (toggled.current) toggleFocus.current?.focus({ preventScroll: true });
    toggled.current = false;
  }, [panelOpen]);
  function setPanelOpen(next: boolean) {
    toggled.current = true;
    setPanelOpenState(next);
    try {
      localStorage.setItem(PANEL_KEY, next ? "open" : "closed");
    } catch {
      // A blocked store only forgets the choice.
    }
  }

  const openCount = scope.threads.filter(isOpenThread).length;
  const prCount = prThreads(scope.threads).filter((candidate) => candidate.pr!.state === "open" || candidate.pr!.state === "draft").length;
  // The project coordinator's row is the way back up from a thread or a nested coordinator.
  const showCoordinator = project.coordinator !== undefined && project.coordinator.paneId !== paneId;
  // A phone thread switches between its chat and the project's threads with one header button.
  const phoneWorker = !wide && !scope.coordinating;
  const tasksShown = phoneWorker && view === "threads";
  const headerAction = wide && !panelShown && !docked ? (
    <button ref={toggleFocus} type="button" className="project-toggle" aria-label={`Threads, ${openCount} open`} onClick={() => setPanelOpen(true)}>
      <MessageSquare aria-hidden className="size-3.5" />Threads
      {openCount > 0 && <span className="tabular-nums text-muted-foreground">{openCount}</span>}
    </button>
  ) : phoneWorker ? (
    <button type="button" className="project-toggle" aria-label={tasksShown ? "Back to chat" : `Threads, ${openCount} open`}
      onClick={() => setView(tasksShown ? "chat" : "threads")}>
      {tasksShown ? <><MessageSquare aria-hidden className="size-3.5" />Chat</> : <>
        <ListChecks aria-hidden className="size-3.5" />Threads
        {openCount > 0 && <span className="tabular-nums text-muted-foreground">{openCount}</span>}
      </>}
    </button>
  ) : undefined;

  const phoneTabs = !wide && scope.coordinating ? (
    <div role="tablist" aria-label="Project" className="mx-3 my-2 grid shrink-0 grid-cols-3 rounded-xl bg-muted/50 p-1">
      {([["chat", "Chat", null], ["threads", "Threads", openCount], ["prs", "PRs", prCount]] as const).map(([key, label, count]) => (
        <button key={key} type="button" role="tab" aria-selected={view === key} onClick={() => setView(key)}
          className={cn("flex min-h-10 items-center justify-center gap-1.5 rounded-lg text-[13px]", view === key ? "bg-background font-medium text-foreground ring-1 ring-border" : "text-muted-foreground")}>
          {label}{count !== null && count > 0 && <span className="tabular-nums text-muted-foreground">{count}</span>}
        </button>
      ))}
    </div>
  ) : undefined;

  const chipCoordinator = scope.coordinatorPane ? { paneId: scope.coordinatorPane, label: "coordinator" } : undefined;
  const chips = !scope.coordinating && threadChipsShown(scope.siblings, chipCoordinator !== undefined) ? (
    <ThreadChips threads={scope.siblings} currentPaneId={paneId} onOpen={openPane} coordinator={chipCoordinator} />
  ) : undefined;

  const tasks = <ProjectTasks project={project} threads={scope.threads} title={scope.panelTitle} subtitle={scope.subtitle} panes={data.agents} session={data.session}
    currentPaneId={paneId} readOnly={readOnly} showCoordinator={showCoordinator} onOpenPane={openPane} onChanged={refresh} />;
  const overlay = phoneTabs && view !== "chat" ? (
    <div className="flex min-h-0 flex-1 flex-col">{phoneTabs}<div className="project-overlay">
      {view === "threads" ? tasks : <PrList threads={scope.threads} onOpenPane={openPane} />}
    </div></div>
  ) : tasksShown ? <div className="project-overlay">{tasks}</div> : undefined;

  const cards = scope.coordinating ? (
    <ThreadCards project={project} coordinatorId={thread?.id} panes={data.agents} session={data.session} readOnly={readOnly} onChanged={refresh}
      onOpen={(target) => { if (wide && target.paneId) setDocked(target.paneId); else if (target.paneId) openPane(target.paneId); }} />
  ) : undefined;

  return (
    <div className="project-frame">
      {children({
        title: thread?.title ?? project.name,
        headerAction,
        overlay,
        conversationFooter: cards,
        // Project chips or tabs replace the workspace tabs; on a wide coordinator the panel stands in for them.
        strip: phoneTabs ?? chips ?? (wide ? null : undefined),
        composerTop: thread?.pr && !scope.coordinating
          ? <PrBar project={project} thread={thread} session={data.session} readOnly={readOnly} onChanged={refresh} />
          : undefined,
      })}
      {docked && (
        <DockedThread thread={docked} project={project} siblings={coordinatedThreads(project, docked.parentId === "root" ? undefined : docked.parentId)} data={data}
          subtitle={[scope.panelTitle, docked.agent].filter(Boolean).join(" · ")}
          onSwitch={(id) => setDocked(id)}
          onExpand={() => navigate(panePath(docked.paneId, data.session))}
          onClose={() => setDocked(null)} />
      )}
      {panelShown && (
        <aside className="flex min-h-0 w-[400px] shrink-0 flex-col border-l border-border" aria-label="Project">
          <ThreadsPanel project={project} threads={scope.threads} title={scope.panelTitle} subtitle={scope.subtitle}
            activityPaneId={scope.coordinatorPane} panes={data.agents} session={data.session} currentPaneId={paneId} readOnly={readOnly} showCoordinator={showCoordinator}
            onOpenPane={(id) => { if (scope.coordinating && scope.threads.some((candidate) => candidate.paneId === id)) setDocked(id); else openPane(id); }} onChanged={refresh}
            action={<button ref={toggleFocus} type="button" className="workbench-icon-button" aria-label="Hide project panel" onClick={() => setPanelOpen(false)}>
              <PanelRightClose aria-hidden className="size-4" />
            </button>} />
        </aside>
      )}
    </div>
  );
}
