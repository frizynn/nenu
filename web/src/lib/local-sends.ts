import { useSyncExternalStore } from "react";

import { messageMatchKey } from "./message-images";
import type { DeliveryMode, NativeQueueState, QueueWaitReason, TranscriptEntry } from "./types";

// What this client has sent but the agent's journal does not show yet.
//
// The transcript is read from the agent's own session log, which only gains the operator's message
// after the harness writes it and the next history poll lands — seconds after the tap. Until then the
// conversation shows the message as a pending bubble from here. Each bubble is removed when the
// journal gains a matching user turn that was not already there when the bubble first rendered, so an
// identical earlier "continue" can never swallow a new one.
//
// Module state, keyed by pane, so a bubble survives the composer remounting on a pane switch. It is
// a page-session cache only: nothing here is persisted.

export type LocalSendState = "sending" | "queued" | "sent" | "failed";

export interface LocalSend {
  id: string;
  /** The wire text (prose plus image paths). */
  text: string;
  state: LocalSendState;
  /** The server queue row this bubble follows. Rows are matched by id, never by text. */
  queueId?: string;
  /** The row's own state while the message waits in Nenu's queue. */
  queueState?: "queued" | "sending" | "paused";
  deliveryMode?: DeliveryMode;
  waitingFor?: QueueWaitReason;
  stranded?: { reason: string; since: number };
  /** What the CLI's own queue did with it, once delivered. */
  native?: NativeQueueState;
  /** When the bridge pressed "Read it now" for it. */
  readNowAt?: number;
  /** The pane's agent when it was sent, for wording that names it. */
  agent?: string;
  /** Sent to an agent whose input box Nenu cannot read back, so nothing confirmed the text arrived. */
  unverified?: boolean;
  /** A failed send whose text may already be in the terminal: check it there rather than resend. */
  textDelivered?: boolean;
  error?: string;
  /** Journal user turns that already matched when this bubble was first reconciled. */
  baseline?: string[];
}

export interface LocalSendActions {
  retry: (send: LocalSend) => void;
  edit: (send: LocalSend) => void;
  remove: (send: LocalSend) => void;
  sendNow: (send: LocalSend) => void;
  readNow: (send: LocalSend) => void;
  openTerminal: (send: LocalSend) => void;
}

/** How long a delivered bubble may wait for its journal turn before it gives up quietly. */
export const SENT_TTL_MS = 45_000;
const EMPTY: LocalSend[] = [];

const sends = new Map<string, LocalSend[]>();
const actions = new Map<string, LocalSendActions>();
const expiry = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

export function localSendScope(paneId: string, session: string | undefined): string {
  return `${session ?? ""}\u0000${paneId}`;
}

function emit() {
  for (const listener of listeners) listener();
}

function write(scope: string, next: LocalSend[]) {
  if (next.length) sends.set(scope, next);
  else sends.delete(scope);
  emit();
}

export function listLocalSends(scope: string): LocalSend[] {
  return sends.get(scope) ?? EMPTY;
}

/** Start (or restart, for a retry of the same text) a pending bubble. Returns its id. */
export function addLocalSend(scope: string, text: string, state: LocalSendState = "sending"): string {
  const list = listLocalSends(scope);
  const existing = list.find((send) => send.text === text && (send.state === "failed" || send.state === "sending"));
  if (existing) {
    updateLocalSend(scope, existing.id, { state, error: undefined, textDelivered: undefined });
    return existing.id;
  }
  const id = crypto.randomUUID();
  write(scope, [...list, { id, text, state }]);
  return id;
}

export function updateLocalSend(scope: string, id: string, patch: Partial<Omit<LocalSend, "id" | "text">>) {
  const list = listLocalSends(scope);
  if (!list.some((send) => send.id === id)) return;
  write(scope, list.map((send) => (send.id === id ? { ...send, ...patch } : send)));
  clearTimeout(expiry.get(id));
  expiry.delete(id);
  if (patch.state === "sent") expiry.set(id, setTimeout(() => removeLocalSend(scope, id), SENT_TTL_MS));
}

export function removeLocalSend(scope: string, id: string) {
  clearTimeout(expiry.get(id));
  expiry.delete(id);
  const list = listLocalSends(scope);
  if (list.some((send) => send.id === id)) write(scope, list.filter((send) => send.id !== id));
}

/** Drop every bubble the journal now shows. `entries` is the live (not frozen) history window. */
export function reconcileLocalSends(scope: string, entries: readonly TranscriptEntry[]) {
  const list = listLocalSends(scope);
  if (!list.length) return;
  const users = entries
    .filter((entry) => entry.role === "user")
    .map((entry) => ({
      uuid: entry.uuid,
      key: messageMatchKey(entry.parts.map((part) => (part.kind === "text" ? part.text : "")).join("\n")),
    }));
  let changed = false;
  const next: LocalSend[] = [];
  for (const send of list) {
    const key = messageMatchKey(send.text);
    const matches = users.filter((user) => user.key === key).map((user) => user.uuid);
    if (!send.baseline) {
      next.push({ ...send, baseline: matches });
      changed = true;
    } else if (matches.some((uuid) => !send.baseline!.includes(uuid))) {
      clearTimeout(expiry.get(send.id));
      expiry.delete(send.id);
      changed = true;
    } else next.push(send);
  }
  if (changed) write(scope, next);
}

/** The composer that owns a pane registers what the bubbles' buttons do. */
export function setLocalSendActions(scope: string, value: LocalSendActions | null) {
  if (value) actions.set(scope, value);
  else actions.delete(scope);
  emit();
}

export function localSendActions(scope: string): LocalSendActions | undefined {
  return actions.get(scope);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLocalSends(scope: string): LocalSend[] {
  return useSyncExternalStore(subscribe, () => listLocalSends(scope), () => EMPTY);
}

export function useLocalSendActions(scope: string): LocalSendActions | undefined {
  return useSyncExternalStore(subscribe, () => actions.get(scope), () => undefined);
}

/** Test seam: forget every bubble and timer. */
export function resetLocalSends() {
  for (const timer of expiry.values()) clearTimeout(timer);
  expiry.clear();
  sends.clear();
  actions.clear();
  emit();
}

// ── Images this client uploaded ─────────────────────────────────────────────────────────────────
// The bridge previews an upload only once the journal shows the operator sent its path, so a
// freshly sent image would 404 for a few seconds. The composer already holds a local object URL
// for every file it uploaded; keep the most recent ones here, by server path, and revoke on eviction.

const IMAGE_LIMIT = 32;
const images = new Map<string, string>();

export function rememberLocalImage(path: string, url: string) {
  const previous = images.get(path);
  if (previous && previous !== url) URL.revokeObjectURL(previous);
  images.delete(path);
  images.set(path, url);
  while (images.size > IMAGE_LIMIT) {
    const [oldest, oldestUrl] = images.entries().next().value!;
    images.delete(oldest);
    URL.revokeObjectURL(oldestUrl);
  }
}

export function localImageUrl(path: string): string | undefined {
  return images.get(path);
}

export function isLocalImageUrl(url: string): boolean {
  for (const value of images.values()) if (value === url) return true;
  return false;
}
