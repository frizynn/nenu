import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { MarkdownText, TextTokensContext } from "@/components/markdown-text";
import { timeAgo } from "@/lib/format";
import type { ProjectView, StatusFile } from "@/lib/types";
import { cn } from "@/lib/utils";

// A coordinator's STATUS.md (ADR 0090): what the operator asked and where each thing stands, kept by
// the agent and drawn as it wrote it, through the transcript's Markdown renderer. It adds two touches
// and nothing else: a known `[state]` opening a line is a chip, and a thread id this project lists
// opens its node. A long file shown unasked folds under Show all. Under a coordinator's card, which
// already says what the file says, it starts closed (ADR 0091), and the person's tap opens all of it:
// a fold there was a clipped box the wheel could not move (ADR 0108).

type AskState = "open" | "working" | "needs-decision" | "answered" | "done";
const ASK_STATE: Record<AskState, { label: string; tone: string }> = {
  open: { label: "Open", tone: "bg-muted text-muted-foreground" },
  working: { label: "Working", tone: "bg-status-working/15 text-status-working" },
  "needs-decision": { label: "Needs decision", tone: "bg-status-blocked/15 text-status-blocked" },
  answered: { label: "Answered", tone: "bg-status-done/15 text-status-done" },
  done: { label: "Done", tone: "bg-status-done/15 text-status-done" },
};
const LEAD_STATE = /^\[(open|working|needs-decision|answered|done)\](?=\s|$)/;
const THREAD_ID = /\bt-\d{4,}\b/g;
// The file's own `# Status` heading: the block is titled already.
const TITLE = /^\s*#\s+status\s*(?:\n|$)/i;

export function CoordinatorStatus({ status, project, onOpenNode, closed = false, now = Date.now() }: {
  status: StatusFile;
  project: ProjectView;
  onOpenNode: (id: string) => void;
  /** One line that opens the file, while a card above it already says what the file says. */
  closed?: boolean;
  now?: number;
}) {
  const [opened, setOpened] = useState(false);
  const shown = opened || !closed;
  const [unfolded, setUnfolded] = useState(false);
  const open = unfolded || closed;
  const [overflows, setOverflows] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const text = status.text.replace(TITLE, "");
  const updated = Date.parse(status.updated);

  // Measured while folded, again when the text or the box's width changes; unfolding needs no measure.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || open || !shown) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, open, shown]);

  const known = new Set(project.threads.map((thread) => thread.id));
  const tokens = (run: string): ReactNode => {
    const lead = LEAD_STATE.exec(run);
    const rest = lead ? run.slice(lead[0].length) : run;
    const pieces: ReactNode[] = [];
    if (lead) {
      const { label, tone } = ASK_STATE[lead[1] as AskState];
      pieces.push(<span key="state" data-state={lead[1]} className={cn("mr-0.5 inline-flex h-5 items-center rounded-md px-1.5 align-[1px] text-[11px] font-medium", tone)}>{label}</span>);
    }
    let last = 0;
    for (const match of rest.matchAll(THREAD_ID)) {
      if (!known.has(match[0])) continue;
      pieces.push(rest.slice(last, match.index));
      pieces.push(<button key={match.index} type="button" className="hit-area font-medium text-primary underline-offset-2 hover:underline"
        onClick={() => onOpenNode(match[0])}>{match[0]}</button>);
      last = match.index + match[0].length;
    }
    pieces.push(rest.slice(last));
    return pieces;
  };

  const heading = <div className="flex items-baseline justify-between gap-3">
    <h3 className="text-subhead font-semibold">Status</h3>
    {Number.isFinite(updated) && <span className="text-footnote text-muted-foreground">updated {timeAgo(updated, now)}</span>}
  </div>;
  if (!shown) return <section aria-label="Status" className="mb-5 rounded-xl border border-border bg-card/40 px-3.5 py-3">
    {heading}
    <button type="button" className="quiet-action -ml-2 mt-1" onClick={() => setOpened(true)}>Show STATUS.md</button>
  </section>;

  return <section aria-label="Status" className="mb-5 rounded-xl border border-border bg-card/40 px-3.5 py-3">
    {heading}
    {/* The left gutter keeps a list's markers inside the fold's clip. Section headings read as labels
        under the block's own title (markdown-text draws levels 1 and 2 as `text-headline`). */}
    <div ref={box} className={cn("-ml-2 mt-1.5 pl-2 [&_.text-headline]:mt-3 [&_.text-headline]:text-footnote [&_.text-headline]:font-semibold [&_.text-headline]:text-muted-foreground",
      !open && "max-h-72 overflow-hidden",
      // The fade clears a full line above the cut, so a row the cut slices is never read as whole.
      !open && overflows && "[mask-image:linear-gradient(to_bottom,black_calc(100%-5rem),transparent_calc(100%-1.5rem))]")}>
      <TextTokensContext.Provider value={tokens}><MarkdownText text={text} className="text-subhead" /></TextTokensContext.Provider>
    </div>
    {overflows && !closed && <button type="button" className={cn("quiet-action -ml-2", open ? "mt-1" : "-mt-6")} onClick={() => setUnfolded(!open)}>
      {open ? "Show less" : "Show all"}
    </button>}
  </section>;
}
