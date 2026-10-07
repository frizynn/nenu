import { useCallback, useState } from "react";

// The workbench sidebar's layout, persisted per device. Every write merges into what storage holds
// now: the desktop sidebar and the drawer are separate instances, and a stale one must not undo
// the other's choice.

export type SidebarView = "projects" | "recent";

export interface SidebarPrefs {
  /** `null` until chosen: then Projects leads whenever a project exists. */
  view: SidebarView | null;
  /** Explicit expand/collapse per project slug; a project nobody touched starts expanded. */
  expanded: Record<string, boolean>;
}

const STORAGE_KEY = "collie:sidebar:v1";

export function coerceSidebarPrefs(raw: unknown): SidebarPrefs {
  const p = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
  const expanded = typeof p.expanded === "object" && p.expanded !== null
    ? Object.fromEntries(Object.entries(p.expanded).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"))
    : {};
  return { view: p.view === "projects" || p.view === "recent" ? p.view : null, expanded };
}

function load(): SidebarPrefs {
  try {
    return coerceSidebarPrefs(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    return coerceSidebarPrefs(null);
  }
}

function save(prefs: SidebarPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
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

  return { prefs, setView, setExpanded };
}
