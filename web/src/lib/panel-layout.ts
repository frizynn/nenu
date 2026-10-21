// How the operator arranged a chat panel's sections on this device: their order, which are folded and
// which are hidden. Kept in localStorage per kind of panel (a coordinator's, a thread's), so a phone
// and a desk keep their own; a store that throws (private mode, a full quota) keeps it for the page's
// life. A section the layout never heard of takes its place from the panel's own order.
import { useSyncExternalStore } from "react";

export interface PanelLayout {
  /** Section ids in the operator's order; ids a panel draws that are missing here follow the default. */
  order: readonly string[];
  folded: readonly string[];
  hidden: readonly string[];
}

export const DEFAULT_LAYOUT: PanelLayout = { order: [], folded: [], hidden: [] };

const KEY = "nenu.panel-layout:";
/** What each kind's stored text last parsed to, so a render reads the same layout until it changes. */
const parsed = new Map<string, { raw: string | null; layout: PanelLayout }>();
/** Where a layout lives while the store throws (private mode, a full quota): this page's life. */
const memory = new Map<string, PanelLayout>();
const listeners = new Set<() => void>();

const ids = (value: unknown): string[] => Array.isArray(value) ? value.filter((id): id is string => typeof id === "string").slice(0, 32) : [];

function parse(raw: string | null): PanelLayout {
  try {
    const stored = JSON.parse(raw ?? "null") as Partial<Record<keyof PanelLayout, unknown>> | null;
    return stored && typeof stored === "object" ? { order: ids(stored.order), folded: ids(stored.folded), hidden: ids(stored.hidden) } : DEFAULT_LAYOUT;
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function read(kind: string): PanelLayout {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY + kind);
  } catch {
    return memory.get(kind) ?? DEFAULT_LAYOUT;
  }
  const last = parsed.get(kind);
  if (last?.raw === raw) return last.layout;
  const layout = parse(raw);
  parsed.set(kind, { raw, layout });
  return layout;
}

function write(kind: string, layout: PanelLayout): void {
  try {
    if (layout === DEFAULT_LAYOUT) localStorage.removeItem(KEY + kind);
    else localStorage.setItem(KEY + kind, JSON.stringify(layout));
  } catch {
    memory.set(kind, layout);
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The panel's ids in the operator's order: the ones it placed first, each new one after the one it follows by default. */
export function arrange(defaults: readonly string[], layout: PanelLayout): string[] {
  const placed = layout.order.filter((id) => defaults.includes(id));
  for (const [index, id] of defaults.entries()) {
    if (placed.includes(id)) continue;
    const before = defaults.slice(0, index).reverse().find((candidate) => placed.includes(candidate));
    placed.splice(before === undefined ? 0 : placed.indexOf(before) + 1, 0, id);
  }
  return placed;
}

/** `layout` with `id` one place up (-1) or down (+1) among the panel's ids, every id then placed. */
export function moveSection(defaults: readonly string[], layout: PanelLayout, id: string, step: -1 | 1): PanelLayout {
  const order = arrange(defaults, layout);
  const from = order.indexOf(id);
  const to = from + step;
  if (from < 0 || to < 0 || to >= order.length) return layout;
  [order[from], order[to]] = [order[to]!, order[from]!];
  return { ...layout, order };
}

const toggled = (list: readonly string[], id: string, on: boolean) => on ? [...list.filter((other) => other !== id), id] : list.filter((other) => other !== id);

export const foldSection = (layout: PanelLayout, id: string, folded: boolean): PanelLayout => ({ ...layout, folded: toggled(layout.folded, id, folded) });
export const hideSection = (layout: PanelLayout, id: string, hidden: boolean): PanelLayout => ({ ...layout, hidden: toggled(layout.hidden, id, hidden) });

/** The layout of one kind of panel on this device, and how to change it; every panel of that kind follows. */
export function usePanelLayout(kind: string): { layout: PanelLayout; set: (next: PanelLayout) => void; reset: () => void } {
  const layout = useSyncExternalStore(subscribe, () => read(kind));
  return { layout, set: (next) => write(kind, next), reset: () => write(kind, DEFAULT_LAYOUT) };
}

/** Whether the operator changed anything, so Reset has something to undo. */
export const arranged = (layout: PanelLayout) => layout.order.length + layout.folded.length + layout.hidden.length > 0;
