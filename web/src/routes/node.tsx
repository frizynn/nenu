import { useState } from "react";
import { Link, Navigate, useNavigate, useParams, useRevalidator, useRouteLoaderData } from "react-router";
import { ExternalLink, ChatCircle, ChatCircleSlash } from "@/components/ui/icon";

import type { HeaderBack } from "@/components/app-header";
import { ColumnPage } from "@/components/column-page";
import { CoordinatorHead } from "@/components/coordinator-card";
import { CoordinatorStatus } from "@/components/coordinator-status";
import { OwnReport } from "@/components/coordinator-summary";
import { DeskCoordinator } from "@/components/desk-coordinator";
import { NodeDot } from "@/components/node-row";
import { NewNodeActions } from "@/components/node-start";
import { ProjectMissing } from "@/components/project-missing";
import { CloseNodeDialog, OrgTreeList, TasksHeader, prSummary, threadAge, threadTree } from "@/components/project-tasks";
import { Button, buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useAsks } from "@/hooks/use-asks";
import { useDesk } from "@/hooks/use-desk";
import { useThreadSummaries } from "@/hooks/use-thread-summaries";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { homePath, nodePath, panePath, projectPath } from "@/lib/nav";
import { ASK, STATE_LABEL, awaits, coordinatorState, flatten, orgTree, type OrgNode } from "@/lib/org-tree";
import { coordinatorPane } from "@/lib/projects";
import { isReadOnly, type ProjectThreadView, type ProjectView } from "@/lib/types";
import { cn } from "@/lib/utils";

/** The node id Organizations gives the project's own coordinator; its page is its card. */
const ROOT = "root";

// A coordinator that runs is entered at its chat, which holds what its page did (ADR 0115): its node
// address, an old link or a status line's, lands there. One that does not run keeps its page: on a
// desk with tabs (ADR 0102); a thread's page, and a phone's, are as before.
export function NodeRoute() {
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  const { projectSlug = "", nodeId = "" } = useParams();
  const revalidator = useRevalidator();
  const desk = useDesk();
  const project = data.projects?.find((candidate) => candidate.slug === projectSlug);
  const thread = project?.threads.find((candidate) => candidate.id === nodeId);
  const chat = project && coordinatorPane(project, nodeId, data.agents);
  if (chat) return <Navigate to={panePath(chat, data.session)} replace />;
  if (!desk || !project || (nodeId !== ROOT && thread?.role !== "coordinator")) return <NodePage />;
  const back = upTo(project, thread, data.session);
  return <ColumnPage data={data} title={thread?.title ?? "Project coordinator"} back={back}>
    <DeskCoordinator key={nodeId} project={project} thread={thread} panes={data.agents} device={data.device} session={data.session} onChanged={() => void revalidator.revalidate()} />
  </ColumnPage>;
}

/** One level up from a node, as its chat's back goes: its coordinator, else its project. */
function upTo(project: ProjectView, thread: ProjectThreadView | undefined, session?: string): HeaderBack {
  const parent = thread && project.threads.find((candidate) => candidate.id === thread.parentId);
  return parent ? { to: nodePath(project.slug, parent.id, session), label: parent.title, desk: true } : { to: projectPath(project.slug, session), label: project.name, desk: true };
}

