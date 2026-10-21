import { useRef, type ReactNode } from "react";
import { ChevronRight, FileCode, History, Plus } from "@/components/ui/icon";

import { OverviewCard } from "@/components/coordinator-sections";
import { DiffStat } from "@/components/diff-stat";
import { useDiffRead, type DiffRead } from "@/components/diff-viewer";
import { NodeDot } from "@/components/node-row";
import { threadAge } from "@/components/project-tasks";
import type { SessionPr, SessionReading } from "@/components/session-inspector";
import { fetchSessionDiff } from "@/lib/api";
import { shortCwd } from "@/lib/format";
import { modelDisplayName } from "@/lib/model-display";
import { coordinatorState, nodeState, STATE_LABEL, type NodeState } from "@/lib/org-tree";
import { isOpenThread } from "@/lib/projects";
import { agentLabel } from "@/lib/spawn";
import type { AgentView, ProjectThreadView } from "@/lib/types";

/** The files the Changes card names before it sends the rest to the Changes tab. */
const FILES_SHOWN = 5;

/** A coordinator the overview names, and the way to it. */
export interface CoordinatorLink {
  title: string;
  open: () => void;
}

export interface ThreadOverviewProps {
  /** The pane's thread; absent on the project coordinator's own pane. */
  thread?: ProjectThreadView;
  /** The pane as Herdr lists it, for the agent and, without a thread, its state. */
  pane?: AgentView;
  paneId: string;
  session?: string;
  pr?: SessionPr;
  reading: SessionReading;
  /** Who this pane answers to; absent on the project coordinator's own pane. */
  parent?: CoordinatorLink;
  /** The threads of the coordinator in the last card: this one's siblings, or a coordinator's own. */
  threads: readonly ProjectThreadView[];
  /** The pane is a coordinator: the last card lists its own threads, not its parent's. */
  coordinating: boolean;
  onShowChanges: () => void;
  onOpenThread: (thread: ProjectThreadView) => void;
  /** A coordinator's: start a thread under it, from its Threads card. */
  onNewThread?: () => void;
  /** A coordinator's: how many of its threads finished, and the project's History that lists them. */
  finished?: { count: number; open: () => void };
  /** A coordinator's: what its page held, drawn around its Threads and Changes cards (CoordinatorSections). */
  around?: (cards: ReactNode) => ReactNode;
  now?: number;
}

/**
 * A project pane's Overview, the first tab of its panel on a desk: this thread (its state, who it
 * answers to, its pull request, its agent and context), what it changed, and the threads of the
 * coordinator it belongs to. Each card answers one question; the diff is read only while it is shown.
 */
export function ThreadOverview(props: ThreadOverviewProps) {
  // Read again when the thread or its agent moves: a turn that ends has usually changed files.
  const changes = <ChangesCard paneId={props.paneId} session={props.session} stamp={`${props.thread?.updated ?? ""}\0${props.pane?.status ?? ""}`} onShow={props.onShowChanges} />;
  return (
    <div className="flex flex-col gap-3 px-3 pb-8 pt-3">
      <ThisThread {...props} />
      {/* A coordinator's own threads come before what it changed; a thread's coordinator after. */}
      {props.around ? props.around(<><CoordinatorCard {...props} />{changes}</>) : <>{changes}<CoordinatorCard {...props} /></>}
    </div>
  );
}

function Row({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="overview-row">
      <dt className="shrink-0 text-muted-foreground">{name}</dt>
      <dd className="flex min-w-0 items-center justify-end gap-1.5 text-right">{children}</dd>
    </div>
  );
}

function ThisThread({ thread, pane, pr, reading, parent, coordinating, now = Date.now() }: ThreadOverviewProps) {
  const state: NodeState = thread ? nodeState(thread) : (pane && coordinatorState(pane.status)) ?? "idle";
  const age = thread && threadAge(thread, now);
  const agent = thread?.agent ?? pane?.agent;
  const agentName = agent && agentLabel(agent);
  const model = reading.model && modelDisplayName(reading.model);
  const percent = reading.contextPercent;
  return (
    <OverviewCard label={coordinating ? "This coordinator" : "This thread"}>
      <dl className="overview-body">
        <Row name="Status"><NodeDot state={state} />{STATE_LABEL[state]}{age && <span className="text-muted-foreground">· {age}</span>}</Row>
        {parent && <Row name="Coordinator">
          <button type="button" onClick={parent.open} className="overview-link">
            <span className="truncate">{parent.title}</span><ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </Row>}
        {/* The project coordinator opens no pull request of its own, and a coordinator rarely does. */}
        {thread && (!coordinating || pr) && <Row name="Pull request">
          {!pr ? <span className="text-muted-foreground">Not opened yet</span>
            : pr.url ? <a href={pr.url} target="_blank" rel="noreferrer" className="overview-link">{prName(pr)}</a>
            : <span>{prName(pr)}</span>}
        </Row>}
        {agentName && <Row name="Agent"><span className="truncate">{[agentName, model].filter(Boolean).join(" · ")}</span></Row>}
        {percent !== undefined && <Row name="Context">
          <span className="text-xs tabular-nums text-muted-foreground">{percent}%</span>
          <span role="progressbar" aria-label="Context used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="overview-meter">
            <span style={{ width: `${percent}%` }} />
          </span>
        </Row>}
      </dl>
    </OverviewCard>
  );
}

