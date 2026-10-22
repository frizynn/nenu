import { useRef, type ReactNode } from "react";
import { ChevronRight, FileCode, History, Plus } from "@/components/ui/icon";

import { useCoordinatorSections, type CoordinatorSectionsProps } from "@/components/coordinator-sections";
import { DiffStat } from "@/components/diff-stat";
import { useDiffRead, type DiffRead } from "@/components/diff-viewer";
import { MarkTile } from "@/components/mark-picker";
import { NodeDot } from "@/components/node-row";
import { PanelSections, type PanelSection } from "@/components/panel-sections";
import { CoordinatorGlyph } from "@/components/project-glyph";
import { threadAge, threadDetail } from "@/components/project-tasks";
import type { SessionPr, SessionReading } from "@/components/session-inspector";
import { fetchSessionDiff } from "@/lib/api";
import { shortCwd } from "@/lib/format";
import { needYou } from "@/lib/home-stats";
import { modelDisplayName } from "@/lib/model-display";
import { coordinatorState, nodeState, STATE_LABEL, workUnder, type NodeState, type OrgNode } from "@/lib/org-tree";
import { isOpenThread } from "@/lib/projects";
import { agentLabel } from "@/lib/spawn";
import type { AgentView, ProjectThreadView, ProjectView } from "@/lib/types";

/** The files the Changes card names before it sends the rest to the Changes tab. */
const FILES_SHOWN = 5;

/** A coordinator the overview names, and the way to it. */
export interface CoordinatorLink {
  title: string;
  /** Its node id, `root` for the project's coordinator: what draws its mark. */
  id: string;
  open: () => void;
}

export interface ThreadOverviewProps {
  /** The project, for the coordinators' marks (ADR 0122). */
  project: ProjectView;
  /** A read-only device draws a coordinator's mark and picks none. */
  readOnly: boolean;
  onChanged: () => void;
  /** The pane's thread; absent on the project coordinator's own pane. */
  thread?: ProjectThreadView;
  /** The pane as Herdr lists it, for the agent and, without a thread, its state. */
  pane?: AgentView;
  /** Live panes, so a running thread can say what it is doing right now. */
  panes?: readonly AgentView[];
  paneId: string;
  session?: string;
  pr?: SessionPr;
  reading: SessionReading;
  /** Who this pane answers to; absent on the project coordinator's own pane. */
  parent?: CoordinatorLink;
  /** A thread's: its siblings under its coordinator. A coordinator's: everything under it, nested coordinators' work too. */
  threads: readonly ProjectThreadView[];
  /** The pane is a coordinator: its Threads section lists the work under it, not its parent's. */
  coordinating: boolean;
  onShowChanges: () => void;
  onOpenThread: (thread: ProjectThreadView) => void;
  /** A coordinator's: start a thread under it, from its Threads section. */
  onNewThread?: () => void;
  /** A coordinator's: how many of its threads finished, and the project's History that lists them. */
  finished?: { count: number; open: () => void };
  /** A coordinator's: what its page held (CoordinatorSections), as sections of their own and what goes under them. */
  extra?: { sections: PanelSection[]; footer?: ReactNode };
  now?: number;
}

/** A coordinator's sections, live work first; ids the operator's layout remembers (lib/panel-layout). */
const COORDINATOR_ORDER = ["threads", "waiting", "changes", "this", "routines", "status"];

/**
 * A project pane's Overview, the first tab of its panel on a desk: this thread (its state, who it
 * answers to, its pull request, its agent and context), what it changed, and the threads of the
 * coordinator it belongs to; a coordinator's also what its page held. Each section answers one
 * question, folds under its head and keeps the place the operator gave it; the diff is read only
 * while the Overview is on screen.
 */
export function ThreadOverview(props: ThreadOverviewProps) {
  // Read again when the thread or its agent moves: a turn that ends has usually changed files.
  const changes = useChangesSection(props.paneId, props.session, `${props.thread?.updated ?? ""}\0${props.pane?.status ?? ""}`, props.onShowChanges);
  const own = [thisSection(props), changes, ...(props.coordinating ? [threadsSection(props)] : siblingsSection(props))];
  const sections = props.coordinating
    ? [...own, ...(props.extra?.sections ?? [])].sort((a, b) => COORDINATOR_ORDER.indexOf(a.id) - COORDINATOR_ORDER.indexOf(b.id))
    : own;
  return (
    <div className="px-3 pb-8 pt-3">
      <PanelSections kind={props.coordinating ? "coordinator" : "thread"} sections={sections} footer={props.extra?.footer} />
    </div>
  );
}

