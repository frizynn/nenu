import { useSyncExternalStore } from "react";

import { messageMatchKey } from "./message-images";
import { holdReload, releaseReload } from "./reload-guard";
import type { DeliveryMode, NativeQueueState, QueueWaitReason, TranscriptEntry } from "./types";

// What this client has sent but the agent's journal does not show yet.
//
// The transcript is read from the agent's own session log, which only gains the operator's message
// after the harness writes it and the next history poll lands — seconds after the tap. Until then the
// conversation shows the message as a pending bubble from here. A bubble lands when the journal gains a
// matching user turn (`turnCarries`) that was not already there when the bubble first rendered, so an
// identical earlier "continue" can never swallow a new one. The conversation stops drawing it in the same render
// that draws the journal's turn (`pendingSends`), so the message is never on screen twice; the landed
// bubble stays in the store a while longer, holding its queue row, so that row is not drawn as a
// message of its own while the queue catches up.
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
  /** Journal user turns already there when this bubble was first reconciled: none of them can be it. */
  baseline?: string[];
  /** The journal turn that now shows this message: the bubble is no longer drawn. */
  landed?: string;
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
  holdWhileUnsent();
  emit();
}

// A message on its way, or one that failed with its text only on its bubble, is unsent work: the
// conversation view clears the composer as it sends, so this is the only place that text lives.
function holdWhileUnsent() {
  const unsent = [...sends.values()].some((list) =>
    list.some((send) => !send.landed && (send.state === "sending" || (send.state === "failed" && !send.textDelivered))));
  if (unsent) holdReload("local-sends");
  else releaseReload("local-sends");
}

export function listLocalSends(scope: string): LocalSend[] {
  return sends.get(scope) ?? EMPTY;
}

/** Start (or restart, for a retry of the same text) a pending bubble. Returns its id. */
export function addLocalSend(scope: string, text: string, state: LocalSendState = "sending"): string {
  const list = listLocalSends(scope);
  const existing = list.find((send) => !send.landed && send.text === text && (send.state === "failed" || send.state === "sending"));
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
  const send = list.find((item) => item.id === id);
  if (!send) return;
  write(scope, list.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  // A landed bubble keeps the timer that forgets it.
  if (send.landed) return;
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

/**
 * Whether a journal user turn is this message. A failure whose text may be in the pane can still have
 * reached the agent joined to text the box held (a draft, a queued message the CLI put back), wherever
 * the caret was: its turn holds the message anywhere. Any other bubble must be the whole turn.
 */
function turnCarries(send: LocalSend, turn: string): boolean {
  const sent = messageMatchKey(send.text);
  if (turn === sent) return true;
  if (send.state !== "failed" || !send.textDelivered) return false;
  const [prose = "", images = "0"] = sent.split("\u0000");
  const [turnProse = "", turnImages = "0"] = turn.split("\u0000");
  return prose !== "" && Number(turnImages) >= Number(images) && turnProse.includes(prose);
}

/** The journal's user turns as the bubbles match them: by their words and their pictures. */
function userKeys(entries: readonly TranscriptEntry[]) {
  return entries
    .filter((entry) => entry.role === "user")
    .map((entry) => ({
      uuid: entry.uuid,
      key: messageMatchKey(entry.parts.map((part) => (part.kind === "text" ? part.text : "")).join("\n")),
    }));
}

/** The journal turn showing `send` that was not there when it was first reconciled. */
function landing(send: LocalSend, users: ReturnType<typeof userKeys>): string | undefined {
  if (!send.baseline) return undefined;
  return users.find((user) => !send.baseline!.includes(user.uuid) && turnCarries(send, user.key))?.uuid;
}

/**
 * The bubbles to draw beside `entries`: none the journal already shows. Read in the same render as
 * the entries, so the frame that draws the journal's turn never draws the bubble too.
 */
export function pendingSends(list: readonly LocalSend[], entries: readonly TranscriptEntry[] | null): LocalSend[] {
  const users = entries ? userKeys(entries) : [];
  return list.filter((send) => !send.landed && landing(send, users) === undefined);
}

/** Mark every bubble the journal now shows as landed. `entries` is the live (not frozen) history window. */
export function reconcileLocalSends(scope: string, entries: readonly TranscriptEntry[]) {
  const list = listLocalSends(scope);
  if (!list.length) return;
  const users = userKeys(entries);
  let changed = false;
  const next = list.map((send) => {
    if (send.landed) return send;
    // Every turn already there predates the send, so none of them can be it.
    if (!send.baseline) {
      changed = true;
      return { ...send, baseline: users.map((user) => user.uuid) };
    }
    const landed = landing(send, users);
    if (!landed) return send;
    changed = true;
    clearTimeout(expiry.get(send.id));
    expiry.set(send.id, setTimeout(() => removeLocalSend(scope, send.id), SENT_TTL_MS));
    return { ...send, landed };
  });
  if (changed) write(scope, next);
}

/** What a take-back from the CLI's own queue answered (ADR 0118): the words that came back, the rows they were. */
export interface TakenBack {
  text: string;
  messages: Array<{ id: string; text: string }>;
  /** The words are exactly those rows', spacing aside: the box held nothing else. */
  ours: boolean;
}

/**
 * What a take-back puts in the composer, and what it says. The rows' own words when the box held only
 * them, so line breaks and long words survive; without `removed`'s row for a Remove. Otherwise the box
 * as the screen showed it, said as such: nothing that came back is dropped.
 */
export function takenBack(back: TakenBack, removed?: string): { text: string; note?: string } {
  if (!back.ours) return { text: back.text, note: "Claude's queue held more than Nenu sent: all of it is back in your box." };
  const kept = back.messages.filter((message) => message.id !== removed);
  const text = kept.map((message) => message.text).join("\n\n");
  return removed !== undefined && kept.length ? { text, note: "Removed. The other queued messages are back in your box." } : { text };
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

// Where the conversation keeps the rows of Nenu's queue that have no bubble of this device's (queued
// on another device, or before the page loaded): an element at the thread's end, after its last turn.
// The composer, which owns the queue, draws them into it, so they read as messages in the thread and
// never as a strip over it.
const queueSlots = new Map<string, HTMLElement>();

export function setQueueSlot(scope: string, element: HTMLElement | null) {
  if (element) queueSlots.set(scope, element);
  else queueSlots.delete(scope);
  emit();
}

export function useQueueSlot(scope: string): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => queueSlots.get(scope) ?? null, () => null);
}

/** Test seam: forget every bubble and timer. */
export function resetLocalSends() {
  for (const timer of expiry.values()) clearTimeout(timer);
  expiry.clear();
  sends.clear();
  actions.clear();
  queueSlots.clear();
  holdWhileUnsent();
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
