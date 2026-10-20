import { useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ChatCircle, ChevronDown, Plus, Workflow } from "@/components/ui/icon";

import { CoordinatorWorkCard, DeskHead, DeskTabs, useDeskTab, useOpenNode, WaitingByCoordinator, type DeskTab } from "@/components/desk-pages";
import { RoutinesPanel } from "@/components/desk-routines";
import { openNewDialog } from "@/components/new-agent-sheet";
import { startableRoles } from "@/components/node-start";
import { prefetchContext, ProjectContext } from "@/components/project-context";
import { ProjectGlyph } from "@/components/project-glyph";
import { StartProjectCoordinator } from "@/components/project-coordinator";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { WorkbenchPopover } from "@/components/ui/workbench-popover";
import { useAsks } from "@/hooks/use-asks";
import { useRoutines } from "@/hooks/use-routines";
import { coordinatorState, STATE_LABEL, type OrgNode } from "@/lib/org-tree";
import { finishedCount, waitingGroups, workCards, type WorkFilter } from "@/lib/project-work";
import { nodePath, panePath, projectsPath } from "@/lib/nav";
import { runningCoordinator } from "@/lib/projects";
import { isReadOnly, type AgentView, type DeviceAuth, type NodeRole, type ProjectView } from "@/lib/types";

type Tab = "work" | "waiting" | "routines" | "context";

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
          ? <Button type="button" variant="outline" onClick={() => navigate(panePath(coordinator.paneId, session))}><ChatCircle aria-hidden className="size-4" />Project chat</Button>
          : !readOnly && <StartProjectCoordinator project={project} session={session} onStarted={onChanged} />}
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

/** Open or Finished, in the address (`?work=finished`), and the cards for it. */
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
  const filter: WorkFilter = params.get("work") === "finished" ? "finished" : "open";
  const setFilter = (next: WorkFilter) => setParams((current) => {
    const kept = new URLSearchParams(current);
    if (next === "open") kept.delete("work");
    else kept.set("work", next);
    return kept;
  }, { replace: true });
  // Open cards start open and finished ones closed; a fold the person changed lasts while the page does.
  const [folds, setFolds] = useState<Record<string, boolean>>({});
  const cards = workCards(project, filter);
  const rootState = coordinator && coordinatorState(coordinator.liveStatus);
  const newThread = (parent: string) => openNewDialog({ kind: "thread", project: project.slug, role: "worker", parent, onStarted: onChanged });

  return <>
    <Segmented label="Show" className="mb-4 w-64" value={filter} onChange={setFilter}
      options={[{ value: "open", label: "Open" }, { value: "finished", label: `Finished ${finishedCount(project)}` }]} />
    {cards.map((card) => {
      const id = card.coordinator?.thread.id ?? "root";
      const key = `${filter}:${id}`;
      const open = folds[key] ?? filter === "open";
      // Finished work is history: nothing starts from it, and the coordinator's own state belongs to Open.
      const finished = filter === "finished";
      const own = finished ? undefined : card.coordinator ? (card.coordinator.state === "working" ? "working" : undefined)
        : rootState ? STATE_LABEL[rootState].toLowerCase() : undefined;
      return <CoordinatorWorkCard key={key} card={card} waiting={finished ? 0 : waiting(id)} open={open} ownState={own}
        onToggle={() => setFolds((current) => ({ ...current, [key]: !open }))}
        onOpenNode={onOpenNode} onOpenCoordinator={() => onOpenCoordinator(id)}
        onNewThread={canStart && !finished ? () => newThread(id) : undefined} />;
    })}
    {filter === "finished" && cards.length === 0 && <p className="px-1 text-subhead text-muted-foreground">Nothing has finished yet.</p>}
  </>;
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
    <Button ref={trigger} type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Plus aria-hidden className="size-4" />New<ChevronDown aria-hidden className="size-3.5" />
    </Button>
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
