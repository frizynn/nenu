import { busyChoiceFor, useMessageQueue, type BusyChoice } from "@/hooks/use-message-queue";
import { useStopTurn } from "@/hooks/use-stop-turn";
import { useOutageNoticeShown } from "@/lib/connection-health";
import { MessageQueueStrip } from "./message-queue-strip";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ChangeEvent, ClipboardEvent, DragEvent, ReactNode } from "react";
import { useRevalidator } from "react-router";
import { ArrowUp, Check, CircleAlert, Gauge, ImagePlus, Keyboard, Loader2, Plus, Settings2, Slash, Terminal, Zap, type LucideIcon } from "lucide-react";

import type { DisplayPrefs } from "@/hooks/use-display-prefs";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import { useDirectTyping } from "@/hooks/use-direct-typing";
import { clearStatus, setStatus } from "@/lib/status";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ChatInput } from "@/components/ui/chat/chat-input";
import { SkillPicker } from "@/components/skill-picker";
import { useSkillComposer } from "@/hooks/use-skill-composer";
import { NavTray } from "@/components/nav-tray";
import { CommandPalette } from "@/components/command-palette";
import { QuickActionsContent } from "@/components/quick-actions";
import { DisplayPrefsContent } from "@/components/display-prefs";
import { PanelHeader } from "@/components/ui/panel-header";
import { OptionButton, OptionList, SECONDARY_ACTION } from "@/components/option-button";
import { WorkbenchPopover } from "@/components/ui/workbench-popover";
import { ActionGroups, type ConversationActionGroup } from "@/components/conversation-actions";
import * as api from "@/lib/api";
import { commandsFor } from "@/lib/agent-commands";
import { useOperatorCommands, useOperatorKeys } from "@/lib/operator-config";
import { ctrlPresetsFor } from "@/lib/operator-keys";
import { isDestructiveInput } from "@/lib/destructive";
import { clearDraft, fitsDraftStore, loadDraft, saveDraft } from "@/lib/drafts";
import { useHoldReload } from "@/lib/reload-guard";
import { isSelfEcho, normalizeDraft } from "@/hooks/use-terminal-draft";
import { adapterFor } from "@/lib/harness";
import { replyOutcomeFrom, retryKeepsRequestId, type ReplyOutcome } from "@/lib/guarded-reply";
import { parseAnsi } from "@/lib/ansi";
import { splitLines } from "@/lib/blocks";
import { detectNoEchoPrompt } from "@/lib/no-echo";
import type { DeliveryMode } from "@/lib/types";
import type { LockReason } from "@/components/question-card";
import { TerminalDraftPreview } from "@/components/terminal-draft-preview";
import { DirectTypingStrip } from "@/components/direct-typing-strip";
import { NoEchoNotice } from "@/components/no-echo-notice";
import { ComposerNotice } from "@/components/composer-notice";
import { AttachmentChips } from "@/components/attachment-chips";
import { StopControl } from "@/components/stop-control";
import { WorkActivityLabel } from "@/components/work-activity-label";
import { readyPaths, useComposerAttachments } from "@/hooks/use-composer-attachments";
import { serializeMessage, splitDraftUploads, splitMessageImages } from "@/lib/message-images";
import {
  addLocalSend,
  listLocalSends,
  localSendScope,
  removeLocalSend,
  setLocalSendActions,
  updateLocalSend,
  useLocalSends,
  type LocalSend,
  type LocalSendActions,
} from "@/lib/local-sends";
import type { QueueMessage } from "@/lib/api";

export interface ComposerHandle {
  /** Focus the input and put the caret at the end — used by the mirror-tap-to-focus in AgentChat. */
  focusInput: () => void;
  prepareAnswer: (text: string) => void;
  /** Opens the harness's own model picker through the same verified send as a reply. */
  openModelPicker: () => Promise<boolean>;
  compactContext: () => Promise<boolean>;
  /** Open one of the in-flow docks; routed through the same guarded drawer transition as a menu tap. */
  openDock: (dock: "keys" | "quick" | "display") => void;
}

/**
 * One of the composer's secondary controls. The composer owns their state and behaviour. The + at
 * the start of the box reaches every message-side group in this order; View is published to the
 * pane header's ⋯ menu, so the header keeps the view and the composer keeps the message.
 */
export interface ComposerControl {
  id: "photo" | "quick" | "commands" | "keys" | "type" | "usage" | "display";
  group: (typeof MESSAGE_GROUPS)[number] | "View";
  label: string;
  icon: LucideIcon;
  disabled: boolean;
  /** An open dock or an armed mode; absent for a plain action. */
  on?: boolean;
  run: () => void;
}

/** The + menu's groups, in the order it lists them. */
const MESSAGE_GROUPS = ["Attach", "Replies", "Terminal", "Session"] as const;

interface ComposerProps {
  paneId: string;
  /** The session the pane lives in (undefined = primary) — scopes every write to the right Herdr. */
  session?: string;
  /** The pane's agent name — drives the slash-command palette and the reply-vs-shell placeholder. */
  agent: string | undefined | null;
  /** True for a bare shell pane (tweaks the placeholder copy). */
  isShell: boolean;
  /** Idle copy for an agent pane in place of "Type a reply…"; lock and shell states still win. */
  placeholder?: string;
  /** A turn runs (lib/turn.ts): Stop shows, and Send offers "now" or "after this turn" where the CLI
   *  has both (ADR 0056). Background work alone is no turn, so Send goes directly. */
  working?: boolean;
  /** Pane is gone (no agent) — locks the composer with a distinct placeholder. */
  gone: boolean;
  /** This device isn't authorised to type — locks the composer with a distinct placeholder. */
  readOnly: boolean;
  /** Transport unavailable: stop terminal writes while keeping the local draft editable. */
  disconnected?: boolean;
  /** Why the composer is locked, when the caller knows: the box then names that cause instead of the
   *  generic one (a refused sign-in is not an unauthorised device, Herdr down is not a reconnect).
   *  It only changes the words; `readOnly`, `gone` and `disconnected` still decide what is locked. */
  lockReason?: LockReason;
  /** A question card on screen already says why answers are paused, so the box only says what it
   *  keeps: an outage is named once, by the banner once it is up, else by the card, else here. */
  lockOnCard?: boolean;
  /** Herdr itself isn't answering, whatever lock holds: a read-only device has an outage too. Until
   *  the banner or the card names it, one line above the box does. */
  herdrDown?: boolean;
  modelControl?: ReactNode;
  /** The background-work chip, beside the model in the row under the draft. */
  processesControl?: ReactNode;
  /** Something beside the composer (the desk's details panel) that the empty composer's Esc closes
   *  before it would stop the turn. */
  onEscape?: () => void;
  /** When the running turn started (ISO), for the "Working for …" row shown while typing. */
  workingSince?: string;
  usageControls?: ReactNode;
  /** The conversation is on screen rather than the terminal mirror: sends can queue, and Display
   *  offers the chat's own settings. */
  nativeWorkbench?: boolean;
  prepareSend?: () => Promise<boolean>;
  onInputFocus?: () => void;
  /** A dialog (prompt/wizard/preview/multi-select) is on screen, so the TUI's keyboard belongs to it.
   * Free-text sending is refused while true — see send(). Answer it with its own buttons instead. */
  dialogPresent: boolean;
  /** Latest pane text — clears the pending-send preview once the mirror echoes the send back. */
  text: string;
  /** A user draft stranded on the terminal's "❯" input line (extractInputDraft), STABILISED across
   * polls (useStableTerminalDraft) — non-null only once the same text has held for ~1.5s. Gates the
   * APPEARANCE of the read-only draft preview, so a one-poll blip or an in-flight send never flashes it. */
  terminalDraft: string | null;
  /** The SAME draft, but the RAW per-poll value (pre-stabilisation). Once the preview is showing, its
   * text tracks this live so host typing streams into it; it also drives the send()-time pre-clear (the
   * actual current "❯" line) and unmounts the preview when it goes null. Never written into the input. */
  rawTerminalDraft: string | null;
  /** Mirror display prefs — the View row lives here, but the mirror (in AgentChat) reads the same
   * single instance, so they're threaded through rather than each calling useDisplayPrefs. */
  prefs: DisplayPrefs;
  setWrap: (wrap: boolean) => void;
  stepFontSize: (delta: number) => void;
  setRawTerminal: (raw: boolean) => void;
  setTapToFocus: (tapToFocus: boolean) => void;
  /** Snap the mirror to the live tail (follow + revalidate + scroll) after a successful send. */
  onSent: () => void;
  /** Receives the secondary controls whenever their state changes (see ComposerControl). */
  onControlsChange?: (controls: ComposerControl[]) => void;
}

// The composer cluster at the bottom of the pane view — everything a phone keyboard can't do on its
// own: quick actions, an agent-aware slash-command palette, an inline key tray (via
// `pane.send_keys`), image upload, display prefs, and the reply Send (with a destructive-command
// two-tap guard). Its state (draft, sending, upload, pending preview, its own Keys/Quick/Agent
// sheets) is entirely local; it reaches AgentChat only through `onSent` (to re-follow the tail) and
// exposes `focusInput` so the mirror tap can bring up the keyboard.
//
// Keys, Quick, Display and Usage open as in-flow docks above the input (they act on, or change how
// you read, what is on screen, so the conversation stays visible while they are up). One box holds
// the + (every message-side action, attach included), the draft and Send; Display is published to
// the header's ⋯ menu (onControlsChange). The model and the session's background work sit in the
// quiet row beneath the box, which steps aside while a phone keyboard is up.
type ComposerDrawer = "quick" | "cmd" | "keys" | "display" | "usage" | null;

// Grace window after a send during which a terminal draft matching what we just sent is treated as
// our own in-flight reply (still on the "❯" line before the bridge's pending Enter lands), NOT a
// stranded draft. Wide enough to cover a slow tailnet round-trip; the parent's cross-poll
// stabilisation (useStableTerminalDraft) closes the other half of the same window.
const SENT_ECHO_GRACE_MS = 5_000;

