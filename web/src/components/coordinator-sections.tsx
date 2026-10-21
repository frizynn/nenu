import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { ArrowRight } from "@/components/ui/icon";

import { AskSections } from "@/components/ask-list";
import { CoordinatorHead } from "@/components/coordinator-card";
import { OwnReport } from "@/components/coordinator-summary";
import { useOpenNode } from "@/components/desk-pages";
import { RoutinesPanel } from "@/components/desk-routines";
import { canMove, CloseNodeDialog, MoveNodeDialog } from "@/components/project-tasks";
import type { AsksRead } from "@/hooks/use-asks";
import { useRoutines } from "@/hooks/use-routines";
import { useThreadSummaries } from "@/hooks/use-thread-summaries";
import { askSections } from "@/lib/asks";
import { nodePath } from "@/lib/nav";
import { flatten, orgTree } from "@/lib/org-tree";
import { routinesFor } from "@/lib/project-work";
import type { AgentView, AsksList, ProjectThreadView, ProjectView, RoutineView } from "@/lib/types";

/** A card of a chat's panel or tab: its head, which may be a control, over what it says. */
export function OverviewCard({ label, head, children }: { label: string; head?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={label} className="overview-card">
      <header className="overview-card-head">{head ?? label}</header>
      {children}
    </section>
  );
}

/**
 * What a coordinator's page held, inside its chat (ADR 0113): what waits on you there, answered in
 * place; then `children` (a desk's panel puts its threads and changes here); the routines that reach
 * it; its Status (its card, what was asked of it, STATUS.md, its own report); and Move and Close. A
 * desk draws it in the chat's panel, under This coordinator; a phone in the chat's Status tab.
 */
export function CoordinatorSections({ project, thread, asks, panes, session, readOnly, onChanged, children }: {
  project: ProjectView;
  /** Every coordinator's asks, read once by the chat for this and its tab's count. */
  asks: AsksRead;
  /** The coordinator's node; absent for the project's own. */
  thread?: ProjectThreadView;
  panes: readonly AgentView[];
  session?: string;
  readOnly: boolean;
  onChanged: () => void;
  children?: ReactNode;
}) {
  const navigate = useNavigate();
  const [closing, setClosing] = useState(false);
  const [moving, setMoving] = useState(false);
  const id = thread?.id ?? "root";
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

  return <>
    {count > 0 && <OverviewCard label="Waiting on you" head={<>Waiting on you<span className="desk-tab-count" data-waiting="">{count}</span></>}>
      <div className="px-3.5 pb-1">
        <AskSections sections={waiting} headings={false} session={session} whose={false} answers={asks.list?.answers === true} readOnly={readOnly} />
      </div>
    </OverviewCard>}
    {children}
    {reached > 0 && <OverviewCard label="Routines">
      <div className="px-3 pb-3">
        <RoutinesPanel routines={routines} shown={reaching} threads={project.threads} readOnly={readOnly} empty="No routine reaches this coordinator." narrow />
      </div>
    </OverviewCard>}
    {/* Its card and STATUS.md are cards of their own: no frame around them. Named apart from the
        STATUS.md region inside. */}
    <section aria-label="Coordinator status">
      <CoordinatorHead project={project} coordinatorId={id} status={status} usage={usage} listsAgents={false} waitingApart
        asks={asks} summaries={read.summaries} session={session} readOnly={readOnly} onOpenNode={openNode}
        onOpenStatusNode={(node) => navigate(nodePath(project.slug, node, session))} />
      {thread && <OwnReport project={project} thread={thread} summary={read.summaries.get(thread.id)} />}
      {!status && !thread?.verdict && <p className="px-1 text-footnote text-muted-foreground">This coordinator has no STATUS.md yet.</p>}
    </section>
    {node && !readOnly && <div className="flex flex-wrap gap-1 px-1">
      {movable && <button type="button" className="quiet-action" aria-haspopup="dialog" onClick={() => setMoving(true)}><ArrowRight aria-hidden className="size-4" />Move…</button>}
      <button type="button" className="quiet-action text-destructive" aria-haspopup="dialog" onClick={() => setClosing(true)}>Close coordinator…</button>
    </div>}
    {node && <CloseNodeDialog project={project} node={closing ? node : null} session={session}
      onCancel={() => setClosing(false)} onClosed={() => { setClosing(false); onChanged(); }} />}
    {node && moving && <MoveNodeDialog project={project} tree={whole} node={node} session={session}
      onCancel={() => setMoving(false)} onMoved={() => { setMoving(false); onChanged(); }} />}
  </>;
}

/**
 * What waits on you at one coordinator, and how many questions that is with their parts: only what
 * waits on you, since what it is doing and what it did are its Status (ADR 0109).
 */
export function waitingAt(list: AsksList | null, project: ProjectView, coordinatorId: string): { sections: ReturnType<typeof askSections>; count: number } {
  const sections = list ? askSections(list, [project], { project: project.slug, coordinator: coordinatorId }).filter((section) => section.group === "waiting") : [];
  return { sections, count: sections.reduce((sum, section) => sum + section.entries.reduce((n, entry) => n + 1 + entry.parts.length, 0), 0) };
}
