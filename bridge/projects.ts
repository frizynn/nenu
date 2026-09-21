import { closeSync, constants, fstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";

import type { AgentView, ProjectThreadView, ProjectView } from "./types.ts";

const CACHE_MS = 5_000;
const MAX_PROJECTS = 100;
const MAX_THREADS = 500;
const MAX_METADATA_BYTES = 64 * 1024;

type JsonObject = Record<string, unknown>;
type TomlObject = Record<string, unknown>;

export interface ProjectRegistryOptions {
  root?: string;
  now?: () => number;
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

function binding(record: TomlObject | JsonObject): Binding {
  return {
    paneId: string(record.pane_id),
    workspaceId: string(record.workspace_id),
    tabId: string(record.tab_id),
    cwd: string(record.cwd),
  };
}

function threadView(record: TomlObject, pane: AgentView | undefined): ProjectThreadView | undefined {
  const id = string(record.id);
  if (!/^t-\d{4,}$/.test(id)) return undefined;
  const status = string(record.status);
  const allowed = ["starting", "open", "failed", "resolved"] as const;
  const safeStatus = allowed.find((candidate) => candidate === status) ?? "open";
  const title = string(record.title).trim() || id;
  const parentId = string(record.parent_id) || "root";
  const role = string(record.role) === "coordinator" ? "coordinator" as const : "worker" as const;
  return {
    id,
    title,
    parentId,
    role,
    status: safeStatus,
    updated: string(record.updated) || undefined,
    ...(pane ? { paneId: pane.paneId, agent: pane.agent, liveStatus: pane.status } : {}),
  };
}

export class ProjectRegistry {
  private readonly root: string;
  private readonly now: () => number;
  private expires = 0;
  private records: Array<{ project: Omit<ProjectView, "coordinator" | "threads">; session: string; roots: string[]; coordinator: Binding; threads: Array<{ view: ProjectThreadView; binding: Binding }> }> = [];

  constructor(options: ProjectRegistryOptions = {}) {
    const candidate = options.root ?? resolveRoot();
    try {
      this.root = realpathSync(candidate);
    } catch {
      this.root = resolve(candidate);
    }
    this.now = options.now ?? Date.now;
  }

  list(sessionName: string, isPrimary: boolean, panes: readonly AgentView[]): ProjectView[] {
    if (this.now() >= this.expires) this.refresh();
    return this.records
      .filter((record) => record.session ? record.session === sessionName : isPrimary)
      .map((record) => {
        const coordinatorPane = livePane(record.coordinator, panes, record.roots);
        const threads = record.threads.map(({ view, binding }) => {
          const pane = livePane(binding, panes, record.roots);
          return pane ? { ...view, paneId: pane.paneId, agent: pane.agent, liveStatus: pane.status } : view;
        });
        return {
          ...record.project,
          coordinator: coordinatorPane ? {
            paneId: coordinatorPane.paneId,
            agent: coordinatorPane.agent,
            liveStatus: coordinatorPane.status,
          } : undefined,
          threads,
        };
      });
  }

  private refresh(): void {
    this.expires = this.now() + CACHE_MS;
    let slugs: string[] = [];
    try {
      slugs = readdirSync(this.root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^[a-z0-9][a-z0-9-]{0,39}$/.test(entry.name))
        .map((entry) => entry.name)
        .sort()
        .slice(0, MAX_PROJECTS);
    } catch {
      this.records = [];
      return;
    }
    this.records = slugs.flatMap((slug) => {
      const dir = join(this.root, slug);
      const settings = projectSettings(join(dir, "PROJECT.md"), this.root, slug);
      if (!settings) return [];
      const state = json(join(dir, ".state", "project.json"), this.root);
      const status = string(state.status) || "active";
      if (status === "archived") return [];
      const coordinator = json(join(dir, ".state", "coordinator.json"), this.root);
      const session = string(coordinator.session);
      const roots = [...settings.roots, string(coordinator.cwd)].filter((root) => isAbsolute(root));
      let names: string[] = [];
      try {
        names = readdirSync(join(dir, "threads"), { withFileTypes: true })
          .filter((entry) => entry.isFile() && /^t-\d{4,}\.toml$/.test(entry.name))
          .map((entry) => entry.name)
          .sort()
          .slice(0, MAX_THREADS);
      } catch {
        // A registered project with no threads is still a project.
      }
      const threads = names.flatMap((name) => {
        const text = boundedText(join(dir, "threads", name), this.root);
        if (!text) return [];
        const record = toml(text);
        const view = threadView(record, undefined);
        return view ? [{ view, binding: binding(record) }] : [];
      });
      return [{
        project: {
          slug,
          name: settings.name,
          goal: settings.goal,
          status: status === "paused" ? "paused" as const : "active" as const,
        },
        session,
        roots,
        coordinator: binding(coordinator),
        threads,
      }];
    });
  }
}
