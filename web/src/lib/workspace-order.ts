// How the operator orders the herd's workspaces on this device: Herdr's own order (the default), by
// name, or an order of their own set by dragging (ADR 0124). Kept in localStorage like the rest of a
// device's view; a store that throws (private mode, a full quota) keeps it for the page's life. Home's
// Workspaces and the drawer's tree read the same store, so both follow a change.
import { useSyncExternalStore } from "react";

export type WorkspaceOrderMode = "herdr" | "name" | "custom";

export interface WorkspaceOrder {
  mode: WorkspaceOrderMode;
  /** Workspace ids in the operator's order; read only in "custom". */
  custom: readonly string[];
}

export const HERDR_ORDER: WorkspaceOrder = { mode: "herdr", custom: [] };

export const ORDER_LABEL: Record<WorkspaceOrderMode, string> = { herdr: "Herdr order", name: "Name", custom: "Custom" };

const KEY = "nenu:workspace-order:v1";
const MODES = Object.keys(ORDER_LABEL) as WorkspaceOrderMode[];
let parsed: { raw: string | null; order: WorkspaceOrder } | null = null;
let memory: WorkspaceOrder | null = null;
const listeners = new Set<() => void>();

function parse(raw: string | null): WorkspaceOrder {
  try {
    const stored = JSON.parse(raw ?? "null") as { mode?: unknown; custom?: unknown } | null;
    if (!stored || typeof stored !== "object" || !MODES.includes(stored.mode as WorkspaceOrderMode)) return HERDR_ORDER;
    const custom = Array.isArray(stored.custom) ? stored.custom.filter((id): id is string => typeof id === "string") : [];
    return { mode: stored.mode as WorkspaceOrderMode, custom };
  } catch {
    return HERDR_ORDER;
  }
}

function read(): WorkspaceOrder {
  if (memory) return memory;
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return HERDR_ORDER;
  }
  if (parsed?.raw !== raw) parsed = { raw, order: parse(raw) };
  return parsed.order;
}

function write(order: WorkspaceOrder): void {
  try {
    if (order.mode === "herdr" && order.custom.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(order));
    memory = null;
  } catch {
    memory = order;
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The order chosen on this device, and how to change it; every list of workspaces follows. */
export function useWorkspaceOrder(): { order: WorkspaceOrder; set: (next: WorkspaceOrder) => void } {
  return { order: useSyncExternalStore(subscribe, read), set: write };
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * `items`, given in Herdr's order, in the order chosen: Herdr's as given, by name, or the operator's,
 * where a workspace the custom order never placed (opened since) follows the placed ones in Herdr's
 * order, and one that closed simply isn't there to place.
 */
export function orderWorkspaces<T>(items: readonly T[], idOf: (item: T) => string, nameOf: (item: T) => string, order: WorkspaceOrder): T[] {
  if (order.mode === "name") return [...items].sort((a, b) => byName.compare(nameOf(a), nameOf(b)));
  if (order.mode === "herdr") return [...items];
  const place = new Map(order.custom.map((id, index) => [id, index]));
  const at = (item: T) => place.get(idOf(item)) ?? Number.MAX_SAFE_INTEGER;
  // Array.prototype.sort is stable, so the unplaced keep Herdr's order among themselves.
  return [...items].sort((a, b) => at(a) - at(b));
}

