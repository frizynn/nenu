import { useEffect, useRef, useState } from "react";
import type {
  ChangeEvent,
  CompositionEvent as ReactCompositionEvent,
  KeyboardEvent as ReactKeyboardEvent,
  RefObject,
} from "react";

import { useOrderedKeySender } from "@/hooks/use-ordered-key-sender";
import { composeKey, normalizeBaseChar, textToKeySequence, type Modifier } from "@/lib/key-queue";
import { setStatus } from "@/lib/status";

// Physical-keyboard events that do not change a textarea value still need wire names. Printable
// text, spaces and line breaks normally arrive through the input/change path instead. F1–F12 are
// bare names in Herdr's grammar, as the phone's Keys tray sends them.
const SPECIAL_KEYS: Readonly<Record<string, string>> = {
  Escape: "Escape",
  Tab: "Tab",
  Enter: "Enter",
  Backspace: "Backspace",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, `F${i + 1}`])),
};

const BARE_UNDER_SHIFT = new Set(["Enter", "Backspace", "Escape"]);

function keyForInputType(inputType: string): string | null {
  if (inputType === "deleteContentBackward") return "Backspace";
  if (inputType === "insertLineBreak" || inputType === "insertParagraph") return "Enter";
  return null;
}

/**
 * A desk's keyboard carries what the phone's Keys tray sends: a named key keeps the Ctrl and Option
 * held with it (`alt+Left`), and Ctrl with a printable key is that chord (`ctrl+c`). Shift rides only
 * on keys a phone keyboard has no Shift for (`shift+Tab`): its auto-capital must not turn Return into
 * another key. Command stays the browser's (copy, paste, close the tab), and so does Ctrl+V where it
 * is the paste: the pasted text reaches the pane through the change path. Option alone with a
 * printable key types a character on a Mac, so it stays text as well.
 */
function keyForKeyDown(event: Pick<ReactKeyboardEvent, "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): string | undefined {
  const named = SPECIAL_KEYS[event.key];
  if (named !== undefined) {
    const held: Modifier[] = [];
    if (event.ctrlKey) held.push("ctrl");
    if (event.altKey) held.push("alt");
    if (event.shiftKey && !BARE_UNDER_SHIFT.has(named)) held.push("shift");
    return composeKey(held, named);
  }
  if (!event.ctrlKey || event.altKey || event.metaKey || event.key.length !== 1) return undefined;
  const base = normalizeBaseChar(event.key);
  // "+" joins a chord on the wire, so it cannot be a chord's base.
  if (base === null || base === "+" || (base === "v" && !/Mac|iPhone|iPad/.test(navigator.platform))) return undefined;
  return composeKey(event.shiftKey && /[a-z]/.test(base) ? ["ctrl", "shift"] : ["ctrl"], base);
}

interface DirectTypingOptions {
  paneKey: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  canActivate: () => boolean;
  /** What `canActivate` answers, as a value: a terminal view retries arming when it turns true. */
  canArm: boolean;
  /** True while the view the mode belongs to has stopped being live: a gone pane, a read-only
   *  device, or the idle pause. Arming survives none of them — see the disarm effect below. */
  suspended: boolean;
  /** A terminal view is on screen (the chat's Terminal view, or a desk's Terminal tab): the box is the
   *  terminal while it is, unless the operator turned that off in this view (ADR 0114). */
  auto: boolean;
  /** Whether arming by `auto` takes focus: on a desk, so the keys go in at once; never on a phone,
   *  where a keyboard nobody asked for would cover the mirror. */
  autoFocus: boolean;
  sendKeys: (keys: string[]) => Promise<boolean>;
  onActivate: () => void;
  focusInput: () => void;
}