function prName(pr: SessionPr): string {
  const name = pr.number !== undefined ? `#${pr.number}` : "Open";
  return pr.state && pr.state !== "open" ? `${name} · ${pr.state}` : name;
}

/** What the branch changed against where it started: the total and the first files, the diff a tap away. */
function ChangesCard({ paneId, session, stamp, onShow }: { paneId: string; session?: string; stamp: string; onShow: () => void }) {
  const latest = useDiffRead(`${paneId}\0${session ?? ""}\0${stamp}`, true, (signal) => fetchSessionDiff(paneId, "branch", session, signal));
  // A read again keeps the last one on screen until it lands, so the card does not blink on every turn.
  const settled = useRef<DiffRead>(latest);
  if (latest.state !== "loading") settled.current = latest;
  const read = settled.current;
  const diff = read.state === "read" && read.diff.ok ? read.diff : undefined;
  const files = diff?.files ?? [];
  const rest = (diff?.totals.files ?? 0) - Math.min(files.length, FILES_SHOWN);
  const failure = read.state === "failed" ? read.message : read.state === "read" && !read.diff.ok ? read.diff.message : undefined;
  return (
    <OverviewCard label="Changes" head={<button type="button" onClick={onShow} className="overview-card-action">
      <span className="flex-1 text-left">Changes</span>
      {diff && diff.totals.files > 0 && <DiffStat diff={diff.totals} className="text-xs" />}
      <ChevronRight aria-hidden className="size-3.5 text-muted-foreground" />
    </button>}>
      <div className="overview-body">
        {read.state === "loading" && <p role="status" className="overview-note">Reading the branch…</p>}
        {diff?.repo && <p className="overview-note">In the project's repository, <code className="font-mono">{shortCwd(diff.repo)}</code>.</p>}
        {failure && <p className="overview-note">{failure}</p>}
        {diff && diff.totals.files === 0 && <p className="overview-note">Nothing changed on this branch.</p>}
        {files.length > 0 && <ul aria-label="Changed files">
          {files.slice(0, FILES_SHOWN).map((file) => <li key={file.path}>
            <button type="button" onClick={onShow} title={file.path} className="overview-file">
              <FileCode aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              {/* Right-to-left so a long path keeps its file name and loses its folders. */}
              <span className="min-w-0 flex-1 truncate text-left [direction:rtl]"><bdi>{file.path}</bdi></span>
              <DiffStat diff={file} className="text-xs" />
            </button>
          </li>)}
        </ul>}
        {rest > 0 && <button type="button" onClick={onShow} className="overview-note overview-more">{rest} more {rest === 1 ? "file" : "files"}</button>}
      </div>
    </OverviewCard>
  );
}

/** The coordinator this thread belongs to and its other open threads, this one marked. */
function CoordinatorCard({ thread, threads, parent, coordinating, paneId, onOpenThread, onNewThread, finished, now = Date.now() }: ThreadOverviewProps) {
  const open = threads.filter(isOpenThread);
  // A coordinator's own card stays, empty, for its New thread and its History.
  if (open.length === 0 && !coordinating) return null;
  const coordinator = coordinating ? undefined : parent;
  return (
    <OverviewCard label={coordinator ? `Coordinator ${coordinator.title}` : "Threads"} head={coordinator ? <>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs font-normal text-muted-foreground">Coordinator</span>
        <span className="truncate">{coordinator.title}</span>
      </span>
      <button type="button" onClick={coordinator.open} className="overview-link text-xs text-muted-foreground">
        Open<ChevronRight aria-hidden className="size-3.5" />
      </button>
    </> : <>
      <span className="flex-1">Threads</span>
      {onNewThread && <button type="button" onClick={onNewThread} aria-haspopup="dialog" className="overview-link text-xs text-muted-foreground">
        <Plus aria-hidden className="size-3.5" />New thread
      </button>}
    </>}>
      {open.length === 0 && <p className="overview-note px-3.5 pb-3">Nothing running</p>}
      {open.length > 0 && <ul className="overview-threads">
        {open.map((candidate) => {
          const current = candidate.id === thread?.id || candidate.paneId === paneId;
          return <li key={candidate.id} aria-current={current ? "true" : undefined}>
            <button type="button" onClick={() => onOpenThread(candidate)} className="overview-thread">
              <NodeDot state={nodeState(candidate)} />
              <span className="min-w-0 flex-1 truncate text-left">{candidate.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{current ? "this one" : threadAge(candidate, now) ?? ""}</span>
            </button>
          </li>;
        })}
      </ul>}
      {finished && finished.count > 0 && <button type="button" onClick={finished.open} className="overview-note overview-more mx-3.5 mb-3 inline-flex items-center gap-1">
        <History aria-hidden className="size-3.5" />{finished.count} finished<ChevronRight aria-hidden className="size-3.5" />
      </button>}
    </OverviewCard>
  );
}