// Burst window for post-keypress revalidation (see scheduleKeyRevalidate).
const KEY_REVALIDATE_MS = 300;

// Shared in-flow dock chrome for Keys/Quick — an IN-FLOW panel (never an overlay), so the terminal
// mirror's flex-1 box shrinks and its tail stays visible while the dock is open (a covering sheet
// hid exactly the prompt you were driving). Full-bleed top border + capped height keep the mirror
// usable on a phone. The header is the popovers' PanelHeader, titled with the + row that opened the
// dock, and a NON-scrolling child of a flex column; only the body below it scrolls (max-h +
// overflow), so the Close X can never scroll out of reach on a short viewport with a tall tray. One
// wrapper so Keys and Quick replies can't drift apart.
function ComposerDock({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="mb-2 flex flex-col overflow-hidden rounded-xl border border-border/65 bg-card">
      <PanelHeader title={title} onClose={onClose} className="pl-3" />
      <div className="max-h-[45dvh] min-h-0 overflow-y-auto pt-2">{children}</div>
    </div>
  );
}

/**
 * The send-time choice for a busy agent: the question, then the cards' own option list and Cancel as
 * their quiet escape, as Home's sheet draws the same choice. No card around it: with the keyboard up
 * a frame and a headline cost the thread its last lines. It sits on the page gutter, where the
 * cards' lists do, rather than the box's bleed. The wording is the CLI's own measured behaviour, so
 * "now" never promises more than the CLI does (ADR 0056: asked at every send, never remembered).
 */
