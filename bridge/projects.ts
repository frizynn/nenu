import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";

import {
  OrgValidationError, SLUG_RE, WAITING_ACTIVITY, defaultOrgRun, offers, pickName, readOverview, readProjectDetail, readStatus, readTasks, upstreamOnly, validateProjectSlug,
  type OrgCoordinator, type OrgOverviewProject, type OrgOverviewThread, type OrgProjectDetail, type OrgRun, type OrgStatus, type OrgTask,
} from "./org-cli.ts";
import type { CoordinatorMarks, MarkPick } from "./coordinator-marks.ts";
import { askGroup, decisionGroup, readAsks, type OrgAskRow, type OrgDecisionRow } from "./org-asks.ts";
import type { ThreadReportSource } from "./org-library.ts";
import type { OrgStatusFile } from "./org-report.ts";
import type { AskDecision, AsksList, StatusFile, TokenUsage } from "./org-types.ts";
import { PR_ASKS, type AgentView, type LivePublisher, type PrAction, type ProjectThreadView, type ProjectView, type ThreadPullRequest, type ThreadSummary, type WorkspaceView } from "./types.ts";

/** How often a snapshot read re-stats the registry when no watcher fired (the watcher's safety net). */
const STAT_MS = 2_000;
/** The fewest milliseconds between two `overview --json` spawns; a forced refresh skips it. */
const MIN_REFRESH_MS = 5_000;
/** The longest wait before a read of Organizations that failed is tried again; it doubles up to this from MIN_REFRESH_MS. */
const RETRY_MAX_MS = 60_000;
const WATCH_DEBOUNCE_MS = 250;
/** How long an Organizations without a command (`node move`, `asks answer`) is believed before it is asked again: an upgrade adds it. */
const PROBE_MS = 10 * 60_000;
/** The commands Nenu offers only where Organizations has them. */
const PROBED = { move: ["node", "move"], answer: ["asks", "answer"] } as const;
type Probed = keyof typeof PROBED;
interface Probe { value: boolean; at: number; asking?: Promise<boolean> }
const MAX_PROJECTS = 100;
const MAX_THREADS = 500;
const MAX_METADATA_BYTES = 64 * 1024;
const SLUG_DIR_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const THREAD_FILE_RE = /^t-\d{4,}\.toml$/;
const THREAD_ID_RE = /^t-\d{4,}$/;
/** The `.state/` files whose change can change what `overview --json` prints. Stat only, never read here. */
const STATE_FILES = ["project.json", "coordinator.json", "ticker.json", "usage.json"];

type JsonObject = Record<string, unknown>;
type TomlObject = Record<string, unknown>;

/** A pull request as Organizations reported it. The extra fields exist only with `--json`. */
export interface OrgPullRequest extends ThreadPullRequest {
  /** Why `thread merge` would refuse, as of the ticker's last read; `null` when it would merge. */
  mergeBlocker?: string | null;
  commentCount?: number;
  mergeable?: string;
}

export interface OrgThreadView extends ProjectThreadView {
  /** 1 for a direct child of the project, computed from `parentId`. */
  depth: number;
  /** A report the person has not acknowledged yet. */
  reportUnacked: boolean;
  groupLabel?: string;
  /** Organizations' bracketed note: live agent state, `pane closed`, `failed: …`. `--json` only. */
  note?: string;
  /** The PR automation flags. Present only when Organizations has PR actions. */
  autoFixCi?: boolean;
  autoMerge?: boolean;
  pr?: OrgPullRequest;
}

export interface OrgProjectView extends ProjectView {
  /** `json` when this came from `overview --json`; `files` is the fallback, which carries no numbers. */
  source: "json" | "files";
  /** Organizations can merge and toggle auto-fix/auto-merge (its `thread merge`/`thread set`). */
  prActions: boolean;
  /** Organizations can start coordinators and nest nodes (`node start`); upstream herdr-projects cannot. */
  nodeActions: boolean;
  /** Organizations can hang a node under another parent (`node move`). */
  nodeMoves: boolean;
  /** Workspaces holding a live pane bound to this project, in this session. */
  workspaceIds: string[];
  threads: OrgThreadView[];
}

export interface ProjectRegistryOptions {
  root?: string;
  now?: () => number;
  /** The CLI runner; `null` reads the files only. */
  run?: OrgRun | null;
  /** Where the `org` invalidation goes. */
  live?: LivePublisher;
  /** Watch the registry with fs.watch. Tests turn it off and call {@link ProjectRegistry.refresh}. */
  watch?: boolean;
  /** Whether only upstream herdr-projects is installed; read on every refresh. */
  upstream?: () => boolean;
  /** The operator's picked coordinator marks (ADR 0122); without it no project carries `marks`. */
  marks?: CoordinatorMarks;
}