/** A coordinator's Overview: its own sections and what its page held, read only while the panel shows it. */
export function CoordinatorOverview({ coordinator, ...props }: Omit<ThreadOverviewProps, "extra" | "coordinating"> & { coordinator: CoordinatorSectionsProps }) {
  const extra = useCoordinatorSections(coordinator);
  return <ThreadOverview {...props} coordinating extra={extra} />;
}

function Row({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="overview-row">
      <dt className="shrink-0 text-muted-foreground">{name}</dt>
      <dd className="flex min-w-0 items-center justify-end gap-1.5 text-right">{children}</dd>
    </div>
  );
}

function thisSection({ project, readOnly, onChanged, session, thread, pane, pr, reading, parent, coordinating, now = Date.now() }: ThreadOverviewProps): PanelSection {
  const state: NodeState = thread ? nodeState(thread) : (pane && coordinatorState(pane.status)) ?? "idle";
  const age = thread && threadAge(thread, now);
  const agent = thread?.agent ?? pane?.agent;
  const agentName = agent && agentLabel(agent);
  const model = reading.model && modelDisplayName(reading.model);
  const percent = reading.contextPercent;
  return {
    id: "this",
    label: coordinating ? "This coordinator" : "This thread",
    // Folded, it still says how it is; open, its Status row does.
    brief: <span className="panel-section-meta"><NodeDot state={state} />{STATE_LABEL[state]}</span>,
    body: <dl className="overview-body">
      <Row name="Status"><NodeDot state={state} />{STATE_LABEL[state]}{age && <span className="text-muted-foreground">· {age}</span>}</Row>
      {/* Its mark, picked here as on the project's list; the project's coordinator draws the project's. */}
      {coordinating && <Row name="Icon">
        <MarkTile project={project} id={thread?.id ?? "root"} name={thread?.title ?? project.name} size={26} session={session} editable={!readOnly && thread !== undefined} onChanged={onChanged} />
      </Row>}
      {parent && <Row name="Coordinator">
        <button type="button" onClick={parent.open} className="overview-link">
          <CoordinatorGlyph project={project} id={parent.id} size={14} />
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
    </dl>,
  };
}

function prName(pr: SessionPr): string {
  const name = pr.number !== undefined ? `#${pr.number}` : "Open";
  return pr.state && pr.state !== "open" ? `${name} · ${pr.state}` : name;
}

/** What the branch changed against where it started: the total and the first files, the diff a tap away. */
function useChangesSection(paneId: string, session: string | undefined, stamp: string, onShow: () => void): PanelSection {
  const latest = useDiffRead(`${paneId}\0${session ?? ""}\0${stamp}`, true, (signal) => fetchSessionDiff(paneId, "branch", session, signal));
  // A read again keeps the last one on screen until it lands, so the section does not blink on every turn.
  const settled = useRef<DiffRead>(latest);
  if (latest.state !== "loading") settled.current = latest;
  const read = settled.current;
  const diff = read.state === "read" && read.diff.ok ? read.diff : undefined;
  const files = diff?.files ?? [];
  const rest = (diff?.totals.files ?? 0) - Math.min(files.length, FILES_SHOWN);
  const failure = read.state === "failed" ? read.message : read.state === "read" && !read.diff.ok ? read.diff.message : undefined;
  return {
    id: "changes",
    label: "Changes",
    badge: diff && diff.totals.files > 0 && <DiffStat diff={diff.totals} className="text-xs" />,
    action: <button type="button" onClick={onShow} aria-label="Open the Changes tab" className="overview-link text-xs text-muted-foreground">
      Open<ChevronRight aria-hidden className="size-3.5" />
    </button>,
    body: <div className="overview-body">
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
    </div>,
  };
}

/** A thread's: the coordinator it belongs to and its other open threads, this one marked. */
function siblingsSection({ thread, threads, parent, paneId, onOpenThread, now = Date.now() }: ThreadOverviewProps): PanelSection[] {
  const open = threads.filter(isOpenThread);
  if (open.length === 0 || !parent) return [];
  return [{
    id: "coordinator",
    label: `Coordinator ${parent.title}`,
    action: <button type="button" onClick={parent.open} className="overview-link text-xs text-muted-foreground">
      Open<ChevronRight aria-hidden className="size-3.5" />
    </button>,
    body: <ul className="overview-threads">
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
    </ul>,
  }];
}

/** threadDetail's words that only restate a row's mark. */
const PLAIN_DETAIL = new Set(["working", "idle", "not running", "done", "unknown", "needs you"]);

/** What is alive in a coordinator's work, in words, most urgent first: `1 needs you · 2 working`. */
const LIVE_STATES = ["needs", "review", "working"] as const;
const LIVE_WORD: Record<(typeof LIVE_STATES)[number], (n: number) => string> = { needs: needYou, review: (n) => `${n} to review`, working: (n) => `${n} working` };

/**
 * A coordinator's: the open work under it as the tree orders it, each coordinator under it with its
 * own and then its own threads, every row its state, what it is doing and a tap to open it. What
 * finished is a link to History.
 */
function threadsSection({ project, threads, panes = [], paneId, onOpenThread, onNewThread, finished, now = Date.now() }: ThreadOverviewProps): PanelSection {
  const groups = workUnder(threads);
  const open = groups.flatMap((group) => [...(group.coordinator ? [group.coordinator] : []), ...group.rows.map(({ node }) => node)]);
  const live = LIVE_STATES.map((state) => [state, open.filter((node) => node.state === state).length] as const).filter(([, n]) => n > 0);
  const row = (node: OrgNode, depth: number, coordinator = false) => {
    const { thread } = node;
    const current = thread.paneId === paneId;
    // Its mark already says it works, rests or runs nowhere: the line is only for what it says beyond that.
    const said = threadDetail(thread, panes);
    const detail = coordinator ? `Coordinator · ${node.children.length} open` : PLAIN_DETAIL.has(said.toLowerCase()) ? "" : said;
    return <li key={thread.id} aria-current={current ? "true" : undefined}>
      <button type="button" onClick={() => onOpenThread(thread)} className="overview-work" data-coordinator={coordinator || undefined}
        style={depth ? { paddingInlineStart: `${14 + depth * 16}px` } : undefined}>
        {/* A coordinator leads with its own mark (ADR 0122), its state after its name. */}
        <span className="flex h-5 shrink-0 items-center">{coordinator ? <CoordinatorGlyph project={project} id={thread.id} size={14} /> : <NodeDot state={node.state} />}</span>
        <span className="min-w-0 flex-1 text-left">
          <span className="block truncate">{thread.title}</span>
          {detail && <span className="block truncate text-xs text-muted-foreground">{detail}</span>}
        </span>
        {coordinator && node.state !== "idle" && <span className="flex h-5 shrink-0 items-center"><NodeDot state={node.state} /></span>}
        <span className="shrink-0 text-xs text-muted-foreground">{threadAge(thread, now) ?? ""}</span>
      </button>
    </li>;
  };
  return {
    id: "threads",
    label: "Threads",
    badge: <span className="panel-section-meta">
      {live.length ? live.map(([state, n]) => LIVE_WORD[state](n)).join(" · ") : open.length ? `${open.length} open` : ""}
    </span>,
    action: onNewThread && <button type="button" onClick={onNewThread} aria-haspopup="dialog" className="overview-link text-xs text-muted-foreground">
      <Plus aria-hidden className="size-3.5" />New thread
    </button>,
    body: <div className="pb-2">
      {open.length === 0 && <div className="overview-body pb-0"><p className="overview-note">Nothing running</p></div>}
      {groups.map((group) => <ul key={group.coordinator?.thread.id ?? "own"} className="overview-threads overview-group"
        aria-label={group.coordinator ? `${group.coordinator.thread.title} threads` : "Its own threads"}>
        {group.coordinator && row(group.coordinator, 0, true)}
        {group.rows.map(({ node, depth }) => row(node, depth + (group.coordinator ? 1 : 0), node.thread.role === "coordinator"))}
      </ul>)}
      {finished && finished.count > 0 && <button type="button" onClick={finished.open} className="overview-note overview-more mx-3.5 inline-flex items-center gap-1">
        <History aria-hidden className="size-3.5" />{finished.count} finished<ChevronRight aria-hidden className="size-3.5" />
      </button>}
    </div>,
  };
}
