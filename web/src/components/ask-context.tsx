import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";

import { Captures, Deliverables, VERDICT_TONE } from "@/components/coordinator-summary";
import { MarkdownText } from "@/components/markdown-text";
import { errorMessage } from "@/components/node-start";
import { fetchOrgReport, isApiErrorStatus } from "@/lib/api";
import { contextThread, linkChip, reportBody, type AskEntry } from "@/lib/asks";
import { VERDICT_LABEL } from "@/lib/coordinator-summary";
import { nodePath } from "@/lib/nav";
import type { AskLink, ThreadReport } from "@/lib/types";
import { cn } from "@/lib/utils";

// What a question is about, opened under it (ADR 0096): the whole report of the thread its links name,
// as the agent wrote it (tables, lists, links) with its captures and documents, read from the project's
// records folder when it opens. A question with no thread behind it shows what its links say instead.
// The report is the agent's Markdown, drawn as text.

type Read = { state: "reading" } | { state: "read"; report: ThreadReport } | { state: "none" } | { state: "failed"; error: string };

export function AskContext({ entry, session, children }: {
  entry: AskEntry;
  session?: string;
  /** What follows the context: Answer, where the question takes one. */
  children?: ReactNode;
}) {
  const thread = contextThread(entry);
  const project = entry.project.slug;
  const [read, setRead] = useState<Read>({ state: "reading" });
  useEffect(() => {
    if (!thread) return;
    const controller = new AbortController();
    setRead({ state: "reading" });
    fetchOrgReport(project, thread, controller.signal).then(
      ({ report }) => setRead({ state: "read", report }),
      (failure: unknown) => {
        if (controller.signal.aborted) return;
        setRead(isApiErrorStatus(failure, 404) ? { state: "none" } : { state: "failed", error: errorMessage(failure) });
      },
    );
    return () => controller.abort();
  }, [project, thread]);

  const links = [entry, ...entry.parts].flatMap((part) => part.links);
  const note = (text: string) => <p className="text-footnote text-muted-foreground">{text}</p>;
  return (
    <section aria-label="Context" className="mt-2 rounded-xl border border-border bg-card/40 px-3.5 py-3">
      {thread ? <>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className="min-w-0 text-footnote font-medium text-muted-foreground">
            Report of <Link className="text-primary underline-offset-2 hover:underline" to={nodePath(project, thread, session)}>
              {read.state === "read" ? read.report.title : thread}</Link>
          </h3>
          {read.state === "read" && read.report.verdict &&
            <span className={cn("text-footnote font-medium", VERDICT_TONE[read.report.verdict])}>{VERDICT_LABEL[read.report.verdict]}</span>}
        </div>
        {read.state === "reading" && note("Reading the report…")}
        {read.state === "none" && note("This thread has no report yet.")}
        {read.state === "failed" && <p role="alert" className="text-footnote text-muted-foreground">Could not read the report: {read.error}</p>}
        {read.state === "read" && <>
          <MarkdownText text={reportBody(read.report.text)} className="text-subhead" />
          {read.report.captures.length > 0 && <Captures project={entry.project} captures={read.report.captures} />}
          {read.report.deliverables.length > 0 && <Deliverables project={entry.project} deliverables={read.report.deliverables} />}
        </>}
      </> : <LinksSaid links={links} />}
      {children}
    </section>
  );
}

/** A question no thread explains: what each of its links points at, in full, or that it links nothing. */
function LinksSaid({ links }: { links: readonly AskLink[] }) {
  if (!links.length) return <p className="text-footnote text-muted-foreground">No thread, task or page is linked to this question; its coordinator's chat has the rest.</p>;
  return <ul className="flex flex-col gap-1.5 text-subhead">
    {links.map((link, index) => {
      const chip = linkChip(link);
      const what = link.kind === "task" ? `Task ${chip.label}` : link.kind === "pr" ? `Pull request ${chip.label}` : chip.label;
      return <li key={index} className="min-w-0 break-words">
        {chip.href ? <a href={chip.href} target="_blank" rel="noreferrer" className="text-primary underline-offset-2 hover:underline">{link.kind === "page" ? link.text : what}</a>
          : <span className="font-medium">{what}</span>}
        {chip.state && <span className="text-muted-foreground"> · {chip.state}</span>}
        {link.title && <span className="block text-footnote text-muted-foreground">{link.title}</span>}
      </li>;
    })}
  </ul>;
}