// The composer textarea's direct-terminal mode: what you type goes to the pane as keystrokes,
// with no trailing Enter. This hook owns the armed state, the transient Android IME composition
// value, the pane-boundary reset, special-key capture, and the lifecycle rules that disarm it.
// Transport ordering stays in useOrderedKeySender so this hook never permits concurrent one-shot
// Herdr writes.
//
// Arming is a choice the operator can read on screen, never a gesture: the "Type into terminal" row
// in the composer's + menu on a phone, the switch of that name in a desk's Terminal tab, or a
// terminal view itself (`auto`): while the chat's Terminal view or a desk's Terminal tab is on screen,
// the box is that terminal, and leaving the view gives the chat its box back (ADR 0114, amending
// ADR 0077 and ADR 0079). The chat's draft is never touched: it waits in the store and comes back
// with the chat. Turned off by the operator inside a view, the mode stays off until the view is
// left and entered again.
//
// WHY NOT A GESTURE. The submitted version of this feature armed the mode on a bare long press of the
// Send button. That reads as a saving of one tap, but the tap is priced per SESSION, not per
// keystroke: you arm once and then type many keys. What it actually buys is an accidental hold — a
// pocket, a fumbled scroll, a hesitation over Send with a destructive command in the box — silently
// pointing the phone keyboard at a live terminal with nothing on screen having asked. This surface's
// safety story is "you see what is about to go on the wire" (ADR 0005). A terminal view keeps it: the
// pane is what the screen shows, and the box says it types there. Don't reintroduce a hold.
//
// WHY THE MODE DIES WITH THE VIEW. What stands in for a review step here is that you are LOOKING at
// the pane while you type into it — this is the one write path with no reviewable payload, by design
// (reviewing each keystroke would defeat it). That condition can quietly stop being true: the mirror
// is polled, and the poll stops on an idle pause (ADR 0007), on a backgrounded tab, on a pane going
// away. Hence the disarms below. Never persisted: a terminal view arms it again only while it is on
// screen and live.
//
// Two apparent omissions that are deliberate. A lost connection is NOT a separate trigger — it
// surfaces as a failed batch, which already disarms, observed directly rather than inferred from a
// timer. And the reply guard's `composerReady` pre-flight is NOT run on these keystrokes: it refuses
// to type into an unrecognised screen, and typing into an unrecognised screen is the whole point.
// Don't "harden" this path by adding it.
export function useDirectTyping({
  paneKey,
  inputRef,
  canActivate,
  canArm,
  suspended,
  auto,
  autoFocus,
  sendKeys,
  onActivate,
  focusInput,
}: DirectTypingOptions) {
  const [active, setActive] = useState(false);
  const [value, setValue] = useState("");
  // Live read for the visibility listener below, which outlives any one armed session. Written at
  // the transitions themselves, not during render: the listener fires between renders, and a ref
  // that only catches up on the next one would let it misread which state it is reporting on.
  const activeRef = useRef(false);
  const autoRef = useRef(auto);
  autoRef.current = auto;
  const backgrounded = useRef(false);
  const composing = useRef(false);
  const committedComposition = useRef<string | null>(null);
  const pendingBlur = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The operator turned the mode off inside a terminal view; entering a view again clears it.
  const optedOut = useRef(false);
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const sender = useOrderedKeySender(sendKeys, () => {
    resetMode();
    // A failed batch is the connection's word, not the view's: a terminal view on screen stays off
    // until it is entered again. Armed from the + with no view, there is nothing to keep off.
    if (autoRef.current) optedOut.current = true;
    // Stop the phone keyboard too: otherwise continued typing after a transport failure silently
    // becomes a buffered Reply, which is a different action with an eventual Enter attached.
    dropKeyboard();
  });

  function activate(focus = true) {
    if (!canActivate()) return;
    // The reply draft stays where it is, in the composer's state and store; the field shows the
    // terminal's keystrokes instead until the mode ends.
    optedOut.current = false;
    onActivate();
    // A new armed session owns the field from here: any blur still pending belongs to an older one,
    // and this cancellation is what keeps it from landing on the session that replaced it.
    cancelPendingBlur();
    setValue("");
    composing.current = false;
    committedComposition.current = null;
    activeRef.current = true;
    setActive(true);
    if (!focus) return;
    // No toast: the armed strip above the composer says it, and stays while the mode does.
    // Focus synchronously while the tap on "Type into terminal" (the + row, or the desk's switch)
    // still carries browser user activation; a deferred focus selects the field but mobile browsers may refuse to
    // open their software keyboard once that activation has expired. The existing callback still runs after
    // React swaps the controlled value so selection lands at the end.
    inputRef.current?.focus({ preventScroll: true });
    focusInput();
  }

  /** Disarm and forget the transient state. Leaves the field alone — callers decide about focus. */
  function resetMode() {
    activeRef.current = false;
    setActive(false);
    setValue("");
    composing.current = false;
    committedComposition.current = null;
  }

  function clearMode() {
    resetMode();
    focusInput();
  }

  function cancelPendingBlur() {
    if (pendingBlur.current === null) return;
    clearTimeout(pendingBlur.current);
    pendingBlur.current = null;
  }

  /**
   * Put the phone keyboard away after a disarm the user did not ask for.
   *
   * Deferred, because focusInputEnd() is itself a `setTimeout` and a synchronous blur here is
   * simply undone by a focus already queued behind it. Deferring means the blur can outlive the
   * disarm that scheduled it, so ownership is settled by CANCELLATION rather than by a token:
   * everything that STARTS OR RETARGETS a session — a re-arm (activate), a pane change, unmount, a
   * second disarm — cancels the pending blur first. An old disarm therefore never reaches a live
   * session, because it no longer exists by the time one begins.
   *
   * Do not read that as "every path that focuses the field cancels": three don't, and don't need to.
   * `deactivate`/`clearMode`, the `suspended` disarm, and the composer's own takeOverDraft /
   * insertCommand / uploadImage all focus without cancelling — they are safe because a blur is only
   * ever pending while the mode is DISARMED (both schedulers call resetMode() in the same frame, and
   * the first two gate on `active`), and because their focus is itself deferred, so it queues behind
   * any pending blur and lands last.
   */
  function dropKeyboard() {
    cancelPendingBlur();
    pendingBlur.current = setTimeout(() => {
      pendingBlur.current = null;
      inputRef.current?.blur();
    }, 0);
  }

  /** Disarm on the operator's own tap. Silent: the strip going away and the placeholder say it. */
  function deactivate() {
    if (auto) optedOut.current = true;
    clearMode();
  }

  // Arming dies with the view it belongs to. A backgrounded tab, an idle pause and a lost bridge
  // all mean the same thing: the mirror on screen has stopped tracking the pane, and the next
  // keystroke would go into a terminal the user is no longer actually looking at. Disarm rather
  // than hold the mode open across the gap — the cost is one re-arm, the alternative is typing
  // blind. Never persisted, never restored — see the lifecycle note at the top of this file.
  useEffect(() => {
    if (!active || !suspended) return;
    clearMode();
    if (!autoRef.current) setStatus("Stopped typing into the terminal — the pane view was interrupted.", "info");
  }, [active, suspended]);

  // The backgrounded-tab disarm has to announce itself on the way BACK, not on the way out. A
  // status set while the document is hidden is gone before anyone can read it (lib/status.ts
  // auto-clears non-errors after 2.5s), so the old silent clearMode() produced the one genuinely
  // confusing failure this mode has: you switch apps mid-command, return to a still-focused field
  // with the keyboard still up, and the next characters land in the REPLY DRAFT instead of the
  // terminal — a different action, with an eventual Enter attached. Deferring the message to the
  // next visible event is what makes that state readable.
  //
  // Mounted for the hook's whole life, NOT keyed on `active`: hiding the document is what disarms,
  // so an effect keyed on `active` tears its own listener down in the same commit and the return
  // trip has nobody left to report it. The armed state is read through a ref for the same reason.
  useEffect(() => {
    const onVisibility = () => {
      setVisible(document.visibilityState !== "hidden");
      if (document.visibilityState === "hidden") {
        if (!activeRef.current) return;
        backgrounded.current = true;
        resetMode();
        // Put the keyboard away rather than hand the field back focused. The notice below is the
        // only thing telling you the mode is gone, and it expires; a primed field outlasts it, and
        // typing into it is exactly the mistake being warned about.
        dropKeyboard();
        return;
      }
      if (!backgrounded.current) return;
      backgrounded.current = false;
      // A terminal view arms it again on the way back (above); nothing stopped from the operator's side.
      if (autoRef.current) return;
      setStatus("Stopped typing into the terminal — the app was backgrounded.", "info");
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Direct input never crosses a pane boundary. Reset also invalidates keys accumulated behind an
  // in-flight call; the call already on the wire captured the old pane and cannot be recalled.
  useEffect(() => {
    resetMode();
    // The new pane's field is not the one that disarm was about — neither the blur it scheduled nor
    // the notice it owes. Dropping the debt matters because a pane can change WHILE hidden: a push
    // notification deep-links into another pane, and without this the return trip announces "the app
    // was backgrounded" over a pane the mode was never armed on.
    cancelPendingBlur();
    backgrounded.current = false;
    optedOut.current = false;
    sender.reset();
  }, [paneKey, sender.reset]);

  useEffect(() => cancelPendingBlur, []);

  // A terminal view arms the box while it is on screen and live, and gives it back when it goes,
  // without taking focus. Declared after the pane-boundary reset, so a new pane's view arms again. A
  // re-arm after a pause or a hidden page is the view coming back, so it says nothing.
  const autoWas = useRef(false);
  useEffect(() => {
    const was = autoWas.current;
    autoWas.current = auto;
    if (!auto) {
      optedOut.current = false;
      if (was && activeRef.current) resetMode();
      return;
    }
    if (activeRef.current || optedOut.current || suspended || !visible || !canArm) return;
    activate(autoFocus);
  }, [auto, suspended, visible, paneKey, canArm]);

  // Android virtual Backspace/Enter can arrive as beforeinput without a useful keydown. A native
  // listener is intentional: React's synthetic beforeinput omits these events on some engines.
  useEffect(() => {
    const inputEl = inputRef.current;
    if (!active || inputEl === null) return;
    const onBeforeInput = (event: InputEvent) => {
      const key = keyForInputType(event.inputType);
      if (key === null) return;
      // Backspace inside an active IME edits the candidate; Enter commits/submits and must still reach
      // the terminal. Gboard commonly marks that insertParagraph event as composing.
      if (event.isComposing && key === "Backspace") return;
      event.preventDefault();
      sender.enqueue([key]);
    };
    inputEl.addEventListener("beforeinput", onBeforeInput);
    return () => inputEl.removeEventListener("beforeinput", onBeforeInput);
  }, [active, inputRef, sender.enqueue]);

  function onChange(event: ChangeEvent<HTMLTextAreaElement>) {
    const next = event.target.value;
    setValue(next);
    const inputEvent = event.nativeEvent as InputEvent;
    if (inputEvent.isComposing || composing.current) return;

    // Gboard can follow compositionend with one ordinary input carrying the same committed word.
    // Drop that prefix rather than sending a swipe twice, while preserving any suffix typed in the
    // same event (commonly the auto-inserted space before the next swiped word).
    const committed = committedComposition.current;
    if (committed !== null) {
      committedComposition.current = null;
      const remainder = next.startsWith(committed) ? next.slice(committed.length) : next;
      if (remainder.length > 0) sender.enqueue(textToKeySequence(remainder));
      setValue("");
      return;
    }

    if (next.length === 0) return;
    sender.enqueue(textToKeySequence(next));
    setValue("");
  }

  function onCompositionStart() {
    composing.current = true;
    committedComposition.current = null;
  }

  function onCompositionEnd(event: ReactCompositionEvent<HTMLTextAreaElement>) {
    composing.current = false;
    const committed = event.currentTarget.value || event.data;
    if (committed.length === 0) return;
    committedComposition.current = committed;
    sender.enqueue(textToKeySequence(committed));
    setValue("");
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    const key = keyForKeyDown(event);
    if (key === undefined) return;
    event.preventDefault();
    sender.enqueue([key]);
  }

  return {
    active,
    value,
    busy: sender.busy,
    activate,
    deactivate,
    onChange,
    onCompositionStart,
    onCompositionEnd,
    onKeyDown,
  };
}