function contained(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Metadata reads never follow symlinks, block on devices, or read after an unbounded growth race. */
function boundedText(path: string, allowedRoot: string): string | undefined {
  if (!contained(normalize(path), normalize(allowedRoot))) return undefined;
  let fd: number | undefined;
  try {
    const real = realpathSync(path);
    if (!contained(real, realpathSync(allowedRoot))) return undefined;
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_METADATA_BYTES) return undefined;
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    return bytes.subarray(0, offset).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function json(path: string, root: string): JsonObject {
  const text = boundedText(path, root);
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
  } catch {
    return {};
  }
}

function toml(text: string): TomlObject {
  try {
    const value: unknown = Bun.TOML.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as TomlObject : {};
  } catch {
    return {};
  }
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function humanize(slug: string): string {
  return slug.split(/[-_]/).filter(Boolean).map((word) => word[0]?.toUpperCase() + word.slice(1)).join(" ");
}

/** A project's picked icon and tone, each only when it picked one. */
type Picks = Pick<ProjectView, "icon" | "tone">;
const picks = (icon?: string, tone?: string): Picks => ({ ...(icon ? { icon } : {}), ...(tone ? { tone } : {}) });

function projectSettings(path: string, root: string, slug: string): ({ name: string; goal?: string; roots: string[] } & Picks) | undefined {
  const text = boundedText(path, root)?.replaceAll("\r\n", "\n");
  if (!text?.startsWith("+++\n")) return undefined;
  const end = text.indexOf("\n+++", 4);
  if (end < 0) return undefined;
  const front = toml(text.slice(4, end));
  const repos = Array.isArray(front.repos) ? front.repos : [];
  const roots = repos.flatMap((repo) => {
    if (!repo || typeof repo !== "object" || Array.isArray(repo)) return [];
    const path = string((repo as TomlObject).path);
    return path && isAbsolute(path) ? [normalize(path)] : [];
  });
  const rawName = string(front.name).trim();
  const name = rawName || humanize(slug);
  const goal = string(front.goal).trim();
  return { name, ...(goal ? { goal } : {}), roots, ...picks(pickName(front.icon), pickName(front.tone)) };
}

function within(path: string, root: string): boolean {
  if (!path || !root || !isAbsolute(path) || !isAbsolute(root)) return false;
  const rel = relative(normalize(root), normalize(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

interface Binding {
  paneId: string;
  workspaceId: string;
  tabId: string;
  cwd: string;
}

function livePane(binding: Binding, panes: readonly AgentView[], roots: readonly string[]): AgentView | undefined {
  if (!binding.paneId || !binding.workspaceId || !binding.tabId) return undefined;
  return panes.find((pane) =>
    pane.paneId === binding.paneId &&
    pane.workspaceId === binding.workspaceId &&
    pane.tabId === binding.tabId &&
    ((binding.cwd && within(pane.cwd, binding.cwd)) || roots.some((root) => within(pane.cwd, root)))
  );
}

function resolveRoot(): string {
  const fromEnv = process.env.HERDR_PROJECTS_ROOT?.trim();
  if (fromEnv) return resolve(fromEnv.replace(/^~(?=\/|$)/, homedir()));
  const configDir = join(homedir(), ".config", "herdr-projects");
  const config = boundedText(join(configDir, "config.toml"), configDir);
  if (config) {
    const root = string(toml(config).root).trim();
    if (root) return resolve(root.replace(/^~(?=\/|$)/, homedir()));
  }
  return join(homedir(), ".herdr-projects");
}

function binding(record: TomlObject | JsonObject | OrgOverviewThread): Binding {
  return {
    paneId: string(record.pane_id),
    workspaceId: string(record.workspace_id),
    tabId: string(record.tab_id),
    cwd: string(record.cwd),
  };
}

const STATUSES = ["starting", "open", "failed", "resolved"] as const;
const REVIEWS: Record<string, OrgPullRequest["review"]> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  REVIEW_REQUIRED: "review_required",
};

/**
 * The thread's PR from Organizations' own fields. Before the ticker's first read the state is
 * empty: an open thread's PR is then shown as open with nothing else, and a resolved thread's
 * unread PR is left out rather than labelled with a state nobody observed.
 */
function pullRequest(
  url: string,
  rawState: string,
  rawReview: string,
  threadStatus: ProjectThreadView["status"],
  extra: Partial<OrgPullRequest> & { draft?: boolean } = {},
): OrgPullRequest | undefined {
  if (!/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/.test(url)) return undefined;
  if (!rawState && threadStatus === "resolved") return undefined;
  const { draft, ...rest } = extra;
  const state = rawState === "MERGED" ? "merged" : rawState === "CLOSED" ? "closed" : draft ? "draft" : "open";
  const review = REVIEWS[rawReview];
  return { url, number: Number(url.slice(url.lastIndexOf("/") + 1)), state, ...(review ? { review } : {}), ...rest };
}

function tomlThread(record: TomlObject): OrgThreadView | undefined {
  const id = string(record.id);
  if (!THREAD_ID_RE.test(id)) return undefined;
  const status = STATUSES.find((candidate) => candidate === string(record.status)) ?? "open";
  const reportHash = string(record.report_hash);
  const group = status === "resolved" ? "resolved" : string(record.last_group);
  const branch = string(record.branch);
  const pr = pullRequest(string(record.pr), string(record.pr_state), string(record.pr_review), status);
  return {
    id,
    title: string(record.title).trim() || id,
    parentId: string(record.parent_id) || "root",
    role: string(record.role) === "coordinator" ? "coordinator" : "worker",
    status,
    ...(typeof record.template === "string" ? { template: record.template } : {}),
    updated: string(record.updated) || undefined,
    depth: 1,
    reportUnacked: reportHash !== "" && reportHash !== string(record.acked_report_hash),
    ...(group ? { group } : {}),
    ...(string(record.activity) === WAITING_ACTIVITY ? { selfWaiting: true } : {}),
    ...(record.keep_open === true ? { conversation: true } : {}),
    ...(branch ? { branch } : {}),
    ...(pr ? { pr } : {}),
  };
}

/** The actions Nenu has a button for: about a PR, and about a thread without one. */
const PR_ACTIONS: readonly PrAction[] = ["merge", ...PR_ASKS];
const THREAD_ACTIONS: readonly PrAction[] = ["create-pr"];

/**
 * The first action of `actions` Nenu knows. Organizations lists them most pressing first, Merge
 * leading whenever it would merge, so Nenu never reorders them; a value from a newer one is skipped.
 */
function firstAction(actions: string[] | undefined, known: readonly PrAction[]): PrAction | undefined {
  return actions?.map((action) => known.find((name) => name === action)).find((action) => action !== undefined);
}

function jsonThread(record: OrgOverviewThread, prActions: boolean): OrgThreadView {
  const status = STATUSES.find((candidate) => candidate === record.status) ?? "open";
  const raw = record.pr;
  const pr = raw && pullRequest(raw.url, raw.state, raw.review, status, {
    draft: raw.draft === true,
    ...(raw.checks ? { checks: { ...raw.checks, failing: raw.failing } } : {}),
    // Organizations' popup draws no diff of zero lines: a summary its ticker stored before it counted
    // lines reads back as 0/0 (measured 2026-10-13), and a real one says nothing worth a column.
    ...(raw.additions !== null && raw.deletions !== null && raw.additions + raw.deletions > 0 ? { diff: { additions: raw.additions, deletions: raw.deletions } } : {}),
    ...(raw.comment_count !== null ? { commentCount: raw.comment_count } : {}),
    ...(raw.mergeable ? { mergeable: raw.mergeable } : {}),
    mergeBlocker: raw.merge_blocker,
  });
  const prAction = raw ? pr && firstAction(raw.actions, PR_ACTIONS) : firstAction(record.actions, THREAD_ACTIONS);
  return {
    id: record.id,
    title: record.title.trim() || record.id,
    parentId: record.parent_id || "root",
    role: record.role,
    status,
    updated: record.updated || undefined,
    depth: 1,
    reportUnacked: record.report_unacked,
    ...(record.group ? { group: record.group, groupLabel: record.group_label } : {}),
    ...(record.note ? { note: record.note } : {}),
    ...(record.activity === WAITING_ACTIVITY ? { selfWaiting: true } : {}),
    ...(record.keep_open ? { conversation: true } : {}),
    ...(record.branch ? { branch: record.branch } : {}),
    ...(prActions ? { autoFixCi: record.auto_fix_ci === true, autoMerge: record.auto_merge === true } : {}),
    ...(pr ? { pr } : {}),
    ...(prAction ? { prAction } : {}),
    ...(record.actions?.includes("move") ? { movable: true as const } : {}),
    ...(record.verdict ? { verdict: record.verdict } : {}),
    ...(record.status_file ? { statusUpdated: record.status_file.updated } : {}),
    ...(record.usage ? { usageStamp: usageStamp(record.usage) } : {}),
  };
}

/** What the thread's report says and shows, and its token use, or undefined when it has none of it. */
function threadSummary(record: OrgOverviewThread): ThreadSummary | undefined {
  const { summary, plain_summary: plain, captures, deliverables, status_file: status, usage } = record;
  const explainable = record.actions?.includes("explain") === true;
  if (!summary && !plain && !explainable && !captures.length && !deliverables.length && !status && !usage) return undefined;
  return {
    id: record.id, ...(summary ? { summary } : {}), ...(plain ? { plain } : {}), ...(explainable ? { explainable: true as const } : {}),
    captures, deliverables, ...(status ? { status: statusText(status) } : {}), ...(usage ? { usage } : {}),
  };
}

/** What a client is given of a STATUS.md: what it says and when it changed, never where it lives. */
const statusText = ({ text, updated, objective, needsDecision }: OrgStatusFile): StatusFile =>
  ({ text, updated, ...(objective ? { objective } : {}), ...(needsDecision ? { needsDecision } : {}) });

/** What changes whenever a token reading does: when its last request was, and the caps it passed. */
const usageStamp = (usage: TokenUsage) => `${usage.updated}|${usage.overCap.join(",")}`;

/**
 * At most MAX_THREADS of a project's threads, in Organizations' order: every open one, then the
 * newest resolved. Cutting in id order would drop the newest, which are the ones still running.
 */
export function keptThreads<T extends { id: string; status: string }>(threads: readonly T[]): T[] {
  if (threads.length <= MAX_THREADS) return [...threads];
  const newestFirst = threads.map((thread, index) => ({ thread, index }))
    .sort((a, b) => Number(a.thread.status === "resolved") - Number(b.thread.status === "resolved") || threadNumber(b.thread.id) - threadNumber(a.thread.id));
  const kept = new Set(newestFirst.slice(0, MAX_THREADS).map(({ index }) => index));
  return threads.filter((_, index) => kept.has(index));
}

/** `t-0042` → 42; an id outside the grammar sorts as the oldest. */
const threadNumber = (id: string) => Number(/^t-(\d+)$/.exec(id)?.[1] ?? -1);

/** Depth from the parent chain; an unknown parent or a cycle stops at the project root. */
function withDepth(threads: Array<{ view: OrgThreadView; binding: Binding }>): void {
  const parents = new Map(threads.map(({ view }) => [view.id, view.parentId]));
  for (const { view } of threads) {
    let depth = 1;
    let parent = view.parentId;
    while (parent !== "root" && parents.has(parent) && depth <= threads.length) {
      depth++;
      parent = parents.get(parent)!;
    }
    view.depth = depth;
  }
}

/** Workspaces of this session that no project holds a live pane in: the loose ones. */
export function looseWorkspaceIds(workspaces: readonly WorkspaceView[], projects: readonly OrgProjectView[]): string[] {
  const held = new Set(projects.flatMap((project) => project.workspaceIds));
  return workspaces.map((workspace) => workspace.workspaceId).filter((id) => !held.has(id));
}

interface FileProject extends Picks {
  slug: string;
  name: string;
  goal?: string;
  status: "active" | "paused";
  session: string;
  roots: string[];
  /** The repositories PROJECT.md names, in its order: the code the project works on. */
  repos: string[];
  coordinator: Binding;
  /** `summary` stays out of the snapshot: up to 600 characters, 34 paths and a STATUS.md a thread, read only by the page that shows them. */
  threads: Array<{ view: OrgThreadView; binding: Binding; summary?: ThreadSummary; report?: string }>;
}

/** What the last `asks --json` read: every coordinator's asks, and its decision rows where Organizations prints them. */
interface AsksRead { asks: OrgAskRow[]; decisions?: OrgDecisionRow[] }

interface ProjectRecord extends FileProject {
  source: "json" | "files";
  prActions: boolean;
  /** The project coordinator's STATUS.md, and where every STATUS.md in the project lives; `--json` only. */
  statusFile?: OrgStatusFile;
  statusPaths?: string[];
  /** The project coordinator's token use and how it was started, when Organizations prints them. */
  usage?: TokenUsage;
  coordinatorAgent?: OrgCoordinator;
  /** Asks and decisions waiting on the person; absent when this Organizations cannot list asks. */
  waitingAsks?: number;
  /** Where Organizations keeps its reports and library (`recordsFolder`); `--json` only. */
  recordsDir?: string;
  /** Every resolved coordinator, past MAX_THREADS too, so its asks stop waiting; `--json` only. */
  resolvedCoordinators?: string[];
}

export class ProjectRegistry {
  private readonly root: string;
  private readonly now: () => number;
  private readonly run: OrgRun | null;
  private readonly live?: LivePublisher;
  private readonly marks?: CoordinatorMarks;
  private readonly watchEnabled: boolean;
  private readonly upstream: () => boolean;
  private records: ProjectRecord[] = [];
  /** Every coordinator's asks as the last refresh read them; undefined when this Organizations has none to give. */
  private askRead: AsksRead | undefined;
  private nodeActions = true;
  private nodeMoves = false;
  private askAnswers = false;
  /** What each probed command's help last said, when it was asked, and the question in flight. */
  private probes: Record<Probed, Probe> = { move: { value: false, at: -Infinity }, answer: { value: false, at: -Infinity } };
  private loaded = false;
  private stamp = "";
  private nextStat = 0;
  private lastRefresh = -Infinity;
  /** Reads of Organizations that failed in a row, and when the next one is due though no file changed. */
  private failures = 0;
  private retryAt = Infinity;
  private inFlight: Promise<void> | undefined;
  /** A refresh asked for while one ran; `force` if any of those asks skipped the throttle. */
  private again: { force: boolean } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private readonly sessions = new Set<string>();
  /** Writes the person waits on, running now (`urgently`). */
  private urgent = 0;
  private watchers = new Map<string, FSWatcher>();
  private closed = false;

  constructor(options: ProjectRegistryOptions = {}) {
    const candidate = options.root ?? resolveRoot();
    try {
      this.root = realpathSync(candidate);
    } catch {
      this.root = resolve(candidate);
    }
    this.now = options.now ?? Date.now;
    this.run = options.run === undefined ? defaultOrgRun() : options.run;
    this.live = options.live;
    this.marks = options.marks;
    this.watchEnabled = options.watch ?? true;
    this.upstream = options.upstream ?? upstreamOnly;
  }

  list(sessionName: string, isPrimary: boolean, panes: readonly AgentView[]): OrgProjectView[] {
    this.sessions.add(sessionName);
    this.read();
    return this.records
      .filter((record) => record.session ? record.session === sessionName : isPrimary)
      .map((record) => {
        const coordinatorPane = livePane(record.coordinator, panes, record.roots);
        const marks = this.marks?.of(record.slug) ?? {};
        const workspaceIds = new Set<string>(coordinatorPane ? [coordinatorPane.workspaceId] : []);
        const threads = record.threads.map(({ view, binding }) => {
          const pane = livePane(binding, panes, record.roots);
          if (!pane) return view;
          workspaceIds.add(pane.workspaceId);
          return { ...view, paneId: pane.paneId, agent: pane.agent, liveStatus: pane.status };
        });
        return {
          slug: record.slug,
          name: record.name,
          ...(record.goal ? { goal: record.goal } : {}),
          status: record.status,
          ...picks(record.icon, record.tone),
          ...(Object.keys(marks).length > 0 ? { marks } : {}),
          ...(record.statusFile ? { statusUpdated: record.statusFile.updated } : {}),
          ...(record.waitingAsks !== undefined ? { waitingAsks: record.waitingAsks } : {}),
          ...(record.usage ? { usageStamp: usageStamp(record.usage) } : {}),
          coordinator: coordinatorPane ? {
            paneId: coordinatorPane.paneId,
            agent: coordinatorPane.agent,
            liveStatus: coordinatorPane.status,
          } : undefined,
          threads,
          source: record.source,
          prActions: record.prActions,
          nodeActions: this.nodeActions,
          nodeMoves: this.nodeMoves,
          workspaceIds: [...workspaceIds],
        };
      });
  }

  /**
   * Keeps the operator's pick of a coordinator's mark and tells every session's browsers, as a change
   * Organizations wrote would. Only a coordinator the project lists can be picked for.
   */
  async setMark(slug: string, id: string, pick: Record<string, unknown>): Promise<MarkPick | undefined> {
    if (!this.marks) throw new OrgValidationError("This Nenu keeps no coordinator marks.");
    this.read();
    const record = this.records.find((candidate) => candidate.slug === slug);
    if (!record?.threads.some(({ view }) => view.id === id && view.role === "coordinator")) throw new OrgValidationError("Name a coordinator this project lists.");
    const kept = await this.marks.set(slug, id, pick);
    for (const session of this.sessions) this.live?.publish({ session, topic: "org" });
    return kept;
  }

  /**
   * The repositories PROJECT.md names for the project whose coordinator or thread is pane `paneId`,
   * bound as `list` binds them; empty for a pane no project holds.
   */
  repos(sessionName: string, isPrimary: boolean, panes: readonly AgentView[], paneId: string): string[] {
    const project = this.list(sessionName, isPrimary, panes)
      .find((candidate) => candidate.coordinator?.paneId === paneId || candidate.threads.some((thread) => thread.paneId === paneId));
    return project ? this.records.find((record) => record.slug === project.slug)?.repos ?? [] : [];
  }

  /** The records as last read: the first read paints from the files at once, and the `--json` view follows as an `org` event. */
  private read(): void {
    if (!this.loaded) {
      this.loaded = true;
      this.stamp = this.fingerprint();
      this.nextStat = this.now() + STAT_MS;
      this.records = this.readFiles().map((project) => ({ ...project, source: "files", prActions: false }));
      this.nodeActions = !this.upstream();
      this.rewatch();
      this.schedule(false);
    } else if (this.now() >= this.nextStat) {
      this.check();
    }
  }

  /**
   * What each thread's report says and shows, for the threads whose report says any of it. Null
   * when Organizations is read from its files, which carry none of it, or the project is not listed.
   */
  summaries(project: string): { threads: ThreadSummary[]; status: StatusFile | null; usage: TokenUsage | null; coordinator: OrgCoordinator | null } | null {
    const slug = validateProjectSlug(project);
    this.read();
    const record = this.records.find((candidate) => candidate.slug === slug);
    if (!record || record.source !== "json") return null;
    return {
      threads: record.threads.flatMap(({ summary }) => summary ? [summary] : []),
      status: record.statusFile ? statusText(record.statusFile) : null,
      usage: record.usage ?? null,
      coordinator: record.coordinatorAgent ?? null,
    };
  }

  /**
   * Every listed project's asks, each placed as Organizations orders it, and the decisions of the
   * coordinators that still take an answer, from the last refresh: no spawn. Null when this
   * Organizations cannot list asks.
   */
  asks(): AsksList | null {
    this.read();
    if (!this.askRead) return null;
    const records = new Map(this.records.map((record) => [record.slug, record]));
    return {
      asks: this.askRead.asks.flatMap((row) => {
        const record = records.get(row.project);
        return record ? [{ ...row, group: askGroup(row, resolvedCoordinator(record, row.coordinator.id)) }] : [];
      }),
      decisions: this.records.flatMap((record) => openDecisions(record, this.askRead!)),
      answers: this.askAnswers,
    };
  }

  /** The folder Organizations copies each thread's files into, for a project this registry lists; undefined otherwise. */
  library(project: string): string | undefined {
    if (!SLUG_RE.test(project)) return undefined;
    this.read();
    const record = this.records.find((candidate) => candidate.slug === project);
    return record && join(record.recordsDir ?? join(this.root, project), "library");
  }

  /**
   * Where thread `id`'s report is and the records folder it must sit in, with what the overview read
   * of it, for a project this registry lists from `--json`; undefined otherwise. The client names the
   * thread, never the path.
   */
  report(project: string, id: string): ThreadReportSource | undefined {
    if (!SLUG_RE.test(project) || !THREAD_ID_RE.test(id)) return undefined;
    this.read();
    const record = this.records.find((candidate) => candidate.slug === project);
    const thread = record?.threads.find(({ view }) => view.id === id);
    if (!record?.recordsDir || !thread?.report) return undefined;
    return { path: thread.report, records: record.recordsDir, title: thread.view.title, summary: thread.summary, ...(thread.view.verdict ? { verdict: thread.view.verdict } : {}) };
  }

  /**
   * Why closing node `id` would be refused: a coordinator still running open nodes, as last read.
   * Undefined when it may close, or when the registry does not know it (Organizations decides then).
   */
  closeRefusal(slug: string, id: string): string | undefined {
    const threads = this.records.find((record) => record.slug === slug)?.threads.map(({ view }) => view) ?? [];
    const node = threads.find((thread) => thread.id === id);
    const open = threads.filter((thread) => thread.parentId === id && thread.status !== "resolved").length;
    return node && open ? `${node.title} still has ${open} open under it; close those first.` : undefined;
  }

  /** A project's task list from this registry's root; null when Organizations has none to give. */
  async tasks(project: string): Promise<OrgTask[] | null> {
    const slug = validateProjectSlug(project);
    return this.run ? readTasks(this.run, this.root, slug) : null;
  }

  /** A project's status for Notes; null when this Organizations has no `project status`, thrown when it failed. */
  async status(project: string): Promise<OrgStatus | null> {
    const slug = validateProjectSlug(project);
    return this.run ? readStatus(this.run, this.root, slug) : null;
  }

  /** What a project's threads receive, null when Organizations has none to give. Its routines are `/api/org/routines`'s. */
  async context(project: string): Promise<{ detail: OrgProjectDetail | null }> {
    const slug = validateProjectSlug(project);
    return { detail: this.run ? await readProjectDetail(this.run, this.root, slug) : null };
  }

  /** Re-read now, ignoring the spawn throttle: after a write the person is waiting for the result. */
  invalidate(): Promise<void> {
    return this.schedule(true);
  }

  /**
   * Run `write`, which the person waits on. Meanwhile a change the watcher sees is read at once
   * instead of after the spawn throttle: `open` records the coordinator's pane within half a second
   * and returns only once its agent is ready, seconds later, and the page opens the chat on the record.
   */
  async urgently<T>(write: () => Promise<T>): Promise<T> {
    this.urgent++;
    try {
      return await write();
    } finally {
      this.urgent--;
    }
  }

  /** Re-read the files and `overview --json`, and announce `org` if anything visible changed. */
  async refresh(): Promise<void> {
    this.lastRefresh = this.now();
    this.stamp = this.fingerprint();
    const files = this.readFiles();
    // A failed read keeps what the last good one showed (an Organizations without the documents has
    // none of them), and is tried again on a later read though no file changed: a restart whose first
    // read timed out would otherwise serve no asks until something in the registry moved.
    let failed = false;
    const fail = <T>(kept: T) => () => { failed = true; return kept; };
    const [overview, asks, nodeMoves, askAnswers] = this.run
      ? await Promise.all([
        readOverview(this.run, this.root).catch(fail(undefined)),
        readAsks(this.run, this.root).then((read) => read ?? undefined, fail(this.askRead)),
        this.has(this.run, "move"),
        this.has(this.run, "answer"),
      ])
      : [undefined, undefined, false, false];
    const keep = failed && !overview && this.records.some((record) => record.source === "json");
    const askRead = overview || keep ? asks : undefined;
    const next = overview ? this.fromJson(overview, files, askRead)
      : keep ? this.records
      : files.map((project) => ({ ...project, source: "files" as const, prActions: false }));
    this.failures = failed ? this.failures + 1 : 0;
    this.retryAt = failed ? this.now() + Math.min(RETRY_MAX_MS, MIN_REFRESH_MS * 2 ** (this.failures - 1)) : Infinity;
    const nodeActions = !this.upstream();
    const changed = nodeActions !== this.nodeActions || nodeMoves !== this.nodeMoves || askAnswers !== this.askAnswers || JSON.stringify(next) !== JSON.stringify(this.records) || JSON.stringify(askRead) !== JSON.stringify(this.askRead);
    this.records = next;
    this.askRead = askRead;
    this.nodeActions = nodeActions;
    this.nodeMoves = nodeMoves;
    this.askAnswers = askAnswers;
    this.loaded = true;
    this.rewatch();
    if (changed) for (const session of this.sessions) this.live?.publish({ session, topic: "org" });
  }

  /**
   * A probed command's help, asked once, and again only while it said no and a while has passed. Two
   * refreshes at once share one question, so neither reads the other's stale answer.
   */
  private has(run: OrgRun, command: Probed): Promise<boolean> {
    const probe = this.probes[command];
    if (this.upstream()) return Promise.resolve(false);
    if (probe.asking) return probe.asking;
    if (probe.value || this.now() - probe.at < PROBE_MS) return Promise.resolve(probe.value);
    probe.at = this.now();
    probe.asking = offers(run, PROBED[command]).then((value) => {
      probe.value = value;
      probe.asking = undefined;
      return value;
    });
    return probe.asking;
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.debounce);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  private check(): void {
    this.nextStat = this.now() + STAT_MS;
    if (this.fingerprint() !== this.stamp || this.now() >= this.retryAt) void this.schedule(this.urgent > 0);
  }

  /**
   * One refresh at a time; a request during one runs once more after it, and its promise settles
   * with that rerun, so a caller awaiting it sees a read that began after its own change.
   */
  private schedule(force: boolean): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.inFlight) {
      this.again = { force: force || this.again?.force === true };
      // The running refresh's `finally` starts the rerun before this continuation runs.
      return this.inFlight.then(() => this.inFlight);
    }
    const wait = force ? 0 : Math.max(0, this.lastRefresh + MIN_REFRESH_MS - this.now());
    if (wait > 0) {
      this.timer ??= setTimeout(() => {
        this.timer = undefined;
        void this.schedule(true);
      }, wait);
      return Promise.resolve();
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    this.inFlight = this.refresh().finally(() => {
      this.inFlight = undefined;
      const again = this.again;
      this.again = undefined;
      if (again) void this.schedule(again.force);
    });
    return this.inFlight;
  }

  /** Watch the root, each project folder and its `threads/` and `.state/`; any event re-stats. */
  private rewatch(): void {
    if (!this.watchEnabled || this.closed) return;
    const wanted = new Set([this.root]);
    for (const slug of this.slugs()) {
      const dir = join(this.root, slug);
      wanted.add(dir).add(join(dir, "threads")).add(join(dir, ".state"));
    }
    for (const [path, watcher] of this.watchers) {
      if (!wanted.has(path)) {
        watcher.close();
        this.watchers.delete(path);
      }
    }
    for (const path of wanted) {
      if (this.watchers.has(path)) continue;
      try {
        const watcher = watch(path, { persistent: false }, () => {
          clearTimeout(this.debounce);
          this.debounce = setTimeout(() => this.check(), WATCH_DEBOUNCE_MS);
        });
        watcher.on("error", () => {
          watcher.close();
          this.watchers.delete(path);
        });
        this.watchers.set(path, watcher);
      } catch {
        // A missing folder is fine: the stat on the next snapshot read still notices changes.
      }
    }
  }

  private slugs(): string[] {
    try {
      return readdirSync(this.root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && SLUG_DIR_RE.test(entry.name))
        .map((entry) => entry.name)
        .sort()
        .slice(0, MAX_PROJECTS);
    } catch {
      return [];
    }
  }

  private threadFiles(dir: string): string[] {
    try {
      return readdirSync(join(dir, "threads"), { withFileTypes: true })
        .filter((entry) => entry.isFile() && THREAD_FILE_RE.test(entry.name))
        .map((entry) => entry.name)
        // The newest, numerically: past the cap the old ones are mostly the finished ones. An old open
        // one is missed here only until the first overview, which keeps every open thread (keptThreads).
        .sort((a, b) => threadNumber(a.slice(0, -".toml".length)) - threadNumber(b.slice(0, -".toml".length)))
        .slice(-MAX_THREADS);
    } catch {
      return [];
    }
  }

  /** Size and mtime of everything Organizations' view is made from. Stats only; nothing is read. */
  private fingerprint(): string {
    const parts: string[] = [];
    const add = (path: string) => {
      try {
        const stat = lstatSync(path);
        parts.push(`${path}:${stat.mtimeMs}:${stat.size}`);
      } catch {
        parts.push(`${path}:-`);
      }
    };
    add(this.root);
    for (const slug of this.slugs()) {
      const dir = join(this.root, slug);
      add(join(dir, "PROJECT.md"));
      add(join(dir, "threads"));
      const names = new Set(this.threadFiles(dir));
      // An open thread older than the newest files still changes what the overview prints.
      for (const { view } of this.records.find((record) => record.slug === slug)?.threads ?? []) {
        if (view.status !== "resolved" && THREAD_ID_RE.test(view.id)) names.add(`${view.id}.toml`);
      }
      for (const name of names) add(join(dir, "threads", name));
      for (const name of STATE_FILES) add(join(dir, ".state", name));
    }
    // A coordinator edits its STATUS.md outside Organizations' own files, and only a new overview carries the edit.
    for (const record of this.records) for (const path of record.statusPaths ?? []) add(path);
    return parts.join("\n");
  }

  /** The fallback reader, and the source of what `--json` does not carry (session, coordinator, roots). */
  private readFiles(): FileProject[] {
    return this.slugs().flatMap((slug) => {
      const dir = join(this.root, slug);
      const settings = projectSettings(join(dir, "PROJECT.md"), this.root, slug);
      if (!settings) return [];
      const state = json(join(dir, ".state", "project.json"), this.root);
      const status = string(state.status) || "active";
      if (status === "archived") return [];
      const coordinator = json(join(dir, ".state", "coordinator.json"), this.root);
      const threads = this.threadFiles(dir).flatMap((name) => {
        const text = boundedText(join(dir, "threads", name), this.root);
        if (!text) return [];
        const record = toml(text);
        const view = tomlThread(record);
        return view ? [{ view, binding: binding(record) }] : [];
      });
      withDepth(threads);
      return [{
        slug,
        name: settings.name,
        ...(settings.goal ? { goal: settings.goal } : {}),
        status: status === "paused" ? "paused" as const : "active" as const,
        ...picks(settings.icon, settings.tone),
        session: string(coordinator.session),
        roots: [...settings.roots, string(coordinator.cwd)].filter((root) => isAbsolute(root)),
        repos: settings.roots,
        coordinator: binding(coordinator),
        threads,
      }];
    });
  }

  private fromJson(projects: OrgOverviewProject[], files: FileProject[], asks: AsksRead | undefined): ProjectRecord[] {
    // Every thread comes from the same binary, so one carrying the flags shows the actions exist.
    const prActions = projects.some((project) => project.threads.some((thread) => typeof thread.auto_merge === "boolean"));
    return projects.flatMap((project) => {
      if (project.status === "archived") return [];
      const local = files.find((file) => file.slug === project.slug);
      const threads = keptThreads(project.threads).map((thread) => ({
        view: jsonThread(thread, prActions), binding: binding(thread), summary: threadSummary(thread), ...(thread.report ? { report: thread.report } : {}),
      }));
      withDepth(threads);
      const record = {
        slug: project.slug,
        name: project.name,
        ...(project.goal ? { goal: project.goal } : {}),
        status: project.status,
        ...picks(project.icon, project.tone),
        // Neither the session nor the coordinator's pane is in the contract yet; the files supply them.
        session: local?.session ?? "",
        roots: local?.roots ?? [],
        repos: local?.repos ?? [],
        coordinator: local?.coordinator ?? { paneId: "", workspaceId: "", tabId: "", cwd: "" },
        threads,
        source: "json" as const,
        prActions,
        ...(project.status_file ? { statusFile: project.status_file } : {}),
        statusPaths: [project.status_file, ...project.threads.map((thread) => thread.status_file)].flatMap((file) => file ? [file.path] : []),
        ...(project.usage ? { usage: project.usage } : {}),
        ...(project.coordinator ? { coordinatorAgent: project.coordinator } : {}),
        recordsDir: recordsFolder(project, this.root),
        resolvedCoordinators: project.threads.flatMap((thread) => thread.role === "coordinator" && thread.status === "resolved" ? [thread.id] : []),
      };
      return [asks ? { ...record, waitingAsks: waitingAsks(record, asks) } : record];
    });
  }
}

/**
 * The folder Organizations keeps a project's reports, libraries and status files in: the `records`
 * setting, else the project's own folder. `overview --json` does not print it yet, but each thread's
 * `library` is `<records>/library/<id>`, so it is read from there, and the project's folder (the default
 * of an Organizations that predates both) is what is left.
 */
function recordsFolder(project: OrgOverviewProject, root: string): string {
  if (project.records) return project.records;
  for (const { id, library } of project.threads) {
    if (basename(library) === id && basename(dirname(library)) === "library") return dirname(dirname(library));
  }
  return join(root, project.slug);
}

/** Whether coordinator `id` of a project is resolved; the project's own (`root`) never is. */
function resolvedCoordinator(record: ProjectRecord, id: string): boolean {
  return record.resolvedCoordinators?.includes(id) ?? record.threads.some(({ view }) => view.id === id && view.status === "resolved");
}

/**
 * The `## Needs your decision` lines of a project's coordinators that still take an answer: the rows
 * `asks --json` prints, else the status files' lines as text, root first.
 */
function openDecisions(record: ProjectRecord, read: AsksRead): AskDecision[] {
  if (read.decisions) {
    return read.decisions.filter((row) => row.project === record.slug && !resolvedCoordinator(record, row.coordinator.id))
      .map((row) => ({ ...row, group: decisionGroup(row) }));
  }
  const line = (coordinator: AskDecision["coordinator"]) => (text: string): AskDecision =>
    ({ project: record.slug, coordinator, text, line: 0, links: [], group: "waiting" });
  const root = (record.statusFile?.needsDecision ?? []).map(line({ id: "root", title: "" }));
  const nodes = record.threads.flatMap(({ view, summary }) => view.status === "resolved" ? [] : (summary?.status?.needsDecision ?? [])
    .map(line({ id: view.id, title: view.title })));
  return [...root, ...nodes];
}

/** How many of a project's asks and decisions wait on the person. */
function waitingAsks(record: ProjectRecord, read: AsksRead): number {
  const waiting = read.asks.filter((row) => row.project === record.slug && askGroup(row, resolvedCoordinator(record, row.coordinator.id)) === "waiting");
  return waiting.length + openDecisions(record, read).filter((decision) => decision.group === "waiting").length;
}
