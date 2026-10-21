import type { ReactNode } from "react";
import { GitPullRequest, TriangleAlert } from "@/components/ui/icon";

import { AskSections } from "@/components/ask-list";
import { CoordinatorStatus } from "@/components/coordinator-status";
import { NodeDot } from "@/components/node-row";
import { prSummary } from "@/components/project-tasks";
import { formatContextTokens } from "@/components/workbench-context-meter";
import { askSections, coordinatorAsks } from "@/lib/asks";
import { VERDICT_LABEL } from "@/lib/coordinator-summary";
import { timeAgo } from "@/lib/format";
import { flatten, orgTree, STATE_LABEL, type OrgNode } from "@/lib/org-tree";
import type { AsksList, ProjectView, StatusFile, ThreadSummary, TokenUsage } from "@/lib/types";

// A coordinator's card (ADR 0091), as Herdr Organizations' popup draws one: its objective, what waits
// on you, its other asks with what their links confirm, the agents it runs with their state and
// verdict, their pull requests, and how full its context is. Every part comes from fields
// Organizations prints; an Organizations that predates them draws no card, and an empty one none.

/** Rows a section lists before saying how many more. */
const MOST = 5;
const CAP_WORD: Record<string, string> = { context_warn: "context", compaction_warn: "compactions", tokens_warn: "tokens" };

/**
 * A coordinator's card, then its STATUS.md, decided here for every coordinator page. The card shows
 * only with something to say about this coordinator, from fields an older Organizations does not
 * print. The file starts closed only when the card already says what it says (the objective, the
 * asks, the decisions), and waits for the asks, so which read lands first never changes either.
 */
export function CoordinatorHead({ project, coordinatorId, status, usage, asks, summaries, onOpenNode, onOpenStatusNode, readOnly, listsAgents = true, session }: {
  project: ProjectView;
  /** `root` for the project's own coordinator. */
  coordinatorId: string;
  /** False where the tree beside the card already lists its agents: the project page. */
  listsAgents?: boolean;
  /** The session an answer to one of its asks goes to. */
  session?: string;
  /** A read-only device: its asks send nothing. */
  readOnly: boolean;
  status?: StatusFile;
  usage?: TokenUsage;
  asks: { list: AsksList | null; loaded: boolean };
  summaries: ReadonlyMap<string, ThreadSummary>;
  /** Opens one of its agents: its chat when it runs in a live pane, its page otherwise. */
  onOpenNode: (node: OrgNode) => void;
  /** Opens a node a thread id in the file names. */
  onOpenStatusNode: (id: string) => void;
}) {
  const mine = coordinatorAsks(asks.list, project.slug, coordinatorId);
  const sections = asks.list ? askSections(asks.list, [project], { project: project.slug, coordinator: coordinatorId }) : [];
  const tree = orgTree(project.threads);
  const agents = coordinatorId === "root" ? tree.open : flatten(tree.open).find((node) => node.thread.id === coordinatorId)?.children ?? [];
  const says = Boolean(status?.objective || mine?.waiting.length || mine?.asks.length);
  const printed = Boolean(asks.list?.asks || status?.objective || usage);
  const listed = listsAgents ? agents : [];
  const prs = agents.filter((node) => node.thread.pr);
  return <>
    {printed && (says || usage || listed.length > 0 || prs.length > 0) &&
      <CoordinatorCard status={status} usage={usage} agents={listed} prs={prs} summaries={summaries} onOpenNode={onOpenNode}
        asksTitled={sections.some((section) => section.group !== "waiting")}
        asks={asks.list && sections.length > 0 && <AskSections compact whose={false} session={session} answers={asks.list.answers === true} readOnly={readOnly}
          sections={sections} />} />}
    {status && asks.loaded && <CoordinatorStatus status={status} project={project} closed={says} onOpenNode={onOpenStatusNode} />}
  </>;
}

function CoordinatorCard({ status, usage, asks, asksTitled, agents, prs, summaries, onOpenNode, now = Date.now() }: {
  status?: StatusFile;
  usage?: TokenUsage;
  /** Its asks, as Your asks draws them, narrowed to this coordinator. */
  asks: ReactNode;
  /** Titled "Your asks" only beside what waits on you: alone, Waiting on you and its kind already say it. */
  asksTitled: boolean;
  /** Its open nodes, as the tree orders them; none where the tree beside it lists them. */
  agents: OrgNode[];
  /** Those of its open nodes with a pull request. */
  prs: OrgNode[];
  summaries: ReadonlyMap<string, ThreadSummary>;
  onOpenNode: (node: OrgNode) => void;
  now?: number;
}) {
  const updated = Date.parse(status?.updated ?? "");

  return <section aria-label="Coordinator card" className="mb-5 flex flex-col gap-4 rounded-xl border border-border bg-card/40 px-3.5 py-3 text-footnote">
    {status?.objective && <div>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-footnote font-semibold text-muted-foreground">Objective</h3>
        {Number.isFinite(updated) && <span className="text-footnote text-muted-foreground">updated {timeAgo(updated, now)}</span>}
      </div>
      <p className="mt-0.5 break-words text-subhead">{status.objective}</p>
    </div>}
    {asks && (asksTitled
      ? <div><h3 className="mb-1 text-footnote font-semibold text-muted-foreground">Your asks</h3>{asks}</div>
      : asks)}
    {agents.length > 0 && <CardList label="Agents" count={agents.length}>
      {agents.slice(0, MOST).map((node) => {
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

function RowText({ title, detail }: { title: string; detail?: string }) {
  return <span className="min-w-0 flex-1">
    <span className="block break-words">{title}</span>
    {detail && <span className="block break-words text-footnote text-muted-foreground">{detail}</span>}
  </span>;
}
