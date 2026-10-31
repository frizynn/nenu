// The sidebar's chats by the project their folders work in, and how this device views them: by project
// (the default) or as one list by time, and which projects it keeps open. Kept free of React so the
// grouping's rules stay unit-testable.
import { deviceStore } from "./device-store";
import { liveliest } from "./desk-nav";
import type { AgentStatus, AgentView } from "./types";

/** A project's name: the bridge's (the repo the folder sits in), else the folder's own, else the workspace's. */
export function projectName(pane: Pick<AgentView, "project" | "cwd" | "workspaceLabel">): string {
  return pane.project || pane.cwd.split("/").filter(Boolean).pop() || pane.workspaceLabel;
}

export interface ProjectGroup<T> {
  /** Its name, case-folded: two folders that read the same are one project on screen. */
  key: string;
  label: string;
  items: T[];
  /** The most pressing state among its agents; none when they all rest. */
  state?: AgentStatus;
}

/** `items` by project, each project where its first item is and its items in their order. */
export function groupByProject<T>(items: readonly T[], pane: (item: T) => AgentView): ProjectGroup<T>[] {
  const groups = new Map<string, ProjectGroup<T>>();
  for (const item of items) {
    const label = projectName(pane(item));
    const key = label.toLocaleLowerCase();
    const group = groups.get(key) ?? { key, label, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({ ...group, state: liveliest(group.items.map(pane)) }));
}

const RANK: Partial<Record<AgentStatus, number>> = { blocked: 2, working: 1 };
const RANK_STEP = 1e13;

/**
 * Where a project sorts, as one number for `useHeldTime`: one with something that needs you first, then
 * one at work, then the rest, each by the last time one of its chats moved.
 */
export function projectWeight<T>(group: ProjectGroup<T>, at: (item: T) => number): number {
  return (group.state ? RANK[group.state] ?? 0 : 0) * RANK_STEP + Math.max(0, ...group.items.map(at));
}

/** How the desk's bar lists: the workspace tree, chats by project, by when they moved, or by state. */
export type SidebarView = "workspaces" | "projects" | "time" | "state";
const VIEWS: readonly SidebarView[] = ["workspaces", "projects", "time", "state"];

export interface ProjectView {
  view: SidebarView;
  /** The projects opened or closed by hand, by key; an untouched one starts closed. */
  open: Record<string, boolean>;
}

const DEFAULT_VIEW: ProjectView = { view: "projects", open: {} };

function parse(raw: string | null): ProjectView {
  try {
    const stored = JSON.parse(raw ?? "null") as { view?: unknown; open?: unknown } | null;
    if (!stored || typeof stored !== "object") return DEFAULT_VIEW;
    const open = typeof stored.open === "object" && stored.open !== null
      ? Object.fromEntries(Object.entries(stored.open).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"))
      : {};
    return { view: VIEWS.find((view) => view === stored.view) ?? "projects", open };
  } catch {
    return DEFAULT_VIEW;
  }
}

const useStoredView = deviceStore("nenu:sidebar-view:v1", parse, (value) => value.view === "projects" && Object.keys(value.open).length === 0, DEFAULT_VIEW);

/** This device's view of the sidebar's chats; the desk's bar and the phone's drawer share it. */
export function useProjectView(): ProjectView & { setView: (view: SidebarView) => void; setOpen: (key: string, open: boolean) => void } {
  const [value, set] = useStoredView();
  return {
    ...value,
    setView: (view) => set({ ...value, view }),
    setOpen: (key, open) => set({ ...value, open: { ...value.open, [key]: open } }),
  };
}
