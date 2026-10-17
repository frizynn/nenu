import { useEffect, useState } from "react";

import { MarkdownText } from "@/components/markdown-text";
import { errorMessage } from "@/components/node-start";
import { fetchOrgReport, isApiErrorStatus } from "@/lib/api";
import { reportBody } from "@/lib/asks";
import type { ThreadReport } from "@/lib/types";

// A thread's whole report (ADR 0096), read from the project's records folder when something opens it:
// a question's context and the thread's own page draw it the same way. It is the agent's Markdown,
// drawn as text.

export type ReportRead = { state: "reading" } | { state: "read"; report: ThreadReport } | { state: "none" } | { state: "failed"; error: string };

/** Thread `thread`'s report, read while the caller is mounted; `none` when it has none, or no thread is named. */
export function useThreadReport(project: string, thread: string | undefined): ReportRead {
  const [read, setRead] = useState<ReportRead>({ state: thread ? "reading" : "none" });
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
  return read;
}

/** The report's text, or where its read stands. */
export function ReportText({ read }: { read: ReportRead }) {
  const note = (text: string) => <p className="text-footnote text-muted-foreground">{text}</p>;
  switch (read.state) {
    case "reading": return note("Reading the report…");
    case "none": return note("This thread has no report yet.");
    case "failed": return <p role="alert" className="text-footnote text-muted-foreground">Could not read the report: {read.error}</p>;
    case "read": return <MarkdownText text={reportBody(read.report.text)} className="text-subhead" />;
  }
}

/** A thread's whole report, read once it is on screen: the thread page's "Full report". */
export function FullReport({ project, thread }: { project: string; thread: string }) {
  return <section aria-label="Full report" className="mt-2"><ReportText read={useThreadReport(project, thread)} /></section>;
}
