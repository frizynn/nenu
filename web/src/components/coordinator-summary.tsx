import { lazy, Suspense, useState, type ComponentProps } from "react";
import { ChevronRight, ExternalLink, FileText, GitPullRequest, Globe, ImageIcon } from "@/components/ui/icon";

import { IMAGE_EDGE } from "@/components/message-images";
import { NodeDot } from "@/components/node-row";
import { OrgTreeList, prSummary, threadAge, threadDetail } from "@/components/project-tasks";
import { orgLibraryUrl } from "@/lib/api";
import { summarySections, VERDICT_LABEL } from "@/lib/coordinator-summary";
import { nodeState, STATE_LABEL } from "@/lib/org-tree";
import { isOpenThread } from "@/lib/projects";
import type { AgentView, ProjectThreadView, ProjectView, ThreadCapture, ThreadDeliverable, ThreadPullRequest, ThreadSummary, ThreadVerdict } from "@/lib/types";
import { cn } from "@/lib/utils";

const CaptureViewer = lazy(() => import("./capture-viewer"));

// A coordinator's Summary (ADR 0089): the work under it by outcome, each card with what its agent's
// last report says in plain words, its PR, the pictures it took and the documents it left. Every
// report field may be missing (an Organizations without them, a thread that has not reported), and
// a card then shows only what Organizations knows. The summary is the agent's text, drawn as text.

/** Done cards drawn at a time: a long-running coordinator resolves dozens. */
const DONE_PAGE = 10;
const VERDICT_TONE: Record<ThreadVerdict, string> = { done: "text-status-done", "needs-decision": "text-status-blocked", blocked: "text-status-blocked", failed: "text-status-blocked" };
const CHIP = "inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-md bg-muted px-2 text-caption font-medium text-foreground";

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

type TreeProps = ComponentProps<typeof OrgTreeList>;

interface WorkProps extends TreeProps {
  coordinator: ProjectThreadView;
  summaries: ReadonlyMap<string, ThreadSummary>;
  /** Why the reports could not be read; what was read before stays. */
  failed: string | null;
}

/**
 * The work under a coordinator, two ways: its Summary, and the tree every organization view draws.
 * It opens on the Summary once a thread has reported; before that, on the tree, as it always did.
 */
export function CoordinatorWork({ coordinator, summaries, failed, ...tree }: WorkProps) {
  const [view, setView] = useState<"summary" | "threads">(() => [coordinator, ...tree.threads].some((thread) => thread.verdict) ? "summary" : "threads");
  const open = tree.threads.filter(isOpenThread).length;
  return <>
    <div role="tablist" aria-label="Work under this coordinator" className="mb-3 flex items-center gap-0.5">
      <button type="button" role="tab" aria-selected={view === "summary"} className="panel-tab" onClick={() => setView("summary")}>Summary</button>
      <button type="button" role="tab" aria-selected={view === "threads"} className="panel-tab" onClick={() => setView("threads")}>
        Threads{open > 0 && <span className="tabular-nums text-muted-foreground">{open}</span>}
      </button>
    </div>
    <div role="tabpanel" aria-label={view === "summary" ? "Summary" : "Threads"}>
      {view === "summary"
        ? <CoordinatorSummary {...tree} coordinatorId={coordinator.id} summaries={summaries} failed={failed} />
        : <OrgTreeList {...tree} />}
    </div>
  </>;
}

function CoordinatorSummary({ project, threads, panes, coordinatorId, summaries, failed, onOpenPane, onOpenNode, now = Date.now() }: TreeProps & {
  coordinatorId: string;
  summaries: ReadonlyMap<string, ThreadSummary>;
  failed: string | null;
}) {
  const [doneShown, setDoneShown] = useState(DONE_PAGE);
  const sections = summarySections(threads);
  const parentOf = (thread: ProjectThreadView) => thread.parentId === coordinatorId ? undefined : threads.find((candidate) => candidate.id === thread.parentId);
  return <div className="flex flex-col gap-6">
    {failed && <p role="alert" className="px-1 text-footnote text-muted-foreground">Could not read the reports: {failed}</p>}
    {sections.map(({ outcome, label, threads: list }) => {
      const shown = outcome === "done" ? list.slice(0, doneShown) : list;
      const hidden = list.length - shown.length;
      return <section key={outcome} aria-label={label}>
        <h3 className="mb-2 flex items-baseline gap-2 px-1 text-subhead font-semibold">
          {label}<span className="text-footnote font-normal tabular-nums text-muted-foreground">{list.length}</span>
        </h3>
        <ul className="flex flex-col gap-2.5">
          {shown.map((thread) => <SummaryCard key={thread.id} project={project} thread={thread} summary={summaries.get(thread.id)} panes={panes}
            parent={parentOf(thread)} now={now} onOpen={() => thread.paneId ? onOpenPane(thread.paneId) : onOpenNode(thread.id)} />)}
        </ul>
        {hidden > 0 && <button type="button" className="quiet-action mt-2" onClick={() => setDoneShown(doneShown + DONE_PAGE)}>
          Show {Math.min(DONE_PAGE, hidden)} more
        </button>}
      </section>;
    })}
    {sections.length === 0 && <p className="px-1 text-footnote text-muted-foreground">No threads yet.</p>}
  </div>;
}

