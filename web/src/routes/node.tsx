import { useState } from "react";
import { Link, useNavigate, useParams, useRevalidator, useRouteLoaderData } from "react-router";
import { ExternalLink, MessageSquare } from "lucide-react";

import { ColumnPage } from "@/components/column-page";
import { NodeDot } from "@/components/node-row";
import { CloseNodeDialog, OrgTreeList, TasksHeader, prSummary, threadAge, threadTree } from "@/components/project-tasks";
import { Button } from "@/components/ui/button";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { nodePath, panePath, projectPath } from "@/lib/nav";
import { STATE_LABEL, flatten, orgTree } from "@/lib/org-tree";
import { isReadOnly } from "@/lib/types";

// What a tap on a node with no live pane opens: the node itself, inside Nenu. A coordinator lists
// the work it runs the way every organization view does; a live node offers its chat, never a jump.
export function NodeRoute() {
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

  let body;
  if (!project || !node) {
    body = <p className="py-16 text-center text-sm text-muted-foreground">{project ? "This node is not in the project any more." : "Project not found in this Herdr session."}</p>;
  } else {
    const { thread, state } = node;
    const parent = project.threads.find((candidate) => candidate.id === thread.parentId);
    const live = thread.paneId !== undefined && data.agents.some((pane) => pane.paneId === thread.paneId);
    const coordinator = thread.role === "coordinator";
    const age = threadAge(thread, Date.now());
    body = <>
      <TasksHeader title={thread.title} paused={project.status === "paused"} subtitle={<>
        {coordinator ? "Coordinator" : "Thread"} under {parent
          ? <Link className="underline-offset-2 hover:underline" to={nodePath(project.slug, parent.id, data.session)}>{parent.title}</Link>
          : <Link className="underline-offset-2 hover:underline" to={projectPath(project.slug, data.session)}>{project.name}</Link>}
      </>} />
      <section aria-label="Node" className="mb-5 rounded-xl border border-border bg-card/40 px-3.5 py-3 text-sm">
        <p className="flex items-center gap-2"><NodeDot state={state} /><span className="font-medium">{STATE_LABEL[state]}</span>
          {age && <span className="text-muted-foreground">· {age}</span>}</p>
        {thread.note && <p className="mt-1.5 text-muted-foreground">{thread.note}</p>}
        {thread.pr && <p className="mt-1.5 flex items-center gap-1.5">{prSummary(thread.pr)}
          {thread.pr.url && <a className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" href={thread.pr.url} target="_blank" rel="noreferrer">
            <ExternalLink aria-hidden className="size-3.5" />GitHub</a>}</p>}
        {thread.branch && <p className="mt-1.5 truncate font-mono text-xs text-muted-foreground">{thread.branch}</p>}
        {(live || (state !== "resolved" && !readOnly)) && <div className="mt-3 flex flex-wrap gap-2">
          {live && <Button type="button" size="lg" onClick={() => navigate(panePath(thread.paneId!, data.session))}>
            <MessageSquare aria-hidden className="size-4" />Open chat</Button>}
          {state !== "resolved" && !readOnly && <Button type="button" size="lg" variant="ghost" onClick={() => setClosing(true)}>
            Close {coordinator ? "coordinator" : "thread"}</Button>}
        </div>}
      </section>
      {coordinator && <OrgTreeList project={project} threads={threadTree(project, thread.id)} panes={data.agents} session={data.session} readOnly={readOnly}
        onOpenPane={(id) => navigate(panePath(id, data.session))} onOpenNode={(id) => navigate(nodePath(project.slug, id, data.session))} onChanged={refresh} />}
      <CloseNodeDialog project={project} node={closing ? node : null} session={data.session} onCancel={() => setClosing(false)}
        onClosed={() => { setClosing(false); void refresh(); }} />
    </>;
  }

  return <ColumnPage data={data} title={project?.name ?? "Project"}>{body}</ColumnPage>;
}
