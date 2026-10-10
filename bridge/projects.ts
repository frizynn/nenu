import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";

import { defaultOrgRun, readOverview, upstreamOnly, type OrgOverviewProject, type OrgOverviewThread, type OrgRun } from "./org-cli.ts";
import type { AgentView, LivePublisher, ProjectThreadView, ProjectView, ThreadPullRequest, WorkspaceView } from "./types.ts";

/** How often a snapshot read re-stats the registry when no watcher fired (the watcher's safety net). */
const STAT_MS = 2_000;
/** The fewest milliseconds between two `overview --json` spawns; a forced refresh skips it. */
const MIN_REFRESH_MS = 5_000;
const WATCH_DEBOUNCE_MS = 250;
const MAX_PROJECTS = 100;
const MAX_THREADS = 500;
const MAX_METADATA_BYTES = 64 * 1024;
const SLUG_DIR_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const THREAD_FILE_RE = /^t-\d{4,}\.toml$/;
const THREAD_ID_RE = /^t-\d{4,}$/;
/** The `.state/` files whose change can change what `overview --json` prints. Stat only, never read here. */
const STATE_FILES = ["project.json", "coordinator.json", "ticker.json"];

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

function projectSettings(path: string, root: string, slug: string): { name: string; goal?: string; roots: string[] } | undefined {
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
  return { name, ...(goal ? { goal } : {}), roots };
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
    ...(branch ? { branch } : {}),
    ...(pr ? { pr } : {}),
  };
}

function jsonThread(record: OrgOverviewThread, prActions: boolean): OrgThreadView {
  const status = STATUSES.find((candidate) => candidate === record.status) ?? "open";
  const raw = record.pr;
  const pr = raw && pullRequest(raw.url, raw.state, raw.review, status, {
    draft: raw.draft === true,
    ...(raw.checks ? { checks: { ...raw.checks, failing: raw.failing } } : {}),
    ...(raw.additions !== null && raw.deletions !== null ? { diff: { additions: raw.additions, deletions: raw.deletions } } : {}),
    ...(raw.comment_count !== null ? { commentCount: raw.comment_count } : {}),
    ...(raw.mergeable ? { mergeable: raw.mergeable } : {}),
    mergeBlocker: raw.merge_blocker,
  });
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
    ...(record.branch ? { branch: record.branch } : {}),
    ...(prActions ? { autoFixCi: record.auto_fix_ci === true, autoMerge: record.auto_merge === true } : {}),
    ...(pr ? { pr } : {}),
  };
}

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

interface FileProject {
  slug: string;
  name: string;
  goal?: string;
  status: "active" | "paused";
  session: string;
  roots: string[];
  coordinator: Binding;
  threads: Array<{ view: OrgThreadView; binding: Binding }>;
}

interface ProjectRecord extends FileProject {
  source: "json" | "files";
  prActions: boolean;
}

export class ProjectRegistry {
  private readonly root: string;
  private readonly now: () => number;
  private readonly run: OrgRun | null;
  private readonly live?: LivePublisher;
  private readonly watchEnabled: boolean;
  private readonly upstream: () => boolean;
  private records: ProjectRecord[] = [];
  private nodeActions = true;
  private loaded = false;
  private stamp = "";
  private nextStat = 0;
  private lastRefresh = -Infinity;
  private inFlight: Promise<void> | undefined;
  /** A refresh asked for while one ran; `force` if any of those asks skipped the throttle. */
  private again: { force: boolean } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private readonly sessions = new Set<string>();
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
    this.watchEnabled = options.watch ?? true;
    this.upstream = options.upstream ?? upstreamOnly;
  }

  list(sessionName: string, isPrimary: boolean, panes: readonly AgentView[]): OrgProjectView[] {
    this.sessions.add(sessionName);
    if (!this.loaded) {
      // The first read paints from the files at once; the `--json` view follows as an `org` event.
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
    return this.records
      .filter((record) => record.session ? record.session === sessionName : isPrimary)
      .map((record) => {
        const coordinatorPane = livePane(record.coordinator, panes, record.roots);
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
          coordinator: coordinatorPane ? {
            paneId: coordinatorPane.paneId,
            agent: coordinatorPane.agent,
            liveStatus: coordinatorPane.status,
          } : undefined,
          threads,
          source: record.source,
          prActions: record.prActions,
          nodeActions: this.nodeActions,
          workspaceIds: [...workspaceIds],
        };
      });
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

  /** Re-read now, ignoring the spawn throttle: after a write the person is waiting for the result. */
  invalidate(): Promise<void> {
    return this.schedule(true);
  }

  /** Re-read the files and `overview --json`, and announce `org` if anything visible changed. */
  async refresh(): Promise<void> {
    this.lastRefresh = this.now();
    this.stamp = this.fingerprint();
    const files = this.readFiles();
    const overview = this.run ? await readOverview(this.run, this.root).catch(() => undefined) : undefined;
    const next = overview ? this.fromJson(overview, files) : files.map((project) => ({ ...project, source: "files" as const, prActions: false }));
    const nodeActions = !this.upstream();
    const changed = nodeActions !== this.nodeActions || JSON.stringify(next) !== JSON.stringify(this.records);
    this.records = next;
    this.nodeActions = nodeActions;
    this.loaded = true;
    this.rewatch();
    if (changed) for (const session of this.sessions) this.live?.publish({ session, topic: "org" });
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
    if (this.fingerprint() !== this.stamp) void this.schedule(false);
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
        .sort()
        .slice(0, MAX_THREADS);
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
      for (const name of this.threadFiles(dir)) add(join(dir, "threads", name));
      for (const name of STATE_FILES) add(join(dir, ".state", name));
    }
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
        session: string(coordinator.session),
        roots: [...settings.roots, string(coordinator.cwd)].filter((root) => isAbsolute(root)),
        coordinator: binding(coordinator),
        threads,
      }];
    });
  }

  private fromJson(projects: OrgOverviewProject[], files: FileProject[]): ProjectRecord[] {
    // Every thread comes from the same binary, so one carrying the flags shows the actions exist.
    const prActions = projects.some((project) => project.threads.some((thread) => typeof thread.auto_merge === "boolean"));
    return projects.flatMap((project) => {
      if (project.status === "archived") return [];
      const local = files.find((file) => file.slug === project.slug);
      const threads = project.threads.slice(0, MAX_THREADS).map((thread) => ({ view: jsonThread(thread, prActions), binding: binding(thread) }));
      withDepth(threads);
      return [{
        slug: project.slug,
        name: project.name,
        ...(project.goal ? { goal: project.goal } : {}),
        status: project.status,
        // Neither the session nor the coordinator's pane is in the contract yet; the files supply them.
        session: local?.session ?? "",
        roots: local?.roots ?? [],
        coordinator: local?.coordinator ?? { paneId: "", workspaceId: "", tabId: "", cwd: "" },
        threads,
        source: "json" as const,
        prActions,
      }];
    });
  }
}