function BusyChoicePanel({ choice, onPick, onCancel }: { choice: BusyChoice; onPick: (mode: DeliveryMode) => void; onCancel: () => void }) {
  return (
    <div role="group" aria-label={`${choice.name} is working`} className="mb-2 flex flex-col gap-2 max-lg:mx-2">
      <p className="text-footnote text-pretty text-muted-foreground">{choice.name} is working. When should it read this?</p>
      <OptionList className="bg-card">
        <OptionButton label="Send now" description={choice.nowHint} onClick={() => onPick(choice.now)} />
        <OptionButton label="Queue for later" description={choice.laterHint} onClick={() => onPick("afterTurn")} />
      </OptionList>
      <div className="-mx-2 flex">
        <button type="button" className={SECONDARY_ACTION} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// How long a row above the box takes to fold open and to fold shut (the direction's enter and exit).
const FOLD_OPEN_MS = 220;
const FOLD_SHUT_MS = 150;

/**
 * A row above the box (Stop's, a notice) folds open and shut instead of appearing at once, so the
 * thread above moves with it rather than jumping. One already there on mount is simply there.
 * Folding shut, it keeps showing what it last showed, out of reach: inert and hidden from assistive
 * tech, so a Stop on its way out can never be pressed.
 */
function Fold<T>({ value, children }: { value: T | null | false; children: (value: T) => ReactNode }) {
  const [phase, setPhase] = useState<"open" | "opening" | "shutting" | "shut">(value ? "open" : "shut");
  const last = useRef<T | null>(null);
  if (value) last.current = value;
  const shown = Boolean(value);
  useEffect(() => setPhase((current) => (shown ? (current === "open" ? current : "opening") : current === "shut" ? current : "shutting")), [shown]);
  useEffect(() => {
    if (phase !== "opening" && phase !== "shutting") return;
    const timer = setTimeout(() => setPhase(phase === "opening" ? "open" : "shut"), phase === "opening" ? FOLD_OPEN_MS : FOLD_SHUT_MS);
    return () => clearTimeout(timer);
  }, [phase]);
  if (phase === "shut" || last.current === null) return null;
  const shutting = phase === "shutting";
  return (
    <div className="composer-fold" data-phase={phase} inert={shutting} aria-hidden={shutting || undefined}>
      <div>{children(last.current)}</div>
    </div>
  );
}

/** A send that did not go through, said above the box until the next edit or send. */
interface SendFailure {
  error: string;
  /** May the text already be in the pane? Then the way forward is to look, never to resend. */
  delivered: boolean;
  /** One more line of what to do, when the error alone does not say it. */
  hint?: string;
  /** The pre-flight refused it, so Send's slot offers Type anyway for as long as that stays armed. */
  overridable?: boolean;
  /** The message, when it was not the draft under the notice (a quick reply). */
  quote?: string;
  /** What Try again sends: the message, when it is still where it was (the box, or a quick reply). */
  retry: { text: string; isDraft: boolean } | null;
}

/** One line for the mirror view's "You sent" strip: the prose, and how many images went with it. */
function sentPreview(message: string): string {
  const { text, images } = splitMessageImages(message);
  const prose = text.length > 60 ? `${text.slice(0, 57)}…` : text;
  const count = images.length ? `${images.length} image${images.length === 1 ? "" : "s"}` : "";
  return [prose, count].filter(Boolean).join(" · ");
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { paneId, session, agent, isShell, placeholder, working = false, gone, readOnly, disconnected = false, lockReason, lockOnCard = false, herdrDown = false, modelControl, processesControl, onEscape, workingSince, usageControls, nativeWorkbench = false, prepareSend, onInputFocus, dialogPresent, text, terminalDraft, rawTerminalDraft, prefs, setWrap, stepFontSize, setRawTerminal, setTapToFocus, onSent, onControlsChange },
  ref,
) {
  const revalidator = useRevalidator();
  // Every write affordance is off when the pane is gone OR this device is read-only.
  const locked = gone || readOnly || disconnected;
  // Nothing can be written here at all (as opposed to a draft waiting out an outage): the box keeps
  // the reason and Send's slot, disabled, and no + to offer actions that would refuse.
  const lockedOut = gone || readOnly;
  // …and a ref alongside it, for the ONE caller that reads it after an await. `send()` checks
  // `locked` once, up front, but its pre-clear sweep goes out on the far side of the pre-flight's
  // pane read; a re-render that locks the composer in that window must be able to stop the most
  // destructive keys this component sends. Every other write affordance is either disabled by React
  // or funnelled through `pressKeys`, which is synchronous with its own check.
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  // Herdr's outage is named by one surface at a time: the banner while it is on screen (one shared
  // store, as the card reads it), else a card whose lock is the outage, else this box.
  const bannerUp = useOutageNoticeShown();
  const herdrLock = disconnected && lockReason === "herdr";
  const outageUnnamed = herdrDown && !bannerUp && !(lockOnCard && herdrLock);

  // The phone-owned draft, restored from (and written through to) the per-pane draft store — the
  // pane view is keyed by paneId, so without this, stepping over to another tab mid-reply ate the
  // message. Lazy initialiser so the restore happens on the mount, before first paint.
  // A stored draft is the wire text; Nenu's own upload paths come back out of it as attachments.
  const [restoredDraft] = useState(() => splitDraftUploads(loadDraft(session, paneId) ?? ""));
  const [input, setInput] = useState(restoredDraft.text);
  // Mirror of `input` for the write-through path: updateInput needs the previous value to apply a
  // functional update AND to persist the result, without either reading stale state or doing the
  // save inside a (double-invoked) state updater.
  const inputValueRef = useRef(input);
  // Which pane the current `input` belongs to. DetailRoute keys AgentChat by paneId, so in the app a
  // pane→pane navigation remounts this component and the lazy initialiser above does the work — but
  // the component must not depend on that: if it is ever rendered with a changed paneId/session in
  // place, the effect below saves the outgoing pane's draft and loads the incoming one, so pane A's
  // text can never surface in pane B.
  const draftPaneRef = useRef({ session, paneId });
  // The last send that did not go through, said above the box. It describes that draft only, so any
  // change to the draft (typed, taken over, answered from a card, put back by Edit) or a new send
  // takes it down: Try again must never send text it did not refuse.
  const [failure, setFailure] = useState<SendFailure | null>(null);

  /**
   * Set the draft AND persist it. Every write to `input` goes through here — an empty value removes
   * the stored key, so the deliberate-clear paths (verified send, user emptying the box) need no
   * special case.
   *
   * PERSISTENCE STOPS while a password prompt is on screen (#103). By the time the notice appears the
   * secret is already in the 48h store — the write-through ran on every keystroke, before any send was
   * attempted — so `noEchoRef` gates the save AND the pane-leave save below, and the outcome that sets
   * it removes the stored copy outright. The button was never enough: the operator who taps Send,
   * gives up and walks to a laptop (which is exactly what #103 reports doing, for three days) never
   * presses anything, and the pane-leave path would have re-saved it on the way out.
   *
   * Gating on a REF, not the state, because the two must change in the same tick as the outcome that
   * decides it — a render behind is a render in which the next keystroke is still being stored.
   * The in-memory draft is untouched: a false positive costs one draft its ability to survive the OS
   * killing the PWA, which is a cheap price for never storing a real one.
   */
  function updateInput(next: string | ((prev: string) => string)) {
    const value = typeof next === "function" ? next(inputValueRef.current) : next;
    inputValueRef.current = value;
    setInput(value);
    setFailure(null);
    persistDraft(value, readyPaths(attachments.current()));
  }

  /** The one writer of the stored draft: text plus attached upload paths, as they would be sent. */
  function persistDraft(text: string, paths: readonly string[]) {
    if (noEchoRef.current !== null) return;
    saveDraft(session, paneId, paths.length ? serializeMessage(text, paths) : text);
  }

  const attachments = useComposerAttachments({
    upload: (file) => api.uploadImage(paneId, file, session),
    previewUrl: (path) => api.paneFileUrl(paneId, path, session),
    onPathsChange: (paths) => {
      setFailure(null);
      persistDraft(inputValueRef.current, paths);
    },
    initialPaths: restoredDraft.uploads,
  });
  const hasDraft = input.trim() !== "" || attachments.paths.length > 0;

  /** The composer's content as the wire text — what Send would put on the line right now. */
  function draftMessage(): string {
    return serializeMessage(inputValueRef.current, readyPaths(attachments.current())).trim();
  }

  function clearComposer() {
    updateInput("");
    attachments.reset();
  }

  /** Put a message back into the composer — after a failed send, or to edit a queued one. Anything
   *  already typed is kept: the message's prose goes on a new line and its images join the chips. */
  function restoreIntoComposer(message: string) {
    const { text, uploads } = splitDraftUploads(message);
    updateInput((prev) => (prev.trim() && text ? `${prev.trimEnd()}\n${text}` : prev.trim() ? prev : text));
    attachments.append(uploads);
  }

  useEffect(() => {
    const prev = draftPaneRef.current;
    if (prev.paneId === paneId && prev.session === session) return;
    const outgoing = readyPaths(attachments.current());
    if (noEchoRef.current === null) saveDraft(prev.session, prev.paneId, outgoing.length ? serializeMessage(inputValueRef.current, outgoing) : inputValueRef.current);
    draftPaneRef.current = { session, paneId };
    const restored = splitDraftUploads(loadDraft(session, paneId) ?? "");
    inputValueRef.current = restored.text;
    setInput(restored.text);
    attachments.reset(restored.uploads);
    noticeNoEcho(null); // it described the pane we just left
    setFailure(null);
  }, [session, paneId]);
  const queue = useMessageQueue(paneId, session, nativeWorkbench && !gone && !readOnly);
  // Pending bubbles in the conversation (lib/local-sends.ts) for what this composer sent.
  const sendScope = localSendScope(paneId, session);
  const localSends = useLocalSends(sendScope);
  useEffect(() => {
    const accepted = queue.accepted;
    if (accepted) {
      // Also fires for a save the queue retried on its own after a failure put the draft back.
      if (draftMessage() === accepted.text.trim()) clearComposer();
      const echo =
        listLocalSends(sendScope).find((item) => item.queueId === accepted.id) ??
        listLocalSends(sendScope).find((item) => !item.queueId && item.text === accepted.text && item.state !== "sent");
      if (echo) {
        if (echo.state !== "queued" || echo.queueId !== accepted.id)
          updateLocalSend(sendScope, echo.id, { state: "queued", queueState: "queued", queueId: accepted.id, error: undefined });
      } else if (nativeWorkbench) {
        const id = addLocalSend(sendScope, accepted.text, "queued");
        updateLocalSend(sendScope, id, { queueId: accepted.id, agent: agent ?? undefined });
      }
      onSent();
    }
  }, [queue.accepted]);
  // Follow each queued bubble through its own server row (by id: two identical messages are two
  // rows): its state while it waits in Nenu, then what the CLI's queue did with it once delivered.
  useEffect(() => {
    const page = queue.page;
    if (!page?.available) return;
    for (const echo of listLocalSends(sendScope)) {
      if (!echo.queueId) continue;
      // A delivered bubble still learns what the CLI's own queue did with it (Claude's journal).
      if (echo.state === "sent") {
        const done = queue.delivered.find((item) => item.id === echo.queueId);
        if (!done?.native || done.native === echo.native) continue;
        updateLocalSend(sendScope, echo.id, done.native === "enqueued" ? { state: "queued", native: "enqueued", readNowAt: done.readNowAt } : { native: done.native });
        continue;
      }
      if (echo.state !== "queued") continue;
      const row = page.messages.find((message) => message.id === echo.queueId);
      if (row) {
        const patch = { queueState: row.state, error: row.error, deliveryMode: row.deliveryMode, waitingFor: row.waitingFor, stranded: row.stranded };
        if ((Object.keys(patch) as Array<keyof typeof patch>).some((key) => JSON.stringify(patch[key]) !== JSON.stringify(echo[key])))
          updateLocalSend(sendScope, echo.id, patch);
        continue;
      }
      const done = queue.delivered.find((item) => item.id === echo.queueId);
      // Still in the CLI's own queue: the bubble keeps waiting, with "Read it now" where it exists.
      if (done?.native === "enqueued") {
        if (echo.native !== "enqueued" || echo.readNowAt !== done.readNowAt)
          updateLocalSend(sendScope, echo.id, { native: "enqueued", readNowAt: done.readNowAt, queueState: undefined, waitingFor: undefined, deliveryMode: done.deliveryMode ?? echo.deliveryMode });
      } else if (done) {
        updateLocalSend(sendScope, echo.id, { state: "sent", native: done.native, queueState: undefined, waitingFor: undefined, deliveryMode: done.deliveryMode ?? echo.deliveryMode });
      } else {
        // Gone from the queue with no delivery record: a restart on another state dir or a removal
        // elsewhere. Never call that "Sent"; say so, and let the operator check before resending.
        updateLocalSend(sendScope, echo.id, { state: "failed", textDelivered: true, error: "This message left the queue without being delivered. Check the chat or Terminal before sending it again.", queueState: undefined, waitingFor: undefined });
      }
    }
  }, [queue.page, sendScope]);
  /** Begin an optimistic send. In the conversation view the message moves straight to its pending
   *  bubble, so the composer clears now; the terminal view has no bubble, so its draft stays put
   *  until the send is verified. */
  function beginSend(message: string, isDraft: boolean, echo: boolean) {
    const taken = isDraft && nativeWorkbench ? draftMessage() : null;
    if (taken !== null) clearComposer();
    const id = echo ? addLocalSend(sendScope, message) : null;
    if (id) updateLocalSend(sendScope, id, { agent: agent ?? undefined });
    return { taken, id };
  }
  /** A send that did not go through: the message goes back into an empty composer; if the operator
   *  has already started something new, it stays on its bubble as "Not sent" instead of clobbering it.
   *  Text that may already be in the terminal (`delivered`) stays on its bubble, pointing at Terminal:
   *  putting it back under Send would invite the resend that duplicates it. */
  function failSend(started: { taken: string | null; id: string | null }, error: string, secret = false, delivered = false) {
    const composerEmpty = draftMessage() === "" && attachments.current().length === 0;
    const restored = started.taken !== null && composerEmpty && (!delivered || !started.id);
    if (restored) restoreIntoComposer(started.taken!);
    if (!started.id) return;
    // A password prompt's text must not linger on screen; a restored draft is already back in the box.
    if (secret || restored) removeLocalSend(sendScope, started.id);
    else updateLocalSend(sendScope, started.id, { state: "failed", error: error || "Not sent", textDelivered: delivered || undefined });
  }
  async function enqueueDraft(value: string, isDraft: boolean, mode: DeliveryMode): Promise<boolean> {
    const t = value.trim();
    if (!t || sending || queue.busy) return false;
    if (!queue.page?.available) { setStatus("Connect a conversation to queue messages.", "info"); return false; }
    const started = beginSend(t, isDraft, !t.startsWith("/"));
    const rowId = await queue.add(t, mode);
    if (rowId) {
      if (started.id) updateLocalSend(sendScope, started.id, { state: "queued", queueState: "queued", queueId: rowId, deliveryMode: mode });
      if (draftMessage() === t) clearComposer();
    } else failSend(started, "Couldn't queue this message");
    return rowId !== null;
  }
  // A busy agent's Send waits here for the operator's pick: now, or after this turn (ADR 0056).
  const [busyPick, setBusyPick] = useState<{ text: string; isDraft: boolean } | null>(null);
  const busyChoice = nativeWorkbench && queue.page?.available ? busyChoiceFor(agent) : null;
  useEffect(() => setBusyPick(null), [paneId, session, locked]);
  function pickBusy(mode: DeliveryMode) {
    const pick = busyPick;
    setBusyPick(null);
    if (!pick) return;
    // A draft keeps what was typed while the choice was open; a quick reply sends what was tapped.
    void enqueueDraft(pick.isDraft ? draftMessage() : pick.text, pick.isDraft, mode);
  }
  // "Read it now" backgrounds Claude's running command, so it takes a second tap.
  const readNowConfirm = usePendingConfirm(8_000);
  const readNowPrompt = useRef<number | undefined>(undefined);
  function readNow(rowId: string) {
    if (!readNowConfirm.confirm(rowId)) {
      readNowPrompt.current = setStatus("Claude moves a running command to the background to read it now. Tap again to confirm.", "info");
      return;
    }
    // The prompt asked for this tap; left up, it would ask for another.
    if (readNowPrompt.current !== undefined) clearStatus(readNowPrompt.current);
    void queue.readNow(rowId);
  }
  const [sending, setSending] = useState(false);
  const pendingDeliveryRef = useRef<{ paneId: string; text: string; id: string; keep: boolean } | null>(null);
  // "Sending…" for the terminal view, which has no bubble to say it.
  const [delivering, setDelivering] = useState(false);
  // Pending-send preview: set on a successful send, cleared when the mirror catches up (next text
  // update) or after a 6s safety timeout. Shows "You sent: …" so the user knows the message landed.
  const [lastSent, setLastSent] = useState<string | null>(null);
  const [justSent, setJustSent] = useState(false); // brief ✓ on the send button after a send
  // Terminal-draft preview bookkeeping. The composer input is EXCLUSIVELY phone-owned — a host draft
  // is never written into it implicitly; it only surfaces in a read-only preview the user can
  // deliberately Take over. There is no user-facing dismiss — the preview is honest state (a draft
  // really is stranded on the host's line), so it stays visible until the host line clears, the user
  // takes it over, or the user sends. `handledKey` is the NORMALISED text the user has handled (took
  // over or sent) — the preview stays hidden while the live draft still normalises to it, so it can't
  // re-latch onto the same text we just copied/sent (the raw line still holds it until the host clears
  // or Enter lands); a genuinely different draft is fair game again. `previewLatched` is the show/hide
  // latch: a STABLE draft flips it on (gating appearance behind the 1.5s stability), and it stays on —
  // its text tracking the RAW draft live — until the host line clears or the user acts (see the effects
  // below).
  const [handledKey, setHandledKey] = useState<string | null>(null);
  const [previewLatched, setPreviewLatched] = useState(false);
  // Composer sheets are mutually exclusive — at most one open (Keys / Quick / Agent / Display).
  const [drawer, setDrawer] = useState<ComposerDrawer>(null);
  // Keys staged in the (unmounted-on-close) NavTray, pushed up so leaving the Keys dock can guard a
  // composed sequence. See requestDrawer.
  const [queuedKeys, setQueuedKeys] = useState(0);
  // Two-tap guard for discarding that sequence. Separate from sendConfirm so an armed "Really send?"
  // and an armed discard can't clobber each other.
  const discardConfirm = usePendingConfirm();

  // The SINGLE choke point for every drawer transition. Closing the Keys dock destroys the composed
  // queue (NavTray unmounts, useKeyQueue resets) — deliberate, because a queue that survived into a
  // later open would let Send fire yesterday's chord sequence into today's TUI state, and this
  // surface's whole safety story is "you review exactly what is about to go on the wire". So the fix
  // for a mis-tap is a confirm, not persistence.
  //
  // Routed through here rather than guarding the dock's ✕ alone: every ⋯ menu item that opens another
  // dock, and arming Type, unmount the tray just as effectively. An armed-but-EMPTY queue (a
  // lone `once` modifier, no chips) does not arm the confirm — one tap of setup isn't work worth
  // protecting, and over-guarding just trains you to double-tap through it reflexively.
  function requestDrawer(next: ComposerDrawer) {
    if (drawer === "keys" && next !== "keys" && queuedKeys > 0 && !discardConfirm.confirm("discard")) {
      setStatus(
        `Tap again to discard ${queuedKeys} queued key${queuedKeys === 1 ? "" : "s"}`,
        "info",
      );
      return;
    }
    discardConfirm.reset();
    setDrawer(next);
  }
  const closeDrawer = () => requestDrawer(null);
  // Two-tap guard for destructive commands (rm -rf, force-push, …): the first tap arms a "Really
  // send?" state on the Send button (auto-disarms after 3 s), the second actually sends. Same shared
  // confirm the command palette uses for /clear.
  const sendConfirm = usePendingConfirm();
  // Two-tap override for a `blocked` pre-flight ("the input box isn't on screen"). Separate from
  // sendConfirm so a destructive-command confirm and an override can't clobber each other, and given
  // a longer window than the 3s default: unlike "Really send?", this one asks you to read a sentence
  // explaining WHY nothing was typed before deciding to overrule it.
  const forceConfirm = usePendingConfirm(10_000);

  // The password prompt the last refused send was looking at, if it was one (#103). Set from the
  // guard's own live read — never re-derived from `display`, which is a snapshot — and cleared by the
  // ✕, by arming Type, by a send that goes through, and by leaving the pane. Not persisted: it is a
  // statement about what is on screen right now.
  //
  // It is state AND a ref because it has two jobs on two clocks: the strip renders from the state,
  // while the draft write-through (updateInput, above) has to stop storing keystrokes in the same tick
  // the outcome lands, not on the render after. `noticeNoEcho` is the only writer of both — go through
  // it, or the two disagree and the gap is measured in stored passwords.
  const [noEcho, setNoEcho] = useState<{ prompt: string; typed: boolean } | null>(null);
  const noEchoRef = useRef<{ prompt: string; typed: boolean } | null>(null);

  /** Raise or clear the password-prompt notice. Raising it also DROPS the stored draft: at that moment
   *  we know the field holds a secret the pane never accepted, and leaving it in a 48h store to be
   *  restored on the next visit is the leak #103 asked about. The in-memory value stays — the operator
   *  can still read it, hand it to Type, or dismiss the notice and carry on. */
  function noticeNoEcho(next: { prompt: string; typed: boolean } | null) {
    noEchoRef.current = next;
    setNoEcho(next);
    if (next !== null) clearDraft(session, paneId);
  }

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const direct = useDirectTyping({
    paneKey: `${session ?? ""}\0${paneId}`,
    inputRef,
    // The ref, not `input`: the password-prompt handoff clears the draft and arms in one tick.
    replyDraft: () => inputValueRef.current,
    canActivate: () => !(locked || sending || attachments.uploading),
    // `locked` covers a gone pane, a read-only device, and the idle pause. A LOST CONNECTION is
    // deliberately not added here: the mode already disarms on a failed batch, which is the same
    // event observed directly rather than inferred from a timer, and it fires whether or not any
    // banner has decided the connection counts as lost yet.
    suspended: locked,
    sendKeys: pressKeys,
    onActivate: () => {
      sendConfirm.reset();
      forceConfirm.reset();
      noticeNoEcho(null); // the notice's whole job was to get you here
    },
    focusInput: focusInputEnd,
  });
  const sentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // What we last sent, and when — so we can recognise our OWN reply momentarily echoing on the "❯"
  // line (during the bridge's send_text→settle→Enter gap) and NOT treat it as a stranded draft. A
  // ref, not state: it feeds a render-time derivation but must not itself trigger re-renders.
  const lastSentRef = useRef<{ text: string; at: number } | null>(null);
  // Trailing-edge debounce for post-keypress revalidation: a burst of raw key sends (arrow-key
  // spam) coalesces into a single pane refetch instead of one per press.
  const keyRevalidateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The pane's harness adapter, resolved HERE (this is where the agent is known) so the neutral
  // draft helpers below stay harness-free: they take the capability, never the grammar. Undefined for
  // any agent without an adapter, which is exactly the "no idea" case those helpers already handle.
  const adapter = adapterFor(agent ?? undefined);
  const stop = useStopTurn({ paneId, session, agent, interruptible: !!adapter?.interrupt && !gone && !readOnly, working, locked });

  // Guard against a false stranded-draft: if the detected draft is what we JUST sent, it's our own
  // reply still echoing on the "❯" line before the bridge's pending Enter — suppress both the preview
  // AND the destructive clear-prefix on the next Send. Applied to the raw and the stabilised value
  // alike (during the echo both carry our text). Recomputed each render (each poll re-renders), so it
  // lapses on its own once the grace expires or the echo resolves; a genuinely stranded draft (never
  // matches a recent send) is untouched.
  const suppressEcho = (draft: string | null): string | null => {
    const pending = pendingDeliveryRef.current;
    if (draft !== null && pending?.paneId === paneId && isSelfEcho(draft, pending.text, adapter?.draftCarriesSend)) return null;
    if (
      draft !== null &&
      lastSentRef.current !== null &&
      Date.now() - lastSentRef.current.at < SENT_ECHO_GRACE_MS &&
      isSelfEcho(draft, lastSentRef.current.text, adapter?.draftCarriesSend)
    ) {
      return null;
    }
    return draft;
  };
  // effectiveStable gates the preview's appearance; effectiveRaw tracks its displayed text.
  // Sending gets a separate live draft from the guard, since display polls can be stale.
  const effectiveStable = suppressEcho(terminalDraft);
  const effectiveRaw = suppressEcho(rawTerminalDraft);
  // One provider-scoped catalogue feeds both inline completion and the command palette.
  const operatorCommands = useOperatorCommands();
  const commands = commandsFor(agent, operatorCommands);
  const skills = useSkillComposer({
    paneId, session, agent, input, updateInput, inputRef, mine: operatorCommands,
    enabled: !direct.active && !gone && !readOnly && drawer === null,
  });

  async function runWorkbenchCommand(command: "/model" | "/compact") {
      // Do not clear a host-side draft or race direct typing just to open a picker.
      if (direct.active || sending || locked || rawTerminalDraft !== null) {
        setStatus("Finish the current agent input before using this action.", "info");
        return false;
      }
      const available = commandsFor(agent, operatorCommands).find((c) => c.command === command);
      if (!available || available.dangerous) {
        setStatus("Open Commands to use this action with your configured confirmation.", "info");
        return false;
      }
      return send(command, false, false, command === "/model" ? "model" : "compact");
  }

  useImperativeHandle(ref, () => ({
    focusInput: focusInputImmediately,
    prepareAnswer: (text) => { updateInput((draft) => draft.trim() ? `${draft}\n${text}` : text); focusInputImmediately(); },
    openModelPicker: () => runWorkbenchCommand("/model"),
    compactContext: () => runWorkbenchCommand("/compact"),
    openDock: (dock) => requestDrawer(dock),
  }));

  useEffect(
    () => () => {
      if (sentTimer.current) clearTimeout(sentTimer.current);
      if (lastSentTimerRef.current) clearTimeout(lastSentTimerRef.current);
      if (keyRevalidateTimer.current) clearTimeout(keyRevalidateTimer.current);
    },
    [],
  );

  // When the mirror delivers fresh output (text changed), the send has been echoed back — clear the
  // pending preview immediately regardless of the 6s fallback timer.
  useEffect(() => {
    setLastSent(null);
    if (lastSentTimerRef.current) {
      clearTimeout(lastSentTimerRef.current);
      lastSentTimerRef.current = null;
    }
  }, [text]);

  // Block a self-update reload while there's unsent work here: real typed text OR an upload in flight.
  // The composer input is phone-owned, so any non-empty value is genuine unsent work. A terminal draft
  // is SAFE on its own — it lives on the "❯" line and its preview re-derives after a reload — so it
  // never holds. The update waits until the hold clears. Keyed by pane so panes do not clobber
  // each other's hold.
  useHoldReload(
    `composer:${paneId}`,
    hasDraft || attachments.uploading || direct.active || direct.value !== "" || direct.busy,
  );

  // Preview appearance latch. A STABLE, non-echo, not-already-handled draft flips the preview on —
  // this is the ONLY gate that waits for the 1.5s stability, so a blip or an in-flight send never
  // flashes it. Deliberately one-directional: once latched, rapid host typing (which keeps blanking
  // the stabilised value) can't turn it back off — the raw-tracking + unlatch effects own the hide
  // side. Skipped when the pane is gone.
  useEffect(() => {
    if (gone) return;
    if (effectiveStable !== null && normalizeDraft(effectiveStable) !== handledKey) {
      setPreviewLatched(true);
    }
  }, [effectiveStable, handledKey, gone]);

  // Unlatch when the host clears the "❯" line — the draft was submitted or wiped on the host, or our
  // own send echoed back and got suppressed to null. The preview unmounts on the next render. Also
  // forget the handled key: it exists only to stop the JUST-handled text re-latching before the line
  // clears — once the line has actually emptied, a later re-strand of the same text is a fresh draft
  // and must surface again (without this, taking over "continue" once muted every future "continue"
  // in the pane until you navigated away).
  useEffect(() => {
    if (effectiveRaw === null) {
      setPreviewLatched(false);
      setHandledKey(null);
    }
  }, [effectiveRaw]);

  // Show the preview while it's latched, the host line still carries a (non-echo) draft, and the user
  // hasn't already handled this exact text. Its displayed text is the LIVE raw line — host typing
  // streams straight into it (display-only; it can never write back into the phone-owned input). There
  // is no dismiss action — this is the ONLY way the preview hides short of the host line itself
  // clearing, since a draft that still normalises to `handledKey` is the one the user just took over
  // or sent, not a fresh one to re-show. Not gated on `locked`: read-only devices get the preview +
  // Take over (a local text copy); only the actual Send stays gated.
  const showPreview =
    !gone && previewLatched && effectiveRaw !== null && normalizeDraft(effectiveRaw) !== handledKey;

  // Take over: the explicit "I'll handle this on mobile now" action. One-shot COPY of the current raw
  // draft into the composer (set on an empty input, else appended on a new line so mobile-typed work
  // survives), mark that exact text handled (so it can't instantly re-latch the preview — the raw line
  // still holds it until the host clears it), and hide the preview. No keys touch the terminal here —
  // the stranded line is only ever swept by the send()-time pre-clear. If the host keeps typing and
  // produces a DIFFERENT draft afterwards, the preview honestly reappears with the new text.
  function takeOverDraft() {
    if (effectiveRaw === null) return;
    const draft = effectiveRaw;
    direct.deactivate();
    updateInput((prev) => (prev.trim() ? `${prev.trimEnd()}\n${draft}` : draft));
    setHandledKey(normalizeDraft(draft));
    setPreviewLatched(false);
    focusInputEnd();
  }

  // The Keys tray's preset row, resolved the same way from the same one-shot read of /api/config.
  const keyPresets = ctrlPresetsFor(agent, useOperatorKeys());

  function focusInputImmediately() {
    const el = inputRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }

  function focusInputEnd() {
    setTimeout(focusInputImmediately, 0);
  }

  // Resolves true only on a VERIFIED send (the text was seen in the pane's input box before the
  // submit key went out). The quick-reply grid consumes the verdict to drive its own ✓ and to decide
  // whether to close its dock, so every early return below has to answer honestly.
  async function send(value: string, isDraft: boolean, force = false, action?: "model" | "compact"): Promise<boolean> {
    const t = value.trim();
    if (!t || locked || sending) return false;
    setFailure(null);
    const queueable = nativeWorkbench && queue.page?.available && !action && !force;
    // A dialog owns the TUI's keyboard: Nenu's queue holds the message until the dialog is answered.
    if (queueable && dialogPresent) return enqueueDraft(t, isDraft, "afterTurn");
    // A queue add whose answer never came is resent by the queue's poll. Going through the queue
    // again reuses its row id, so the message is delivered once instead of also through /send.
    const unsaved = queueable ? queue.pendingAdd() : null;
    if (unsaved) return enqueueDraft(t, isDraft, unsaved.text === t ? unsaved.deliveryMode : "afterTurn");
    // A busy agent: the operator picks now or after this turn. An idle one gets the message directly.
    if (queueable && working && busyChoice) {
      setBusyPick({ text: t, isDraft });
      return false;
    }
    // Without the queue, a dialog on screen refuses the send: our text would be swallowed and the
    // submit key would ANSWER the dialog, approving whatever option was highlighted (#34). The input
    // is kept: the user answers the dialog with its own buttons, then taps Send again. We never
    // queue-and-auto-send here, because the text may be a reaction to state the dialog just changed.
    if (dialogPresent && !(nativeWorkbench && prepareSend)) {
      setFailure({ error: "A dialog is waiting. Answer it first, then send.", delivered: false, retry: null });
      return false;
    }
    setSending(true);
    // Slash commands are not conversation turns, so they get no bubble.
    const started = beginSend(t, isDraft, !action && nativeWorkbench && !t.startsWith("/"));
    const previous = pendingDeliveryRef.current;
    // The same request id only while the bridge can still act on the earlier try (retryKeepsRequestId).
    const delivery = previous?.paneId === paneId && previous.text === t && previous.keep
      ? previous
      : { paneId, text: t, id: crypto.randomUUID(), keep: false };
    pendingDeliveryRef.current = delivery;
    if (!action) setDelivering(true);
    // Set once the write is on the wire: from then on a lost answer may hide a message already typed.
    let posted = false;
    try {
      if (action !== "model" && prepareSend && !(await prepareSend())) {
        failSend(started, "");
        return false;
      }
      if (lockedRef.current) {
        failSend(started, "");
        return false;
      }
      posted = true;
      // One request: the bridge sweeps a stranded draft, types, verifies and submits. "Type anyway"
      // (force) skips only its no-input-box refusal; Enter still waits until the box shows the text.
      const outcome = await api.sendMessage(paneId, { text: t, requestId: delivery.id, ...(force ? { force } : {}) }, session);
      delivery.keep = retryKeepsRequestId(outcome);
      const res: ReplyOutcome = replyOutcomeFrom(outcome, () => detectNoEchoPrompt(splitLines(parseAnsi(text))));
      if (res.status === "sent") {
        pendingDeliveryRef.current = null;
        setDelivering(false);
        // A draft send cleared the composer when it started; a retry from a bubble clears the same
        // message if it had been put back.
        if (draftMessage() === t) clearComposer();
        // An agent without an adapter has no input box Nenu can read back: Enter went out unverified.
        const unverified = !adapter;
        if (started.id) updateLocalSend(sendScope, started.id, { state: "sent", unverified: unverified || undefined });
        // A message starts a turn; a slash command or a picker action may not.
        if (!action && !t.startsWith("/")) stop.turnSent();
        // Remember what/when we sent, so the next few polls recognise this text echoing on the "❯"
        // line as our own in-flight reply rather than a stranded draft (suppressEcho above).
        lastSentRef.current = { text: t, at: Date.now() };
        // The stranded line was just swept and our text sent — mark it handled and drop the preview so
        // it can't flash back before the mirror echoes the cleared line.
        if (effectiveRaw !== null) {
          setHandledKey(normalizeDraft(effectiveRaw));
          setPreviewLatched(false);
        }
        // The ✓ flash on the send button acknowledges a VERIFIED send (the text was seen in the input
        // box before the submit key went out), and the bubble or the "You sent: …" preview keeps the
        // text in view until the transcript catches up, so a plain send needs no toast. One still
        // speaks for what nothing on screen says: an unverified send, and the two actions.
        setJustSent(true);
        if (sentTimer.current) clearTimeout(sentTimer.current);
        sentTimer.current = setTimeout(() => setJustSent(false), 1500);
        // The native picker already shows its own loading state.
        const said = action === "model" ? (nativeWorkbench ? null : "Opening model picker…") : action === "compact" ? "Compaction requested" : unverified ? "Sent, not verified: Nenu can't read this agent's input box." : null;
        if (said) setStatus(said, action === "compact" ? "success" : "info");
        // The conversation view shows the pending bubble instead of this strip.
        setLastSent(action || nativeWorkbench ? null : sentPreview(t));
        if (lastSentTimerRef.current) clearTimeout(lastSentTimerRef.current);
        lastSentTimerRef.current = setTimeout(() => setLastSent(null), 6000);
        forceConfirm.reset(); // a clean send disarms any leftover override
        noticeNoEcho(null); // whatever prompt it described, the pane has moved past it
        if (action !== "model") onSent();
        return true;
      } else if (res.status === "blocked") {
        if (action) {
          forceConfirm.reset();
          noticeNoEcho(res.noEcho !== undefined ? { prompt: res.noEcho, typed: false } : null);
          setStatus(res.error || "The agent is not ready for this action.", "error");
          return false;
        }
        // The pre-flight refused: NOTHING was typed. That is usually right (a menu owns the keyboard),
        // but the adapter can only report what it can see, so the user gets a deliberate override —
        // the same two-tap shape as the destructive-send confirm. The second tap skips the pre-flight
        // ONLY; the type-then-verify guard still runs, so Enter is never fired blind either way.
        // Armed, never toggled: a Try again refused the same way offers it again.
        forceConfirm.arm("force");
        setDelivering(false);
        // A password prompt gets the notice AND keeps the override: the notice explains the screen and
        // offers the control that works, the override stays for the case where the detection is wrong.
        noticeNoEcho(res.noEcho !== undefined ? { prompt: res.noEcho, typed: false } : null);
        failSend(started, res.error, res.noEcho !== undefined);
        // The password notice is the one explanation of a no-echo refusal; a toast would repeat it.
        if (res.noEcho === undefined) refused(res.error, false, t, isDraft, true);
        return false;
      } else {
        // "stalled" = the text went into the pane but was never seen in the input box, so NO submit
        // key was sent (a dialog was probably holding focus). "error" with textDelivered = the text
        // may be in the pane, unsubmitted. Either way it may already be typed: the operator checks
        // Terminal rather than resending, which would type a second copy.
        //
        // At a password prompt the notice takes over: a re-send types a second copy of a secret
        // rather than recovering a lost message, and the notice's handoff is what clears it.
        const prompt = res.status === "stalled" ? res.noEcho : undefined;
        const secret = prompt !== undefined;
        noticeNoEcho(secret ? { prompt, typed: true } : null);
        const delivered = res.status === "stalled" || res.textDelivered === true;
        failSend(started, res.error, secret, delivered);
        setDelivering(false);
        // A toolbar action is not a message: its failure is a toast, with nothing to "try again".
        if (action) setStatus(res.error, "error");
        else if (!secret) refused(res.error, delivered, t, isDraft);
        return false;
      }
    } catch (e) {
      // The answer was lost after the request went out (network drop, timeout, 5xx): the bridge may
      // already have typed and submitted it. Keep the request id so a retry replays that outcome
      // instead of typing a second copy, and point the operator at Terminal rather than a resend.
      const unknown = posted && !api.isDefiniteRefusal(e);
      if (unknown) delivery.keep = true;
      const error = unknown ? "No answer from Nenu, so the message may already be sent. Check Terminal before sending again." : e instanceof Error ? e.message : String(e);
      failSend(started, error, false, unknown);
      setDelivering(false);
      if (action) setStatus(error, "error");
      else refused(error, unknown, t, isDraft);
      return false;
    } finally {
      setSending(false);
    }
  }

  /** Say a refused send above the box. Try again is offered only while resending cannot type a
   *  second copy, and only when the message is still where the operator left it. */
  function refused(error: string, delivered: boolean, text: string, isDraft: boolean, overridable = false) {
    const inPlace = !isDraft || draftMessage() === text;
    setFailure({
      error,
      delivered,
      hint: delivered ? "Check the terminal before sending again." : undefined,
      overridable,
      quote: isDraft ? undefined : text,
      retry: !delivered && inPlace ? { text, isDraft } : null,
    });
  }

  /** A refused draft goes again the way Send sends it, guards and all; a quick reply as it was tapped. */
  function retryFailed() {
    const retry = failure?.retry;
    if (!retry) return;
    if (retry.isDraft) sendDraft();
    else void send(retry.text, false);
  }

  /** Never send a message without an image the operator attached to it. */
  function attachmentsSettled(): boolean {
    if (attachments.uploading) {
      setStatus("Wait for the image to finish uploading.", "info");
      return false;
    }
    if (attachments.failed) {
      setStatus("An image didn't upload. Tap it to retry, or remove it.", "error");
      return false;
    }
    return true;
  }

  // Send the draft through the destructive-input confirm: a matching command arms the "Really send?"
  // state instead of sending; the confirming second tap goes through. Non-destructive input sends
  // immediately (and any stray armed state is cleared).
  function sendDraft() {
    if (!attachmentsSettled()) return;
    const command = commands.find((candidate) => candidate.command === input.trimStart().split(/\s/, 1)[0]);
    const reason = isDestructiveInput(input) ?? (command?.dangerous ? command.command : null);
    if (reason && !sendConfirm.confirm("send")) {
      setStatus(`${reason} — tap Send again to confirm`, "info");
      return;
    }
    sendConfirm.reset();
    void send(draftMessage(), true);
  }

  function onSendClick() {
    // An armed override takes precedence: this tap IS the deliberate "type anyway", so it skips the
    // destructive re-confirm (already answered on the tap that got blocked) and the pre-flight.
    // Only Send's slot offers it; Try again is the ordinary send.
    if (forceConfirm.pending === "force") {
      if (!attachmentsSettled()) return;
      forceConfirm.reset();
      void send(draftMessage(), true, true);
      return;
    }
    sendDraft();
  }

  // The bubbles' buttons. A queued message is handled through its server queue row; a failed one
  // locally. Edit puts the message back into the composer for another go.
  const queueRow = (echo: LocalSend): QueueMessage | undefined =>
    echo.queueId ? queue.page?.messages.find((message) => message.id === echo.queueId) : undefined;
  const bubbleActions = useRef<LocalSendActions | null>(null);
  bubbleActions.current = {
    retry: (echo) => { if (!sending) void send(echo.text, false); },
    edit: async (echo) => {
      const row = echo.state === "queued" ? queueRow(echo) : undefined;
      if (row && !(await queue.mutate("remove", undefined, row))) return;
      removeLocalSend(sendScope, echo.id);
      restoreIntoComposer(echo.text);
      focusInputEnd();
    },
    remove: async (echo) => {
      const row = queueRow(echo);
      if (row && !(await queue.mutate("remove", undefined, row))) return;
      removeLocalSend(sendScope, echo.id);
    },
    sendNow: (echo) => {
      const row = queueRow(echo);
      if (row) void queue.mutate("send", undefined, row);
    },
    readNow: (echo) => { if (echo.queueId) readNow(echo.queueId); },
    openTerminal: () => setRawTerminal(true),
  };
  useEffect(() => {
    if (!nativeWorkbench || locked) return;
    setLocalSendActions(sendScope, {
      retry: (echo) => bubbleActions.current?.retry(echo),
      edit: (echo) => bubbleActions.current?.edit(echo),
      remove: (echo) => bubbleActions.current?.remove(echo),
      sendNow: (echo) => bubbleActions.current?.sendNow(echo),
      readNow: (echo) => bubbleActions.current?.readNow(echo),
      openTerminal: (echo) => bubbleActions.current?.openTerminal(echo),
    });
    return () => setLocalSendActions(sendScope, null);
  }, [sendScope, nativeWorkbench, locked]);
  // The queue strip lists only what has no bubble in the conversation, so nothing shows twice.
  const echoed = new Set(localSends.map((echo) => echo.queueId).filter(Boolean));
  const strayQueue = (queue.page?.messages ?? []).filter((message) => !echoed.has(message.id));
  const strayDelivered = queue.delivered.filter((row) => row.native === "enqueued" && !echoed.has(row.id));

  const confirmingSend = sendConfirm.pending === "send";
  const forcingSend = forceConfirm.pending === "force";

  // Coalesce revalidations from a burst of key presses, LEADING edge first: the first press in a
  // burst refetches immediately, and only presses that arrive inside the window collapse into one
  // trailing refetch. It used to be trailing-only, which meant a lone press — the common case — sat
  // out the full window before its fetch even *started*, and if that fetch then beat the TUI's
  // repaint you waited a whole 1.5s poll to see anything. Arrow-key spam still coalesces exactly as
  // before: presses 2..n only ever schedule the one trailing refetch.
  function scheduleKeyRevalidate() {
    if (keyRevalidateTimer.current === null) {
      revalidator.revalidate(); // leading edge
      // Cooldown only — it fires nothing itself; a press landing before it expires replaces it with
      // the trailing refetch below.
      keyRevalidateTimer.current = setTimeout(() => {
        keyRevalidateTimer.current = null;
      }, KEY_REVALIDATE_MS);
      return;
    }
    clearTimeout(keyRevalidateTimer.current);
    keyRevalidateTimer.current = setTimeout(() => {
      keyRevalidateTimer.current = null;
      revalidator.revalidate(); // trailing edge — one refetch for the whole burst
    }, KEY_REVALIDATE_MS);
  }

  // Raw key send (nav tray). Resolves the bridge's verdict so the pressed button can echo it — the
  // mirror is still the source of truth for what the key DID, but it can be ~2s behind, and this
  // path used to be silent on success, so a press looked like it went nowhere. Errors still go to
  // the status channel; the echo just falls back to idle.
  async function pressKeys(k: string[]): Promise<boolean> {
    if (locked) return false;
    try {
      const res = await api.sendKeys(paneId, k, session);
      if (!res.ok) {
        setStatus(res.error ?? "Key send failed", "error");
        return false;
      }
      scheduleKeyRevalidate();
      return true;
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), "error");
      return false;
    }
  }

  // Insert "/cmd " into the composer (arg-taking commands) and focus it. Appends to any draft already
  // typed (with a separating space) rather than clobbering it; an empty draft just gets set.
  function insertCommand(value: string) {
    direct.deactivate();
    updateInput((prev) => (prev.trim() ? `${prev.trimEnd()} ${value}` : value));
    focusInputEnd();
  }

  // Attach images: picker (multi-select), clipboard paste and drag-and-drop all land here. Each one
  // uploads straight away and shows as a chip; the paths join the text only when the message is sent.
  function attachFiles(files: Iterable<File>) {
    if (locked || direct.active) return;
    setFailure(null); // the draft changed, so the refusal no longer describes it
    const skipped = attachments.add(files);
    if (skipped > 0) setStatus(`${skipped} file${skipped === 1 ? "" : "s"} skipped. Only images, up to 10 per message.`, "info");
    focusInputEnd();
  }

  function onPickImage(e: ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    e.target.value = ""; // allow re-picking the same file
    attachFiles(files);
  }

  // Paste an image straight from the clipboard (e.g. a screenshot) the same way the picker does.
  // Only intercepts when the clipboard actually carries an image file — a plain text paste (the
  // common case) falls through untouched.
  function onPasteImage(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (locked || direct.active) return;
    const items = e.clipboardData.items;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const file = item.kind === "file" && item.type.startsWith("image/") ? item.getAsFile() : null;
      if (file) files.push(file);
    }
    if (!files.length) return;
    e.preventDefault();
    attachFiles(files);
  }

  // The secondary controls, published to the header menu. Their handlers read the latest render
  // through a ref, so the list is re-published only when something a menu row shows has changed.
  const toggleDock = (dock: Exclude<ComposerDrawer, null>) => requestDrawer(drawer === dock ? null : dock);
  const controlActions = useRef({ toggleDock, type: () => {}, photo: () => {} });
  controlActions.current = {
    toggleDock,
    type: () => {
      if (direct.active) {
        direct.deactivate();
        return;
      }
      // The mode needs the phone keyboard, and a dock holding half the viewport is in its way.
      // Routed through requestDrawer so a staged key queue still gets its discard confirm (ADR 0005).
      requestDrawer(null);
      direct.activate();
    },
    // Synchronous inside the row's click, so the browser still counts it as the user's gesture.
    photo: () => fileRef.current?.click(),
  };
  const dockControl = (id: "keys" | "quick" | "display" | "usage", disabled: boolean) => ({
    disabled, on: drawer === id, run: () => controlActions.current.toggleDock(id),
  });
  const controls: ComposerControl[] = [
    { id: "photo", group: "Attach", label: "Photo", icon: ImagePlus, disabled: locked || direct.active, run: () => controlActions.current.photo() },
    { id: "quick", group: "Replies", label: "Quick replies", icon: Zap, ...dockControl("quick", locked) },
    ...(commands.length > 0 ? [{ id: "commands", group: "Replies", label: "Commands", icon: Slash, disabled: locked, on: drawer === "cmd", run: () => controlActions.current.toggleDock("cmd") } as const] : []),
    { id: "keys", group: "Terminal", label: "Keys", icon: Keyboard, ...dockControl("keys", locked) },
    // Arming stays an explicit named choice (use-direct-typing.ts); the row only moved.
    { id: "type", group: "Terminal", label: "Type into terminal", icon: Terminal, disabled: locked || sending, on: direct.active, run: () => controlActions.current.type() },
    ...(usageControls ? [{ id: "usage", group: "Session", label: "Context and usage", icon: Gauge, ...dockControl("usage", false) } as const] : []),
    { id: "display", group: "View", label: "Display", icon: Settings2, ...dockControl("display", false) },
  ];
  const latestControls = useRef(controls);
  latestControls.current = controls;
  useEffect(() => {
    onControlsChange?.(latestControls.current);
  }, [onControlsChange, drawer, direct.active, locked, sending, commands.length, Boolean(usageControls)]);
  const menuGroups: ConversationActionGroup[] = MESSAGE_GROUPS.map((group) => ({
    label: group,
    actions: controls.filter((control) => control.group === group),
  }));
  const [menuOpen, setMenuOpen] = useState(false);
  // The menu hangs from the box's leading column, which spans the box's full height: anchored there,
  // it opens above the box's top edge however tall the draft has grown, and never over the draft.
  const menuAnchorRef = useRef<HTMLDivElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const menuRowsRef = useRef<HTMLDivElement>(null);
  // A lock or another pane takes the menu down; unlocking must not bring it back by itself.
  useEffect(() => setMenuOpen(false), [lockedOut, paneId, session]);
  // Open, the menu holds focus on its first row, as a dialog does, so the rows are a Tab away.
  useEffect(() => {
    if (menuOpen) menuRowsRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [menuOpen]);
  function toggleMenu() {
    // On a phone the keyboard goes down and the menu gets the screen, as in Messages. Safari on iOS
    // does not focus a tapped button, so the draft is let go here rather than by the tap.
    if (!menuOpen) inputRef.current?.blur();
    setMenuOpen(!menuOpen);
  }
  function closeMenu(returnFocus: boolean) {
    setMenuOpen(false);
    if (returnFocus) plusRef.current?.focus({ preventScroll: true });
  }

  const [dragging, setDragging] = useState(false);
  const dropHandlers = locked || direct.active ? {} : {
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      setDragging(false);
      attachFiles(e.dataTransfer.files);
    },
  };

  return (
    <>
      <div {...dropHandlers} className={cn("composer-surface", dragging && "composer-dragging")}>
        {/* The conversation view narrates delivery on the message's own bubble instead. */}
        {delivering && !lastSent && !nativeWorkbench && (
          <div className="mb-1 flex min-h-7 items-center gap-1.5 px-1 text-footnote text-muted-foreground" role="status" aria-live="polite">
            <Loader2 className="size-3 shrink-0 animate-spin" />
            <span>Sending…</span>
          </div>
        )}
        {/* Pending-send preview: visible from send until the mirror echoes back (or 6s). Shows the
            user what landed so they don't double-tap while waiting for the terminal to update. */}
        {lastSent && (
          <div className="mb-2 flex items-center gap-1.5 rounded-md bg-muted/40 px-2.5 py-1.5 text-footnote text-muted-foreground">
            <Loader2 className="size-3 shrink-0 animate-spin" />
            <span className="truncate">
              <span className="font-medium">You sent:</span> {lastSent}
            </span>
          </div>
        )}

        {/* File input stays mounted here, outside the + menu, so the picker callback survives the
            menu closing. The menu's Photo row fires it inside its own tap. */}
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={onPickImage} />
        {/* Keys / Quick / Display / Usage dock — one in-flow site above the input, so the panel
            grows over the conversation, not the draft. Whichever of the mutually exclusive drawers is
            active renders here via the shared ComposerDock chrome. Keys mounts the NavTray (unmounts on
            close, so tab/queue reset each open). Commands stays a covering BottomSheet below (it's a
            palette, not a pad). */}
        {drawer === "usage" && usageControls && (
          <ComposerDock title="Context and usage" onClose={closeDrawer}>
            <div className="px-3 pb-3">{usageControls}</div>
          </ComposerDock>
        )}
        {drawer === "keys" && (
          <ComposerDock title="Keys" onClose={closeDrawer}>
            <NavTray
              onSend={pressKeys}
              presets={keyPresets}
              onQueueChange={setQueuedKeys}
              disabled={locked}
            />
          </ComposerDock>
        )}
        {drawer === "quick" && (
          <ComposerDock title="Quick replies" onClose={closeDrawer}>
            <QuickActionsContent
              onSend={(t) => send(t, false)}
              onClose={closeDrawer}
              agent={agent}
              isShell={isShell}
              disabled={locked || sending}
            />
          </ComposerDock>
        )}
        {drawer === "display" && (
          <ComposerDock title="Display" onClose={closeDrawer}>
            <DisplayPrefsContent
              surface={nativeWorkbench ? "chat" : "terminal"}
              prefs={prefs}
              setWrap={setWrap}
              stepFontSize={stepFontSize}
              setTapToFocus={setTapToFocus}
            />
          </ComposerDock>
        )}
        {/* Terminal-draft preview: a read-only view of a stranded "❯"-line draft (a message queued
            then recalled on the HOST, which stripChrome hides from the mirror). It appears only after
            the draft stabilises (never a blip/self-echo), then its text tracks the live line — host
            typing streams straight in. It NEVER writes into the phone-owned input; only the explicit
            Take over copies the text here. No dismiss — it's honest state and persists until the user
            takes over, sends, or the host line clears. Same quiet chrome as the "You sent:"
            strip above. */}
        {showPreview && effectiveRaw !== null && (
          <TerminalDraftPreview
            text={effectiveRaw}
            // No Take over when the line is only the harness's own opaque token (Claude's
            // `[Pasted text #N +M lines]`): pulling that into the composer would send the literal
            // string. The preview keeps showing it — the screen really does say that.
            onTakeOver={adapter?.draftIsOpaque?.(effectiveRaw) ? null : takeOverDraft}
          />
        )}
        {/* The password-prompt notice (#103). Sits here, in the same in-flow slot as the other two
            strips, because that is where the eye already is when a send is refused — and it is a
            NOTICE beside the unchanged "Type anyway?" override, never a replacement for it. */}
        <Fold value={!direct.active && noEcho}>{(noEcho) => (
          <NoEchoNotice
            prompt={noEcho.prompt}
            typed={noEcho.typed}
            // Withdrawn, not disabled, when the mode can't be armed at all: a gone pane, a read-only
            // device, the idle pause. Offering a control that would refuse is worse than offering none.
            onUseType={
              locked
                ? null
                : () => {
                    // The draft is a password we know the pane never accepted, and it is already in
                    // localStorage. Clear it BEFORE arming — both because leaving a secret in a 48h
                    // store is the leak this issue asked about, and because `activate` refuses while
                    // any draft is present, which would make the offered remedy fail on the spot.
                    updateInput("");
                    requestDrawer(null);
                    direct.activate();
                  }
            }
            onDismiss={() => noticeNoEcho(null)}
            overrideOffered={forcingSend}
          />
        )}</Fold>
        {/* Armed indicator for direct typing. In the same in-flow slot as the "You sent:" strip,
            deliberately NOT only on the button and textarea — see the component. */}
        {direct.active && <DirectTypingStrip onStop={() => direct.deactivate()} />}
        {/* A draft too large for the disk tier (lib/drafts.ts). It survives a pane switch — the
            memory tier holds it whole — but not the app closing, and that difference is invisible
            without saying so: the old behaviour silently restored an OLDER, SHORTER draft instead.
            Derived at render rather than pushed through setStatus, because this is a CONDITION that
            lasts as long as the text does, and a status auto-clears in 2.5s and would re-fire on
            every keystroke. Self-clearing: trim the draft or send it and the row is simply gone. */}
        {/* While nothing else names the outage, this line does, or Send sits disabled with nothing
            saying why. Never the placeholder: with "Drafts are kept." it took two lines at 375 px,
            and Safari cuts a placeholder at the box's one-line height. A draft hides the placeholder,
            so the line then says what the box keeps too. */}
        {outageUnnamed && (
          <p className="px-1 pb-1 text-footnote text-muted-foreground">
            {herdrLock && !lockedOut && input !== "" ? "Herdr isn't responding. Drafts are kept." : "Herdr isn't responding."}
          </p>
        )}
        {!direct.active && !fitsDraftStore(input) && (
          <p className="px-1 pb-1 text-footnote text-muted-foreground">
            Too long to keep as a saved draft — it survives switching panes, but not closing the app.
          </p>
        )}
        <Fold value={busyPick && busyChoice}>{(choice) => <BusyChoicePanel choice={choice} onPick={pickBusy} onCancel={() => setBusyPick(null)} />}</Fold>
        {nativeWorkbench && (
          <MessageQueueStrip
            agent={agent}
            messages={strayQueue}
            delivered={strayDelivered}
            busy={queue.busy || disconnected}
            error={queue.error || (disconnected ? "" : queue.refreshError)}
            change={queue.mutate}
            readNow={readNow}
            readNowArmed={readNowConfirm.pending}
          />
        )}

        <Fold value={failure}>{(failure) => (
          <ComposerNotice
            icon={CircleAlert}
            tone="error"
            title={failure.delivered ? "Not confirmed" : "Not sent"}
            onDismiss={() => setFailure(null)}
            actions={(failure.retry || nativeWorkbench) && <>
              {failure.retry && <Button variant="secondary" size="sm" className="hit-area h-8 coarse:h-9" onClick={retryFailed} disabled={locked || sending}>Try again</Button>}
              {nativeWorkbench && <Button variant="ghost" size="sm" className="hit-area h-8 coarse:h-9" onClick={() => setRawTerminal(true)}>Open terminal</Button>}
            </>}
          >
            {failure.quote && <p className="truncate text-foreground">{failure.quote}</p>}
            <p>{failure.error}</p>
            {failure.hint && <p className="mt-1">{failure.hint}</p>}
            {/* Said only while the override is there to tap: it lapses long before the notice does. */}
            {failure.overridable && forcingSend && <p className="mt-1">To type it regardless, tap Type anyway.</p>}
          </ComposerNotice>
        )}</Fold>
        {/* Stop lives on the row above the box for the whole turn, and never in the Send slot: a draft
            appearing or clearing must not move the target under the thumb. The conversation's live
            turn already says "Working for …" just above, so only the terminal view repeats it here. */}
        <Fold value={stop.offered}>{() => (
          <div role="group" aria-label="Agent working" className="composer-working">
            {!nativeWorkbench && <span className="min-w-0 flex-1"><WorkActivityLabel startedAt={workingSince} /></span>}
            <StopControl stop={stop} disabled={locked} />
          </div>
        )}</Fold>
        <AttachmentChips items={attachments.items} onRemove={attachments.remove} onRetry={attachments.retry} disabled={locked} />
        {/* One rounded box: the + leads, the draft grows upward to its cap, and Send's slot closes
            it (Send or its confirm pill; Stop has the row above). Quiet controls live in the row
            below it. */}
        <div className="relative">
          {skills.open && (skills.skills.length === 0 && (skills.loading || skills.error) ? (
            <div className="absolute inset-x-0 bottom-full z-30 mb-2 rounded-xl border border-border bg-popover px-3 py-3 text-footnote text-muted-foreground shadow-lg" role="status">
              {skills.loading ? "Loading skills…" : <span>Couldn't load skills. <button type="button" className="min-h-11 px-2 underline" onMouseDown={(e) => e.preventDefault()} onClick={skills.retry}>Retry</button></span>}
            </div>
          ) : <SkillPicker id={skills.id} skills={skills.skills} total={skills.total} activeIndex={skills.activeIndex} onSelect={skills.select}
            label={skills.label} loading={skills.loading} error={skills.error} truncated={skills.truncated} onRetry={skills.retry} />)}
          <div className={cn("composer-box", direct.active && "composer-box-armed", lockedOut && "composer-box-locked", input !== "" && !direct.active && "composer-box-typing")}>
            {!lockedOut && <div ref={menuAnchorRef} className="composer-lead">
              <button ref={plusRef} type="button" className="composer-plus hit-area" aria-label="Message actions" aria-haspopup="dialog" aria-expanded={menuOpen}
                onClick={toggleMenu}>
                <Plus aria-hidden="true" className="size-5" />
              </button>
              {/* Right after the + in the document, so Shift+Tab from the first row is the + again. It
                  is fixed to the viewport, so where it sits here changes nothing on screen. */}
              <WorkbenchPopover open={menuOpen} onDismiss={(reason) => closeMenu(reason !== "outside")} anchorRef={menuAnchorRef} label="Message actions" className="w-64 [&>div:first-child]:hidden [&>div:last-child]:p-1.5">
                {/* A row that needs the keyboard (Type) focuses the draft itself; the rest leave focus
                    on the + they were opened from. */}
                <div ref={menuRowsRef}><ActionGroups groups={menuGroups} onRun={(run) => { closeMenu(true); run(); }} /></div>
              </WorkbenchPopover>
            </div>}
            <ChatInput
              ref={inputRef}
              value={direct.active ? direct.value : input}
              onChange={direct.active ? direct.onChange : (e) => skills.onChange(e.target.value, e.target.selectionStart)}
              onSelect={(e) => skills.onSelect(e.currentTarget.selectionStart)}
              onFocus={() => { skills.onFocus(); onInputFocus?.(); }}
              onBlur={skills.onBlur}
              aria-autocomplete={skills.open ? "list" : undefined}
              aria-controls={skills.open && (!(skills.loading || skills.error) || skills.skills.length > 0) ? skills.id : undefined}
              aria-activedescendant={skills.open && skills.skills.length > 0 ? `${skills.id}-option-${skills.activeIndex}` : undefined}
              onCompositionStart={direct.active ? direct.onCompositionStart : undefined}
              onCompositionEnd={direct.active ? direct.onCompositionEnd : undefined}
              onKeyDown={
                direct.active
                  ? direct.onKeyDown
                  : (e) => {
                      // The IME owns Enter while committing a word. Safari can expose only 229
                      // on the final event, with isComposing already false.
                      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                      if (skills.onKeyDown(e)) return;
                      // Esc in the empty composer is Stop, as at the terminal. A draft keeps Esc for
                      // the browser, and an open dock or the busy choice keeps it for themselves.
                      if (e.key === "Escape" && onEscape && drawer === null && !busyPick) {
                        e.preventDefault();
                        onEscape();
                        return;
                      }
                      if (e.key === "Escape" && stop.offered && !hasDraft && drawer === null && !busyPick) {
                        e.preventDefault();
                        stop.stop();
                        return;
                      }
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        onSendClick();
                      }
                    }
              }
              onPaste={onPasteImage}
              placeholder={
                gone
                  ? "Pane is gone"
                  : readOnly
                    ? lockReason === "refused" ? "Sign in again to reply" : "Read-only — device not authorised"
                    : disconnected
                      ? !herdrLock ? "Write a draft while reconnecting…" : "Drafts are kept."
                    : direct.active
                      ? "Type into the terminal…"
                      : isShell
                        ? "Type a shell command…"
                        // A dialog owns the agent's keyboard: Send queues behind the answer, or refuses.
                        : dialogPresent
                          ? nativeWorkbench && queue.page?.available ? "Message for after you answer…" : "Answer the agent first…"
                          : placeholder ?? "Type a reply…"
              }
              autoCorrect={direct.active || noEcho ? "off" : undefined}
              spellCheck={direct.active || noEcho ? false : undefined}
              autoComplete={noEcho ? "off" : undefined}
              // While a password prompt is recognised the draft is a secret the pane never took: it is
              // masked on screen as well as kept out of the store (noticeNoEcho). A box nothing can be
              // written into keeps its reason at full strength: the well already says it is off.
              className={cn("composer-input block min-h-11 flex-1 rounded-none border-0 bg-transparent py-2.5 pl-2 pr-1 shadow-none focus-visible:ring-0 text-body md:min-h-10 md:py-2", lockedOut && "pl-3.5 disabled:opacity-100", noEcho !== null && !direct.active && "composer-input-secret")}
              disabled={gone || readOnly}
              rows={1}
            />
            <div className="flex shrink-0 items-center gap-1.5 self-end p-1.5 md:p-1">
            {/* The Send slot holds Send and its confirmations, nothing else; Stop has its own row. */}
            {!direct.active && forcingSend ? (
              // The pre-flight refused and the user is being offered the override. Labelled for what it
              // actually does — TYPE the text into whatever is on screen — not "send", because the
              // submit key is still conditional on the verify step behind it. Beside the password
              // notice it stays put but steps back to outline: that notice's Use Type is the primary.
              <Button
                variant={noEcho !== null ? "outline" : "destructive"}
                className="hit-area h-8 shrink-0 rounded-full px-3 text-footnote font-semibold"
                onClick={onSendClick}
                disabled={locked || !hasDraft || sending}
                aria-label="Type anyway?"
              >
                Type anyway?
              </Button>
            ) : !direct.active && confirmingSend ? (
              <Button
                variant="destructive"
                className="hit-area h-8 shrink-0 rounded-full px-3 text-footnote font-semibold"
                onClick={onSendClick}
                disabled={locked || !hasDraft || sending}
                aria-label="Really send?"
              >
                Really send?
              </Button>
            ) : (
              <Button
                size="icon"
                className="composer-action composer-send hit-area"
                onClick={direct.active ? () => direct.deactivate() : onSendClick}
                disabled={locked || sending || queue.busy || (!direct.active && (!hasDraft || attachments.uploading))}
                aria-label={direct.active ? "Stop typing into terminal" : "Send"}
                aria-pressed={direct.active}
              >
                {direct.active ? (
                  <Keyboard className="size-4" />
                ) : sending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : justSent ? (
                  <Check className="size-4" />
                ) : (
                  <ArrowUp className="size-4" strokeWidth={2.5} />
                )}
              </Button>
            )}
            </div>
          </div>
        </div>
        {(modelControl || processesControl) && (
          <div role="group" aria-label="Message tools" className="composer-meta">
            {modelControl && <div className="flex min-w-0 items-center">{modelControl}</div>}
            <div className="flex-1" />
            {processesControl}
          </div>
        )}
      </div>

      {/* Slash-command palette */}
      <CommandPalette
        open={drawer === "cmd"}
        onClose={closeDrawer}
        agent={agent}
        mine={operatorCommands}
        onInsert={insertCommand}
        onSubmit={(t) => send(t, false)}
      />
    </>
  );
});