// What a tap on a node with no live pane opens: the node itself, inside Nenu. A coordinator lists
// the work it runs the way every organization view does, under its card (ADR 0091); a live node
// offers its chat, never a jump. `root` is the project's own coordinator: its card and its chat.
function NodePage() {
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  const { projectSlug = "", nodeId = "" } = useParams();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [closing, setClosing] = useState(false);
  const project = data.projects?.find((candidate) => candidate.slug === projectSlug);
  const tree = project ? orgTree(project.threads) : undefined;
  const node = tree && flatten([...tree.open, ...tree.history]).find((candidate) => candidate.thread.id === nodeId);
  const readOnly = isReadOnly(data.device);
  const refresh = () => revalidator.revalidate();
  const isRoot = nodeId === ROOT;
  const coordinating = isRoot || node?.thread.role === "coordinator";
  const subtree = project && coordinating ? threadTree(project, isRoot ? undefined : node?.thread.id) : [];
  const read = useThreadSummaries(project, node ? [node.thread, ...subtree] : subtree);
  const { summaries, failed } = read;
  // Only a coordinator has a card to fill.
  const asks = useAsks(coordinating ? data.projects : undefined);
  const live = (paneId: string | undefined) => paneId !== undefined && data.agents.some((pane) => pane.paneId === paneId);
  const openNode = (slug: string) => ({ thread }: OrgNode) =>
    navigate(thread.paneId && live(thread.paneId) ? panePath(thread.paneId, data.session) : nodePath(slug, thread.id, data.session));
  const openStatusNode = (slug: string) => (id: string) => navigate(nodePath(slug, id, data.session));

  let body;
  // Back climbs one level: to the node's parent, else to its project, else Home.
  let back: HeaderBack | undefined = project && upTo(project, undefined, data.session);
  if (!project) {
    body = <ProjectMissing session={data.session} />;
  } else if (isRoot) {
    const pane = project.coordinator && live(project.coordinator.paneId) ? project.coordinator : undefined;
    // The live pane says what the agent does now; else what the ticker saw when it last looked.
    const status = pane?.liveStatus ?? (read.coordinator?.state || undefined);
    const state = status && coordinatorState(status);
    const agent = [pane?.agent ?? read.coordinator?.agent, read.coordinator?.model].filter(Boolean).join(" · ");
    body = <>
      <TasksHeader title="Coordinator" paused={project.status === "paused"} subtitle={<>
        Project coordinator of <Link className="hit-area font-medium text-primary underline-offset-2 hover:underline" to={projectPath(project.slug, data.session)}>{project.name}</Link>
      </>} />
      {(state || agent) && <p className="-mt-2 mb-4 flex items-center gap-2 text-subhead text-muted-foreground">
        {state && <><NodeDot state={state} /><span className="font-medium text-foreground">{STATE_LABEL[state]}</span></>}
        {state && agent && <span aria-hidden>·</span>}
        {agent && <span>{agent}</span>}
      </p>}
      <CoordinatorHead project={project} coordinatorId={ROOT} status={read.status ?? undefined} usage={read.usage ?? undefined}
        asks={asks} summaries={summaries} session={data.session} readOnly={readOnly} onOpenNode={openNode(project.slug)} onOpenStatusNode={openStatusNode(project.slug)} />
      {pane && <Button type="button" size="lg" onClick={() => navigate(panePath(pane.paneId, data.session))}>
        <ChatCircle aria-hidden className="size-4" />Open chat</Button>}
    </>;
  } else if (!node) {
    body = <EmptyState icon={ChatCircleSlash} title="Thread not found" action={<div className="flex flex-wrap justify-center gap-3">
      <Link to={projectPath(project.slug, data.session)} className={cn(buttonVariants({ size: "lg" }))}>Open project</Link>
      <Link to={homePath(data.session)} className={cn(buttonVariants({ variant: "outline", size: "lg" }))}>Go to Home</Link>
    </div>}>{project.name} no longer lists it.</EmptyState>;
  } else {
    const { thread, state } = node;
    const parent = project.threads.find((candidate) => candidate.id === thread.parentId);
    back = upTo(project, thread, data.session);
    const running = live(thread.paneId);
    const coordinator = thread.role === "coordinator";
    const age = threadAge(thread, Date.now());
    const ask = awaits(thread);
    const note = ask ? ASK[ask].label : thread.note;
    const status = summaries.get(thread.id)?.status;
    // A coordinator's page leads with its work: closing it is a quiet action at the end.
    const closable = state !== "resolved" && !readOnly;
    body = <>
      <TasksHeader title={thread.title} paused={project.status === "paused"} subtitle={<>
        {coordinator ? "Coordinator" : "Thread"} under <Link className="hit-area font-medium text-primary underline-offset-2 hover:underline"
          to={parent ? nodePath(project.slug, parent.id, data.session) : projectPath(project.slug, data.session)}>{parent ? parent.title : project.name}</Link>
      </>} />
      {coordinator
        ? <CoordinatorHead project={project} coordinatorId={thread.id} status={status} usage={summaries.get(thread.id)?.usage}
          asks={asks} summaries={summaries} session={data.session} readOnly={readOnly} onOpenNode={openNode(project.slug)} onOpenStatusNode={openStatusNode(project.slug)} />
        : status && <CoordinatorStatus status={status} project={project} onOpenNode={openStatusNode(project.slug)} />}
      <section aria-label="Node" className="mb-5 rounded-xl border border-border bg-card/40 px-3.5 py-3 text-subhead">
        <p className="flex items-center gap-2 text-body"><NodeDot state={state} /><span className="font-medium">{STATE_LABEL[state]}</span>
          {age && <span className="text-muted-foreground">· {age}</span>}</p>
        {note && <p className="mt-1.5 text-muted-foreground">{note}</p>}
        {thread.pr && <p className="mt-1.5 flex items-center gap-1.5">{prSummary(thread.pr)}
          {thread.pr.url && <a className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" href={thread.pr.url} target="_blank" rel="noreferrer">
            <ExternalLink aria-hidden className="size-3.5" />GitHub</a>}</p>}
        {thread.branch && <p className="mt-1.5 truncate font-mono text-code text-muted-foreground">{thread.branch}</p>}
        <OwnReport project={project} thread={thread} summary={summaries.get(thread.id)} />
        {failed && <p role="alert" className="mt-2 text-footnote text-muted-foreground">Could not read the reports: {failed}</p>}
        {(running || (closable && !coordinator)) && <div className="mt-3 flex flex-wrap gap-2">
          {running && <Button type="button" size="lg" onClick={() => navigate(panePath(thread.paneId!, data.session))}>
            <ChatCircle aria-hidden className="size-4" />Open chat</Button>}
          {closable && !coordinator && <Button type="button" size="lg" variant="outline" onClick={() => setClosing(true)}
            className="border-destructive/40 bg-transparent text-destructive hover:bg-destructive/10 hover:text-destructive">
            Close thread</Button>}
        </div>}
      </section>
      {/* Its live work; what finished is the tree's one folded History line (ADR 0109). */}
      {coordinator && <OrgTreeList key={thread.id}
        project={project} threads={subtree} panes={data.agents} session={data.session} readOnly={readOnly}
        onOpenPane={(id) => navigate(panePath(id, data.session))} onOpenNode={(id) => navigate(nodePath(project.slug, id, data.session))} onChanged={refresh} />}
      {coordinator && !readOnly && state !== "resolved" && <div className="mt-3">
        <NewNodeActions project={project} under={{ id: thread.id, title: thread.title }} session={data.session} onStarted={() => void refresh()} />
      </div>}
      {coordinator && closable && <button type="button" className="task-history-toggle text-destructive" onClick={() => setClosing(true)}>Close coordinator…</button>}
      <CloseNodeDialog project={project} node={closing ? node : null} session={data.session} onCancel={() => setClosing(false)}
        onClosed={() => { setClosing(false); void refresh(); }} />
    </>;
  }

  return <ColumnPage data={data} title={isRoot && project ? "Coordinator" : node?.thread.title ?? project?.name ?? "Project"} back={back}>{body}</ColumnPage>;
}