function SummaryCard({ project, thread, summary, panes, parent, now, onOpen }: {
  project: ProjectView;
  thread: ProjectThreadView;
  summary?: ThreadSummary;
  panes: readonly AgentView[];
  /** The coordinator it runs under, when that is not the one whose Summary this is. */
  parent?: ProjectThreadView;
  now: number;
  onOpen: () => void;
}) {
  const state = nodeState(thread);
  const said = thread.verdict ? VERDICT_LABEL[thread.verdict] : state === "resolved" || state === "review" ? STATE_LABEL[state] : threadDetail(thread, panes);
  const meta = [said, parent && `in ${parent.title}`, threadAge(thread, now)].filter(Boolean).join(" · ");
  return <li>
    <article aria-label={thread.title} className="rounded-xl border border-border bg-card/40 px-3.5 py-3">
      <button type="button" className="flex w-full items-start gap-2.5 text-left" onClick={onOpen}>
        <NodeDot state={state} className="mt-[7px] size-2" />
        <span className="min-w-0 flex-1">
          <span className={cn("block break-words text-body font-medium", state === "resolved" && "text-muted-foreground")}>{thread.title}</span>
          <span className="block text-footnote text-muted-foreground">{meta}</span>
        </span>
        <ChevronRight aria-hidden className="mt-1 size-4 shrink-0 text-muted-foreground" />
      </button>
      <ReportContent project={project} summary={summary} pr={thread.pr} />
    </article>
  </li>;
}

/** A node's own report at the top of its page: its verdict, then what it says and shows. Nothing without one. */
export function OwnReport({ project, thread, summary }: { project: ProjectView; thread: ProjectThreadView; summary?: ThreadSummary }) {
  if (!thread.verdict && !summary) return null;
  return <div className="mt-3 border-t border-border pt-3">
    {thread.verdict && <p className={cn("text-footnote font-medium", VERDICT_TONE[thread.verdict])}>Report: {VERDICT_LABEL[thread.verdict]}</p>}
    <ReportContent project={project} summary={summary} />
  </div>;
}

function ReportContent({ project, summary, pr }: { project: ProjectView; summary?: ThreadSummary; pr?: ThreadPullRequest }) {
  return <>
    {summary?.summary && <p className="mt-2 whitespace-pre-line break-words text-subhead">{summary.summary}</p>}
    {pr && <div className="mt-2.5"><PrChip pr={pr} /></div>}
    {summary && summary.captures.length > 0 && <Captures project={project} captures={summary.captures} />}
    {summary && summary.deliverables.length > 0 && <Deliverables project={project} deliverables={summary.deliverables} />}
  </>;
}

function PrChip({ pr }: { pr: ThreadPullRequest }) {
  const body = <><GitPullRequest aria-hidden className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{prSummary(pr)}</span></>;
  if (!pr.url) return <span className={CHIP}>{body}</span>;
  return <a className={cn(CHIP, "hover:bg-accent")} href={pr.url} target="_blank" rel="noreferrer">
    {body}<ExternalLink aria-hidden className="size-3 shrink-0 text-muted-foreground" />
  </a>;
}

/**
 * The report's pictures in one row that scrolls sideways and snaps; a tap opens them large. Every
 * picture keeps its whole frame at one height, so a phone screen and a desk screen sit side by side
 * uncropped; a caption wraps under its own picture.
 */
function Captures({ project, captures }: { project: ProjectView; captures: readonly ThreadCapture[] }) {
  const [opened, setOpened] = useState<number | null>(null);
  const images = captures.map((capture, index) => ({ key: capture.path, src: orgLibraryUrl(project.slug, capture.path), label: capture.caption || `Capture ${index + 1}` }));
  return <>
    <ul aria-label="Captures" className="-mx-3.5 mt-3 flex snap-x snap-mandatory scroll-px-3.5 gap-2.5 overflow-x-auto overscroll-x-contain px-3.5 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {images.map((image, index) => <li key={image.key} className="flex w-min shrink-0 snap-start flex-col">
        <CaptureThumb src={image.src} label={image.label} onOpen={() => setOpened(index)} />
        {captures[index]!.caption && <p className="mt-1.5 line-clamp-2 text-caption text-muted-foreground">{captures[index]!.caption}</p>}
      </li>)}
    </ul>
    {opened !== null && <Suspense fallback={null}><CaptureViewer images={images} start={opened} onClose={() => setOpened(null)} /></Suspense>}
  </>;
}

function CaptureThumb({ src, label, onOpen }: { src: string; label: string; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  return <button type="button" aria-label={`Open ${label}`} onClick={onOpen}
    className={cn("relative block h-64 min-w-32 overflow-hidden rounded-lg bg-muted sm:h-60", IMAGE_EDGE)}>
    {failed
      ? <ImageIcon aria-hidden className="absolute inset-0 m-auto size-5 text-muted-foreground" />
      : <img src={src} alt={label} loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)}
        className="block h-64 w-auto max-w-[min(calc(100vw-5rem),40rem)] object-contain sm:h-60" />}
  </button>;
}

/** HTML and PDF open in a new tab through the library route; Markdown is named, as the route does not serve it. */
function Deliverables({ project, deliverables }: { project: ProjectView; deliverables: readonly ThreadDeliverable[] }) {
  return <ul aria-label="Deliverables" className="mt-3 flex flex-wrap gap-2">
    {deliverables.map((deliverable) => {
      const Icon = deliverable.kind === "html" ? Globe : FileText;
      const name = <><Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{fileName(deliverable.path)}</span></>;
      return <li key={deliverable.path} className="min-w-0 max-w-full">
        {deliverable.kind === "md"
          ? <span className={cn(CHIP, "bg-transparent px-1 text-muted-foreground")}>{name}</span>
          : <a className={cn(CHIP, "hover:bg-accent")} href={orgLibraryUrl(project.slug, deliverable.path)} target="_blank" rel="noreferrer">
            {name}<ExternalLink aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          </a>}
      </li>;
    })}
  </ul>;
}
