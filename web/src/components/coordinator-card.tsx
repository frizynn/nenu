import type { ReactNode } from "react";
import { Check, GitPullRequest, TriangleAlert } from "@/components/ui/icon";

import { NodeDot } from "@/components/node-row";
import { prSummary } from "@/components/project-tasks";
import { StatusDot } from "@/components/status-badge";
import { formatContextTokens } from "@/components/workbench-context-meter";
import { askDetail, coordinatorAsks } from "@/lib/asks";
import { VERDICT_LABEL } from "@/lib/coordinator-summary";
import { timeAgo } from "@/lib/format";
import { flatten, orgTree, STATE_LABEL, type OrgNode } from "@/lib/org-tree";
import type { AskGroup, AsksList, ProjectView, StatusFile, ThreadSummary, TokenUsage } from "@/lib/types";

// A coordinator's card (ADR 0091), as Herdr Organizations' popup draws one: its objective, what waits
// on you, its other asks with what their links confirm, the agents it runs with their state and
// verdict, their pull requests, and how full its context is. Every part comes from fields
// Organizations prints; an Organizations that predates them draws no card.

/** Rows a section lists before saying how many more. */
const MOST = 5;
const CAP_WORD: Record<string, string> = { context_warn: "context", compaction_warn: "compactions", tokens_warn: "tokens" };

/** An ask's mark in its group: red waits on you, a warning does not close, yellow is in progress, a check is done. */
export function AskMark({ group }: { group: AskGroup }) {
  const box = "flex size-4 shrink-0 items-center justify-center";
  if (group === "unclosed") return <span className={box}><TriangleAlert aria-hidden size={14} className="text-status-working" /></span>;
  if (group === "done") return <span className={box}><Check aria-hidden size={14} className="text-status-done" /></span>;
  if (group === "other") return <span className={box}><span aria-hidden className="size-1 rounded-full bg-muted-foreground" /></span>;
  return <span className={box}><StatusDot status={group === "waiting" ? "blocked" : "working"} surface="bg-transparent" className="size-2" /></span>;
}

/** Whether Organizations printed anything a card draws; without it the page stays as it was. */
export function hasCard(asks: AsksList | null, status: StatusFile | undefined, usage: TokenUsage | undefined): boolean {
  return Boolean(asks?.asks || status?.objective || usage);
}

export function CoordinatorCard({ project, coordinatorId, status, usage, asks, summaries, onOpenNode, now = Date.now() }: {
  project: ProjectView;
  /** `root` for the project's own coordinator. */
  coordinatorId: string;
  status?: StatusFile;
  usage?: TokenUsage;
  asks: AsksList | null;
  summaries: ReadonlyMap<string, ThreadSummary>;
  /** Opens one of its agents: its chat when it runs in a live pane, its page otherwise. */
  onOpenNode: (node: OrgNode) => void;
  now?: number;
}) {
  const mine = coordinatorAsks(asks, project.slug, coordinatorId);
  const tree = orgTree(project.threads);
  const children = coordinatorId === "root" ? tree.open : flatten(tree.open).find((node) => node.thread.id === coordinatorId)?.children ?? [];
  const prs = children.filter((node) => node.thread.pr);
  const updated = Date.parse(status?.updated ?? "");

  return <section aria-label="Coordinator card" className="mb-5 flex flex-col gap-4 rounded-xl border border-border bg-card/40 px-3.5 py-3 text-sm">
    {status?.objective && <div>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-footnote font-semibold text-muted-foreground">Objective</h3>
        {Number.isFinite(updated) && <span className="text-footnote text-muted-foreground">updated {timeAgo(updated, now)}</span>}
      </div>
      <p className="mt-0.5 break-words text-subhead">{status.objective}</p>
    </div>}
    {mine && mine.waiting.length > 0 && <CardList label="Waits on you" count={mine.waiting.length}>
      {mine.waiting.slice(0, MOST).map((text, index) => <Row key={index} mark={<AskMark group="waiting" />} title={text} />)}
    </CardList>}
    {mine && mine.asks.length > 0 && <CardList label="Asks" count={mine.asks.length}>
      {mine.asks.slice(0, MOST).map((ask) => <Row key={`${ask.line}:${ask.text}`} mark={<AskMark group={ask.group} />} title={ask.text} detail={askDetail(ask)} />)}
    </CardList>}
    {children.length > 0 && <CardList label="Agents" count={children.length}>
      {children.slice(0, MOST).map((node) => {
        const { thread } = node;
        const overCap = (summaries.get(thread.id)?.usage?.overCap.length ?? 0) > 0;
        const detail = [STATE_LABEL[node.state], thread.verdict && VERDICT_LABEL[thread.verdict], overCap && "over cap"].filter(Boolean).join(" · ");
        return <li key={thread.id}>
          <button type="button" className="flex w-full min-w-0 items-start gap-2.5 rounded-lg py-1 text-left hover:bg-muted/50" onClick={() => onOpenNode(node)}>
            <span className="flex size-4 shrink-0 items-center justify-center pt-1"><NodeDot state={node.state} /></span>
            <RowText title={thread.title} detail={detail} />
          </button>
        </li>;
      })}
    </CardList>}
    {prs.length > 0 && <CardList label="Pull requests" count={prs.length}>
      {prs.slice(0, MOST).map(({ thread }) => <li key={thread.id}>
        <a className="flex min-w-0 items-start gap-2.5 rounded-lg py-1 hover:bg-muted/50" href={thread.pr!.url} target="_blank" rel="noreferrer">
          <span className="flex size-4 shrink-0 items-center justify-center pt-0.5"><GitPullRequest aria-hidden size={14} className="text-muted-foreground" /></span>
          <RowText title={thread.title} detail={prSummary(thread.pr!)} />
        </a>
      </li>)}
    </CardList>}
    {usage && <div>
      <h3 className="text-footnote font-semibold text-muted-foreground">Tokens</h3>
      <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-subhead tabular-nums">
        <span>Context {formatContextTokens(usage.context)}</span>
        <span className="text-muted-foreground">· peak {formatContextTokens(usage.peakContext)}</span>
        <span className="text-muted-foreground">· {usage.compactions} {usage.compactions === 1 ? "compaction" : "compactions"}</span>
        {usage.overCap.length > 0 && <span data-over-cap className="inline-flex h-5 items-center gap-1 rounded-md bg-status-working/15 px-1.5 text-[11px] font-medium text-status-working">
          <TriangleAlert aria-hidden size={12} />Over cap: {usage.overCap.map((cap) => CAP_WORD[cap] ?? cap).join(", ")}
        </span>}
      </p>
    </div>}
  </section>;
}

function CardList({ label, count, children }: { label: string; count: number; children: ReactNode[] }) {
  return <div>
    <h3 className="flex items-baseline gap-1.5 text-footnote font-semibold text-muted-foreground">{label}<span className="font-normal tabular-nums">{count}</span></h3>
    <ul className="mt-0.5">{children}</ul>
    {count > MOST && <p className="pl-6.5 text-footnote text-muted-foreground">+{count - MOST} more</p>}
  </div>;
}

function Row({ mark, title, detail }: { mark: ReactNode; title: string; detail?: string }) {
  return <li className="flex min-w-0 items-start gap-2.5 py-1">
    <span className="pt-0.5">{mark}</span>
    <RowText title={title} detail={detail} />
  </li>;
}

function RowText({ title, detail }: { title: string; detail?: string }) {
  return <span className="min-w-0 flex-1">
    <span className="block break-words">{title}</span>
    {detail && <span className="block break-words text-footnote text-muted-foreground">{detail}</span>}
  </span>;
}
