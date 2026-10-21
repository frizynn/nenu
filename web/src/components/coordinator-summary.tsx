import { lazy, Suspense, useState } from "react";
import { useRouteLoaderData } from "react-router";
import { ChevronRight, ExternalLink, FileText, GitPullRequest, Globe, ImageIcon, Sparkle } from "@/components/ui/icon";

import { IMAGE_EDGE } from "@/components/message-images";
import { BusyLabel } from "@/components/home-panels";
import { FullReport } from "@/components/thread-report";
import { prSummary } from "@/components/project-tasks";
import { explainOrgThread, orgLibraryUrl } from "@/lib/api";
import { VERDICT_LABEL } from "@/lib/coordinator-summary";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { useSession } from "@/lib/session";
import { isReadOnly, type ProjectThreadView, type ProjectView, type ThreadCapture, type ThreadDeliverable, type ThreadPullRequest, type ThreadSummary, type ThreadVerdict } from "@/lib/types";
import { cn } from "@/lib/utils";

const CaptureViewer = lazy(() => import("./capture-viewer"));

// A node's own report (ADR 0089, its Summary superseded by ADR 0109): what its agent's last report says
// in plain words, its PR, the pictures it took and the documents it left. Every report field may be
// missing (an Organizations without them, a thread that has not reported), and the page then shows only
// what Organizations knows. The summary is the agent's text, drawn as text.
export const VERDICT_TONE: Record<ThreadVerdict, string> = { done: "text-status-done", "needs-decision": "text-status-blocked", blocked: "text-status-blocked", failed: "text-status-blocked" };
const CHIP = "inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-md bg-muted px-2 text-caption font-medium text-foreground";

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** A node's own report at the top of its page: its verdict, then what it says and shows. Nothing without one. */
export function OwnReport({ project, thread, summary }: { project: ProjectView; thread: ProjectThreadView; summary?: ThreadSummary }) {
  const [full, setFull] = useState(false);
  if (!thread.verdict && !summary) return null;
  return <div className="mt-3 border-t border-border pt-3">
    {thread.verdict && <p className={cn("text-footnote font-medium", VERDICT_TONE[thread.verdict])}>Report: {VERDICT_LABEL[thread.verdict]}</p>}
    <ReportContent project={project} summary={summary} />
    {/* The whole report, read when opened; the pictures and documents above stay where they are. */}
    <button type="button" className="quiet-action mt-2 -ml-2" aria-expanded={full} onClick={() => setFull(!full)}>
      <ChevronRight aria-hidden className={cn("size-3.5 transition-transform", full && "rotate-90")} />Full report
    </button>
    {full && <FullReport project={project.slug} thread={thread.id} />}
  </div>;
}

function ReportContent({ project, summary, pr }: { project: ProjectView; summary?: ThreadSummary; pr?: ThreadPullRequest }) {
  return <>
    {summary && <ReportWords project={project} summary={summary} />}
    {pr && <div className="mt-2.5"><PrChip pr={pr} /></div>}
    {summary && summary.captures.length > 0 && <Captures project={project} captures={summary.captures} />}
    {summary && summary.deliverables.length > 0 && <Deliverables project={project} deliverables={summary.deliverables} />}
  </>;
}

/**
 * What the report says. Once Organizations' summary agent wrote it in plain words for this report,
 * those lead and the agent's own words are a tap away; otherwise the agent's words, with a button
 * that asks for plain ones where Organizations offers it. Both are model text, drawn as text.
 */
function ReportWords({ project, summary }: { project: ProjectView; summary: ThreadSummary }) {
  const [answer, setAnswer] = useState<string | null>(null);
  const [own, setOwn] = useState(false);
  const plain = answer ?? (summary.plain?.current && summary.plain.text ? summary.plain.text : null);
  const words = summary.summary;
  return <>
    {plain
      ? <p className="mt-2 whitespace-pre-line break-words text-subhead">{plain}</p>
      : words && <p className="mt-2 whitespace-pre-line break-words text-subhead">{words}</p>}
    {plain && words && <>
      <button type="button" className="quiet-action mt-1 -ml-2" aria-expanded={own} onClick={() => setOwn(!own)}>
        <ChevronRight aria-hidden className={cn("size-3.5 transition-transform", own && "rotate-90")} />Agent's words
      </button>
      {own && <p className="mt-1 whitespace-pre-line break-words text-footnote text-muted-foreground">{words}</p>}
    </>}
    {!plain && summary.explainable && <ExplainButton project={project.slug} id={summary.id} onAnswer={setAnswer} />}
  </>;
}

/** Asks the summary agent for one report in plain words; a device that may not write sees nothing. */
function ExplainButton({ project, id, onAnswer }: { project: string; id: string; onAnswer: (text: string) => void }) {
  const session = useSession();
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData | undefined;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  if (isReadOnly(data?.device)) return null;
  const explain = async () => {
    setBusy(true);
    setFailed(null);
    try {
      onAnswer((await explainOrgThread({ project, id }, session)).explained.text);
    } catch (error) {
      setFailed(error instanceof Error ? error.message : "Could not explain the report.");
      setBusy(false);
    }
  };
  return <>
    <button type="button" className="quiet-action mt-1 -ml-2" disabled={busy} onClick={() => void explain()}>
      <Sparkle aria-hidden className="size-3.5" /><BusyLabel busy={busy}>In plain words</BusyLabel>
    </button>
    {failed && <p role="alert" className="mt-1 text-footnote text-muted-foreground">Could not explain it: {failed}</p>}
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
 * The report's pictures in one row that scrolls sideways; a tap opens them large. Every
 * picture keeps its whole frame at one height, so a phone screen and a desk screen sit side by side
 * uncropped; a caption wraps under its own picture.
 */
export function Captures({ project, captures }: { project: ProjectView; captures: readonly ThreadCapture[] }) {
  const [opened, setOpened] = useState<number | null>(null);
  const images = captures.map((capture, index) => ({ key: capture.path, src: orgLibraryUrl(project.slug, capture.path), label: capture.caption || `Capture ${index + 1}` }));
  return <>
    <ul aria-label="Captures" className="-mx-3.5 mt-3 flex gap-2.5 overflow-x-auto overscroll-x-contain px-3.5 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {images.map((image, index) => <li key={image.key} className="flex w-min shrink-0 flex-col">
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

/** HTML and PDF, each opened in a new tab through the library route. */
export function Deliverables({ project, deliverables }: { project: ProjectView; deliverables: readonly ThreadDeliverable[] }) {
  return <ul aria-label="Deliverables" className="mt-3 flex flex-wrap gap-2">
    {deliverables.map((deliverable) => {
      const Icon = deliverable.kind === "html" ? Globe : FileText;
      return <li key={deliverable.path} className="min-w-0 max-w-full">
        <a className={cn(CHIP, "hover:bg-accent")} href={orgLibraryUrl(project.slug, deliverable.path)} target="_blank" rel="noreferrer">
          <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{fileName(deliverable.path)}</span>
          <ExternalLink aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        </a>
      </li>;
    })}
  </ul>;
}
