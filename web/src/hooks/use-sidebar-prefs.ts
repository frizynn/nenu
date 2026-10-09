import { useCallback, useState } from "react";

// The workbench sidebar's layout, persisted per device. Every write merges into what storage holds
// now: the desktop sidebar and the drawer are separate instances, and a stale one must not undo
// the other's choice.

export type SidebarView = "workspaces" | "projects" | "recent";
const VIEWS: readonly SidebarView[] = ["workspaces", "projects", "recent"];

export interface SidebarPrefs {
  /** `null` until chosen: then Workspaces leads. */
  view: SidebarView | null;
  /** Explicit expand/collapse per project slug; a project nobody touched starts expanded. */
  expanded: Record<string, boolean>;
  /** Explicit expand/collapse per workspace id; an untouched one follows `defaultOpen`. */
  workspaces: Record<string, boolean>;
}

const STORAGE_KEY = "collie:sidebar:v1";

export function coerceSidebarPrefs(raw: unknown): SidebarPrefs {
  const p = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
  // Read from `nav`, not the old `view`: a choice made before Workspaces existed would hide it.
  const view = VIEWS.find((option) => option === p.nav) ?? null;
  return { view, expanded: folds(p.expanded), workspaces: folds(p.workspaces) };
}

function folds(raw: unknown): Record<string, boolean> {
  return typeof raw === "object" && raw !== null
    ? Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"))
    : {};
}

function load(): SidebarPrefs {
  try {
    return coerceSidebarPrefs(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    return coerceSidebarPrefs(null);
  }
}

function save({ view, ...folds }: SidebarPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ nav: view, ...folds }));
  } catch {
    // A lost layout preference is not worth a broken render.
  }
}

export function useSidebarPrefs() {
  const [prefs, setPrefs] = useState(load);

  const update = useCallback((change: (latest: SidebarPrefs) => SidebarPrefs) => {
    const next = change(load());
    save(next);
    setPrefs(next);
  }, []);

  const setView = useCallback((view: SidebarView) => update((latest) => ({ ...latest, view })), [update]);
  const setExpanded = useCallback((slug: string, open: boolean) =>
    update((latest) => ({ ...latest, expanded: { ...latest.expanded, [slug]: open } })), [update]);

  const setWorkspaceOpen = useCallback((workspaceId: string, open: boolean) =>
    update((latest) => ({ ...latest, workspaces: { ...latest.workspaces, [workspaceId]: open } })), [update]);

  return { prefs, setView, setExpanded, setWorkspaceOpen };
}
