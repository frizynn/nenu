import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { ArrowRight } from "@/components/ui/icon";

import { AskSections } from "@/components/ask-list";
import { CoordinatorHead } from "@/components/coordinator-card";
import { OwnReport } from "@/components/coordinator-summary";
import { useOpenNode } from "@/components/desk-pages";
import { RoutinesPanel } from "@/components/desk-routines";
import { PanelSections, type PanelSection } from "@/components/panel-sections";
import { canMove, CloseNodeDialog, MoveNodeDialog } from "@/components/project-tasks";
import { useAsks, type AsksRead } from "@/hooks/use-asks";
import { useRoutines } from "@/hooks/use-routines";
import { useThreadSummaries } from "@/hooks/use-thread-summaries";
import { askSections } from "@/lib/asks";
import { nodePath } from "@/lib/nav";
import { flatten, orgTree } from "@/lib/org-tree";
import { routinesFor } from "@/lib/project-work";
import type { AgentView, AsksList, ProjectThreadView, ProjectView, RoutineView } from "@/lib/types";

export interface CoordinatorSectionsProps {
  project: ProjectView;
  /** Every coordinator's asks, where the chat already reads them for its tab's count; else read here, while this is on screen. */
  asks?: AsksRead;
  /** The coordinator's node; absent for the project's own. */
  thread?: ProjectThreadView;
  panes: readonly AgentView[];
  session?: string;
  readOnly: boolean;
  onChanged: () => void;
}

/**
 * What a coordinator's page held, inside its chat (ADR 0115), as sections of its panel: what waits on
 * you there, answered in place; the routines that reach it; its Status (its card, what was asked of it,
 * STATUS.md, its own report). Move and Close go under them all. A desk draws them in the chat's panel
 * beside its threads and changes; a phone in the chat's Status view.
 */
export function useCoordinatorSections({ project, thread, asks: given, panes, session, readOnly, onChanged }: CoordinatorSectionsProps): { sections: PanelSection[]; footer: ReactNode } {
  const navigate = useNavigate();
  const [closing, setClosing] = useState(false);
  const [moving, setMoving] = useState(false);
  const id = thread?.id ?? "root";
  const own = useAsks(given ? undefined : [project]);
  const asks = given ?? own;
  const routines = useRoutines(project.slug, session);
  const read = useThreadSummaries(project, thread ? [thread] : []);
  const openNode = useOpenNode(project, panes, session);
  const { sections: waiting, count } = waitingAt(asks.list, project, id);
  const reaching = (list: readonly RoutineView[]) => routinesFor(list, id, project.threads);
  const reached = routines.list ? reaching(routines.list.routines).length : 0;
  const status = thread ? read.summaries.get(thread.id)?.status : read.status ?? undefined;
  const usage = thread ? read.summaries.get(thread.id)?.usage : read.usage ?? undefined;
  // Close refuses a coordinator with open work under it, which the open tree holds.
  const whole = orgTree(project.threads);
  const node = thread && flatten(whole.open).find((candidate) => candidate.thread.id === thread.id);
  const movable = node !== undefined && !readOnly && canMove(project, whole, node);

  const sections: PanelSection[] = [
    ...(count > 0 ? [{
      id: "waiting", label: "Waiting on you", urgent: true,
      badge: <span className="desk-tab-count" data-waiting="">{count}</span>,
      // Each question keeps its own 10 px inset: with this one, its words start where the head's label does.
      body: <div className="px-1 pb-1">
        <AskSections sections={waiting} headings={false} session={session} whose={false} answers={asks.list?.answers === true} readOnly={readOnly} />
      </div>,
    }] : []),
    ...(reached > 0 ? [{
      id: "routines", label: "Routines",
      badge: <span className="panel-section-meta">{reached}</span>,
      body: <div className="px-3 pb-3">
        <RoutinesPanel routines={routines} shown={reaching} threads={project.threads} readOnly={readOnly} empty="No routine reaches this coordinator." narrow />
      </div>,
    }] : []),
    {
      // Named apart from the STATUS.md region inside.
      id: "status", label: "Coordinator status",
      body: <div className="overview-status">
        <CoordinatorHead project={project} coordinatorId={id} status={status} usage={usage} listsAgents={false} waitingApart
          asks={asks} summaries={read.summaries} session={session} readOnly={readOnly} onOpenNode={openNode}
          onOpenStatusNode={(node) => navigate(nodePath(project.slug, node, session))} />
        {thread && <OwnReport project={project} thread={thread} summary={read.summaries.get(thread.id)} />}
        {!status && !thread?.verdict && <p className="overview-note">This coordinator has no STATUS.md yet.</p>}
      </div>,
    },
  ];
  const footer = <>
    {node && !readOnly && <>
      {movable && <button type="button" className="quiet-action" aria-haspopup="dialog" onClick={() => setMoving(true)}><ArrowRight aria-hidden className="size-4" />Move…</button>}
      <button type="button" className="quiet-action text-destructive" aria-haspopup="dialog" onClick={() => setClosing(true)}>Close coordinator…</button>
    </>}
    {node && <CloseNodeDialog project={project} node={closing ? node : null} session={session}
      onCancel={() => setClosing(false)} onClosed={() => { setClosing(false); onChanged(); }} />}
    {node && moving && <MoveNodeDialog project={project} tree={whole} node={node} session={session}
      onCancel={() => setMoving(false)} onMoved={() => { setMoving(false); onChanged(); }} />}
  </>;
  return { sections, footer };
}

/** A phone's Status view: the coordinator's sections, arranged apart from a desk's panel, which holds more. */
export function CoordinatorSections(props: CoordinatorSectionsProps) {
  const { sections, footer } = useCoordinatorSections(props);
  return <PanelSections kind="coordinator-status" sections={sections} footer={footer} />;
}

/**
 * What waits on you at one coordinator, and how many questions that is with their parts: only what
 * waits on you, since what it is doing and what it did are its Status (ADR 0109).
 */
export function waitingAt(list: AsksList | null, project: ProjectView, coordinatorId: string): { sections: ReturnType<typeof askSections>; count: number } {
  const sections = list ? askSections(list, [project], { project: project.slug, coordinator: coordinatorId }).filter((section) => section.group === "waiting") : [];
  return { sections, count: sections.reduce((sum, section) => sum + section.entries.reduce((n, entry) => n + 1 + entry.parts.length, 0), 0) };
}
