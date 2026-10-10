import { useSyncExternalStore } from "react";

// One bounded notification channel. Foreground feedback wins over background lifecycle updates.
export type StatusTone = "info" | "success" | "warn" | "error";

export interface StatusMessage {
  id: number;
  text: string;
  tone: StatusTone;
  description?: string;
}

let current: StatusMessage | null = null;
let nextId = 1;
let timer: ReturnType<typeof setTimeout> | null = null;
let remaining: number | null = null;
let deadline = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

/** Latest foreground feedback wins; errors persist until explicitly dismissed. Returns its id, for clearStatus. */
export function setStatus(text: string, tone: StatusTone = "info", ttlMs?: number | null,
  options: { description?: string; background?: boolean } = {}): number | undefined {
  if (options.background && current?.tone === "error") return undefined;
  if (timer) clearTimeout(timer);
  timer = null;
  current = { id: nextId++, text, tone, ...(options.description ? { description: options.description } : {}) };
  remaining = ttlMs === undefined ? (tone === "error" ? null : 2500) : ttlMs;
  resumeStatus(current.id);
  emit();
  return current.id;
}

/** An old close handler must never dismiss a newer message. */
export function clearStatus(id?: number): void {
  if (id !== undefined && current?.id !== id) return;
  if (timer) clearTimeout(timer);
  timer = null;
  remaining = null;
  current = null;
  emit();
}

export function pauseStatus(id: number): void {
  if (current?.id !== id || !timer) return;
  clearTimeout(timer);
  timer = null;
  remaining = Math.max(0, deadline - Date.now());
}

export function resumeStatus(id: number): void {
  if (current?.id !== id || timer || remaining === null) return;
  deadline = Date.now() + remaining;
  timer = setTimeout(() => clearStatus(id), remaining);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): StatusMessage | null {
  return current;
}

export function useStatus(): StatusMessage | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
