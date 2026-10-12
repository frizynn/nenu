import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, Ref } from "react";
import { AlertCircle, AlertTriangle, Check, ChevronLeft, ChevronRight, Keyboard, Loader2, MessageSquareText, RefreshCw, TerminalSquare } from "lucide-react";

import { MarkdownText } from "@/components/markdown-text";
import {
  DIALOG_CARD, OPTION_LIST, OptionCheckbox, OptionDescription, OptionLabel, OptionList, optionRow, QuestionHeading, SECONDARY_ACTION,
  SecondaryActions, WaitingOnYou,
} from "@/components/option-button";
import { Button } from "@/components/ui/button";
import { useOutageNoticeShown } from "@/lib/connection-health";
import { isToggle, type AnswerExtra, type Receipt } from "@/hooks/use-interactions";
import { FEEDBACK_MAX_LENGTH } from "@/lib/prompt-action";
import type {
  AnswerOutcome,
  BridgeStatus,
  Interaction,
  InteractionAnswer,
  InteractionKind,
  InteractionOption,
  InteractionStep,
  InteractionSubject,
} from "@/lib/types";
import { cn } from "@/lib/utils";

// One card for every dialog the bridge detected (ADR 0057): the newest line of a thread, and compact
// on Home. A tap is one POST naming the option by index; the bridge re-reads the screen, refuses a
// stale signature and owns every key. Text stays React text nodes (the XSS boundary).

/** How long a persistent option stays armed for its confirming second tap. */
export const CONFIRM_MS = 5_000;

/** Dialogs whose plain options are answers of equal weight, drawn as one list. */
const ANSWER_KINDS = new Set<InteractionKind>(["question", "wizard", "multi-select"]);
/** Rows of a command or file preview shown before "Show all": the thread's own scroll reads the rest. */
const SUBJECT_ROWS = 8;
/** A multi-select's advance that sends the answers, as opposed to a wizard step's Next. */
const SUBMIT = /^submit\b/i;

/**
 * A preview question: the bridge serves Claude's preview-select as a question whose family is the
 * agent, where every other question carries its prompt family ("select"). Its previews and notes live
 * only in the thread. bridge/interactions-family.test.ts pins that convention over the fixture corpus
 * until the bridge marks a preview outright.
 */
const isPreviewQuestion = (i: Interaction) => i.kind === "question" && i.family !== "select";

/** Why answers are paused, so the card names the real cause and never blames the device for an outage. */
export type LockReason = "read-only" | "offline" | "herdr" | "refused";

const LOCK_COPY: Record<LockReason, string> = {
  "read-only": "Read-only on this device. Answer from an authorised one.",
  offline: "Answers are paused until Nenu reconnects.",
  herdr: "Herdr isn't responding. Answers are paused.",
  refused: "Sign in again to answer.",
};
/** Once an outage is sustained the connection banner names it, so the card only says what it means here. */
const PAUSED_UNDER_BANNER = "Answers are paused.";

/** The lock a snapshot implies: a read-only device first, then a refused or failed read, then Herdr itself. */
export function lockReasonOf(s: { readOnly: boolean; error: boolean; authError: boolean; bridge: BridgeStatus | undefined }): LockReason | undefined {
  if (s.readOnly) return "read-only";
  if (s.error) return s.authError ? "refused" : "offline";
  return s.bridge === "connected" ? undefined : "herdr";
}

export interface QuestionCardProps {
  interaction?: Interaction;
  /** Shown instead of a card once the dialog was answered and before the pane's next one. */
  receipt?: Receipt;
  onAnswer: (option: InteractionOption, extra?: AnswerExtra) => Promise<AnswerOutcome>;
  /** Answers are paused for a reason the caller does not name. Prefer `lockReason`. */
  readOnly?: boolean;
  /** Why answers are paused; the card says it and keeps every answer from firing. */
  lockReason?: LockReason;
  /** Why the tap on the dialog this one replaced did nothing ("The question changed…"). */
  refused?: string;
  /** Home's variant: titled by who asks, opened from its header, its details clamped. */
  compact?: boolean;
  /** Who is asking (the pane's name), for a card shown away from its thread. */
  title?: ReactNode;
  /** Where the full dialog lives: the terminal mirror in a thread, the thread from Home (its header). */
  onOpen?: () => void;
  /** The keys pad next to the terminal, for a text row the card cannot type (Home has none: `onOpen` is on the card). */
  onKeys?: () => void;
  /**
   * A permission or plan may be approved only while its whole command, file or plan is on the card;
   * otherwise the card offers `onOpen` instead (ADR 0057 §4). Defaults to on for the compact (Home) card.
   */
  approveNeedsDetail?: boolean;
  /** Home: a tap on this card is opening its thread, whose read is still in flight (SYS-17). */
  opening?: boolean;
}

/** A refusal shown next to what was tapped: `warn` when the question changed, `error` otherwise. A
 *  walk that never reached its row can be tried again. */
type Notice = { tone: "warn" | "error"; text: string; retry?: InteractionOption; at: "options" | "reply" };
/** The text box open on the card: a text row's reply (required), or a note other answers may carry. */
type Writing = { to: "reply"; option: InteractionOption } | { to: "note" } | null;

/** Home's one label for every way into the thread from a card: what you go there to do, and where. */
const TO_THREAD = "Answer in thread";

export function QuestionCard({
  interaction: i, receipt, onAnswer, readOnly = false, lockReason, refused, compact = false, title, onOpen,
  onKeys, approveNeedsDetail = compact, opening = false,
}: QuestionCardProps) {
  const [busy, setBusy] = useState<number | null>(null);
  const [armed, setArmed] = useState<number | null>(null);
  const [writing, setWriting] = useState<Writing>(null);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  // The card that replaced a refused one says why nothing was sent, until the next tap.
  useEffect(() => {
    if (refused) setNotice({ tone: "warn", text: refused, at: "options" });
  }, [refused]);
  const [failed, setFailed] = useState<number | null>(null);
  /** Home: the thread was opened by the card's large primary, so that is what spins, not the header. */
  const [openedByPrimary, setOpenedByPrimary] = useState(false);
  /** The operator unfolded the command or plan. */
  const [opened, setOpened] = useState(false);
  /** Whether this plan text is taller than its fold; unknown until measured, and unknown counts as folded. */
  const [planMeasure, setPlanMeasure] = useState<{ text: string; overflows: boolean } | null>(null);
  /**
   * Whether Home's card cuts any answer's description short, per dialog and card width. Only the answer
   * rows decide it (`on: "answers"`); the read-only list only says when they are worth trying again.
   */
  const [cut, setCut] = useState<{ signature: string; width: number; on: "answers" | "list"; cut: boolean } | null>(null);
  const [frame, setFrame] = useState<HTMLElement | null>(null);
  const [answerList, setAnswerList] = useState<HTMLElement | null>(null);
  // Kept only so a resize renders the card again and the measure below runs.
  const [, setFrameWidth] = useState(0);
  // Whether the banner is on screen (one shared store), so the card and the banner agree.
  const outage = lockReason === "offline" || lockReason === "herdr";
  const bannerUp = useOutageNoticeShown();
  const textId = useId();
  const form = useRef<HTMLFormElement>(null);
  const noticeLine = useRef<HTMLParagraphElement>(null);
  const detail = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!compact || !frame || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setFrameWidth(frame.clientWidth));
    observer.observe(frame);
    return () => observer.disconnect();
  }, [compact, frame]);

  // An answer is never chosen on Home without what it means: if the card clamps a description, the
  // answers move to the thread, where the whole text is (DLG-10). A new width (a rotation, a narrower
  // window) measures again, so a card that fits answers again and one that no longer fits stops.
  useLayoutEffect(() => {
    if (!compact || !i || !answerList || !frame) return;
    const on = answerList.hasAttribute("data-answers") ? "answers" : "list";
    const width = frame.clientWidth;
    if (cut?.signature === i.signature && cut.width === width && (cut.on === "answers" || on === "list")) return;
    const clamped = [...answerList.querySelectorAll<HTMLElement>("[data-description]")].some((el) => el.scrollHeight > el.clientHeight + 1);
    setCut({ signature: i.signature, width, on, cut: clamped });
  });

  useEffect(() => {
    if (armed === null) return;
    const timer = setTimeout(() => setArmed(null), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  // The box it just opened must be in view, whether the card sits at a thread's tail or on Home.
  useEffect(() => {
    if (writing) form.current?.scrollIntoView?.({ block: "nearest" });
  }, [writing]);
  // A refusal sits under what was tapped, which a tall card can hold below the fold.
  useEffect(() => {
    if (notice) noticeLine.current?.scrollIntoView?.({ block: "nearest" });
  }, [notice]);
  // "Show all" and "Read the full plan" leave once pressed; focus moves to what they opened.
  useEffect(() => {
    if (opened) detail.current?.focus({ preventScroll: true });
  }, [opened]);

  if (!i) {
    if (!receipt) return null;
    return (
      <Frame compact={compact} answered>
        <p role="status" className="flex min-w-0 items-center gap-2 text-subhead text-muted-foreground">
          <Check aria-hidden className="size-4 shrink-0 text-status-done" />
          {title && <span className="shrink-0 font-medium text-foreground">{title}</span>}
          <span className="min-w-0 truncate">{receipt.summary}</span>
        </p>
      </Frame>
    );
  }

  const typing = Boolean(i.typing);
  const lockLine = lockReason ? (outage && bannerUp ? PAUSED_UNDER_BANNER : LOCK_COPY[lockReason]) : readOnly ? "Answers are paused right now." : null;
  const locked = lockLine !== null || typing || busy !== null;
  const staticList = lockReason === "read-only";

  // What folds: a command or file preview past SUBJECT_ROWS rows, a plan past its measured height.
  // Home's card without the whole request only clamps its plain detail: it cannot approve it anyway.
  const plan = i.kind === "plan" ? i.context : undefined;
  const planOverflows = planMeasure !== null && planMeasure.text === plan ? planMeasure.overflows : null;
  const foldable = i.subject ? (i.subject.command ?? i.subject.preview) : !ANSWER_KINDS.has(i.kind) && !plan ? i.context : undefined;
  const clampOnly = compact && !i.subject && !i.detailComplete;
  const codeFolded = !opened && !clampOnly && (foldable?.split("\n").length ?? 0) > SUBJECT_ROWS;
  const planFolded = plan !== undefined && !opened && planOverflows !== false;
  // Approving needs the whole request on the card, unfolded; a deny never does.
  const needsWhole = approveNeedsDetail && (i.kind === "permission" || i.kind === "plan");
  const approvalHidden = needsWhole && (!i.detailComplete || codeFolded || planFolded);
  const shown = i.options.filter((o) => !(approvalHidden && o.role !== "deny"));
  const nav = shown.filter((o) => o.role === "nav");
  // A text row the bridge can type takes a reply on the card; one without a measured recipe is typed
  // in the terminal. Any other option that accepts text may carry an optional note.
  const replies = shown.filter((o) => o.role === "freeText" && o.acceptsText);
  const inTerminal = shown.filter((o) => o.role === "freeText" && !o.acceptsText);
  const choices = shown.filter((o) => o.role !== "freeText" && o.role !== "nav");
  const notable = choices.some((o) => o.acceptsText);
  const note = writing?.to === "note" ? draft.trim() : "";
  // A question's deny row ("Chat about this", a review's Cancel) leaves the dialog without answering;
  // a permission's or a plan's No is an answer and stays among them.
  const answers = ANSWER_KINDS.has(i.kind);
  // Home answers neither a menu nor a preview: their content and previews only live in the thread.
  const opensOnly = compact && (i.kind === "menu" || isPreviewQuestion(i));
  const escapes = answers || opensOnly ? choices.filter((o) => o.role === "deny") : [];
  // A question's advance (Submit, Next) commits what is ticked above it: the card's one large primary.
  // Every other choice is a row of the one list, a permission's and a plan's Yes and No included.
  const advance = answers ? choices.filter((o) => o.role === "primary") : [];
  const listed = choices.filter((o) => !escapes.includes(o) && !advance.includes(o));
  const ticked = i.options.filter((o) => o.checked).length;
  const openLabelFor = compact ? "Open thread" : "Open terminal";
  const clamped = compact && cut?.signature === i.signature && cut.cut && onOpen !== undefined;
  const answerable = !staticList && !opensOnly && !clamped;

  async function send(option: InteractionOption, extra: AnswerExtra = {}) {
    setBusy(option.index);
    setNotice(null);
    setFailed(null);
    const outcome = await onAnswer(option, extra).catch((err: Error): AnswerOutcome => ({ ok: false, error: err.message || "Answer failed" }));
    setBusy(null);
    setArmed(null);
    if (outcome.ok) {
      if (extra.text !== undefined) {
        setDraft("");
        setWriting(null);
      }
      return;
    }
    // The armed row says what a second tap applies to; the bridge's own words would repeat it.
    if (outcome.code === "confirm_required") return setArmed(option.index);
    const at = extra.text !== undefined && writing?.to === "reply" ? "reply" : "options";
    setFailed(option.index);
    if (outcome.code === "interaction_changed") setNotice({ tone: "warn", text: outcome.error || "The question changed in the terminal.", at });
    else if (outcome.code === "not_reached") setNotice({ tone: "error", text: outcome.error, retry: option, at });
    else setNotice({ tone: "error", text: outcome.error || "Answer failed", at });
  }

  function press(option: InteractionOption) {
    if (locked) return;
    if (option.role === "persistent" && armed !== option.index) {
      setNotice(null);
      setFailed(null);
      return setArmed(option.index);
    }
    void send(option, {
      ...(note && option.acceptsText ? { text: note } : {}),
      ...(option.role === "persistent" ? { confirm: true } : {}),
    });
  }

  function write(next: Writing) {
    setWriting(next);
    setDraft("");
  }

  const reply = writing?.to === "reply" ? writing.option : undefined;
  const replyLabel = (o: InteractionOption) => `${bare(o.label)}…`;
  const rowProps = (option: InteractionOption) => ({
    option, armed: armed === option.index, busy: busy === option.index, failed: failed === option.index,
    // A typed note must never vanish into an answer that cannot carry it.
    disabled: locked || (note !== "" && !option.acceptsText),
    onPress: () => press(option),
  });
  // A text row the card types: the list's last row, quieter than the answers, opening the reply box.
  const replyRow = (option: InteractionOption) => (
    <button key={option.index} type="button" disabled={locked} aria-expanded={false} aria-controls={textId}
      onClick={() => write({ to: "reply", option })} className={optionRow()}>
      {!compact && <MessageSquareText aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
      <span className="min-w-0 flex-1 break-words text-body font-medium text-muted-foreground">{replyLabel(option)}</span>
    </button>
  );
  // One spinner while the thread opens, on what was tapped: the large primary, else the header.
  const openFrom = (primary: boolean) => () => {
    setOpenedByPrimary(primary);
    onOpen?.();
  };
  const primaryOpening = opening && openedByPrimary;
  const openingSpinner = <Loader2 aria-hidden className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />;
  // Home's one way into the thread from the card, as its one large primary.
  const toThread = onOpen && (
    <Button type="button" size="block" aria-busy={primaryOpening || undefined} onClick={openFrom(true)}>
      {primaryOpening && openingSpinner}{TO_THREAD}
    </Button>
  );
  // A multi-select's advance says how much it sends; a review with a gap says it sends it anyway. A
  // wizard step's Next only moves on, so its count reads as a selection, never as a question number.
  const decisionLabel = (option: InteractionOption): ReactNode => {
    if (option.role === "primary" && i.incomplete) return "Submit anyway";
    if (option.role === "primary" && i.kind === "multi-select" && !i.answers) {
      if (!SUBMIT.test(option.label)) return <>{option.label} · <span className="tabular-nums">{ticked || "none"}</span> selected</>;
      return ticked ? <>{option.label}{" "}<span className="tabular-nums">{ticked}</span></> : `${option.label} without answers`;
    }
    return undefined;
  };
  const quiet = (option: InteractionOption) => option.role === "primary" && i.kind === "multi-select" && !i.answers && ticked === 0;
  const steps = i.steps ?? [];
  // The bridge marks the question on screen; a review marks none.
  const current = steps.findIndex((s) => s.current);
  const back = nav.find((o) => o.label === "Back");
  const next = nav.find((o) => o.label === "Next");

  const noticeView = notice && (
    <div className="flex flex-col gap-2">
      <p ref={noticeLine} role="status" className={cn("flex items-start gap-2 text-body", notice.tone === "error" ? "text-destructive" : "text-status-working")}>
        {notice.tone === "error" ? <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0" /> : <RefreshCw aria-hidden className="mt-0.5 size-4 shrink-0" />}
        <span className="min-w-0">{notice.text}</span>
      </p>
      {/* The card's own row already leads to the terminal (or the thread): one way there, not two. */}
      {notice.retry && (
        <Button type="button" variant="secondary" disabled={locked} onClick={() => press(notice.retry!)} className="self-start text-subhead">Try again</Button>
      )}
    </div>
  );

  const progress = steps.length > 1 && (
    <span className="ml-auto flex shrink-0 items-center gap-1 font-medium tabular-nums text-muted-foreground">
      {back && <StepButton label="Previous question" disabled={locked} onClick={() => press(back)}><ChevronLeft aria-hidden className="size-4" /></StepButton>}
      <span>{current >= 0 ? `${current + 1} of ${steps.length}` : "Review"}</span>
      {next && <StepButton label="Next question" disabled={locked} onClick={() => press(next)}><ChevronRight aria-hidden className="size-4" /></StepButton>}
    </span>
  );

  return (
    <Frame ref={setFrame} compact={compact} label={i.question} busy={opening}>
      {compact ? <>
        <CompactHeader title={title} onOpen={onOpen && openFrom(false)} opening={opening && !openedByPrimary} />
        {/* The question's header chip, or where a wizard stands, as a quiet line over the question. */}
        {steps.length > 0 && (
          <div className="-mt-1 flex min-w-0 items-center gap-2 text-footnote font-medium text-muted-foreground">
            <span className="min-w-0 truncate">{steps.length === 1 ? steps[0]!.label : current >= 0 ? steps[current]!.label : "Your answers"}</span>
            {progress}
          </div>
        )}
      </> : <>
        <div className="flex min-w-0 items-center gap-2 text-footnote">
          <WaitingOnYou />
          {title && <span className="min-w-0 truncate text-muted-foreground">· {title}</span>}
          {steps.length === 1 && <span className="min-w-0 truncate text-muted-foreground"><span aria-hidden>· </span><span>{steps[0]!.label}</span></span>}
          {progress}
        </div>
        {steps.length > 1 && <Stepper steps={steps} />}
      </>}
      {/* Whole on Home too: its answers are on the card, and they reply to all of it. */}
      <QuestionHeading>{i.question}</QuestionHeading>
      <div ref={detail} tabIndex={-1} className="flex min-w-0 flex-col gap-[inherit] outline-none empty:hidden">
        {i.answers || i.incomplete ? <ReviewAnswers answers={i.answers ?? []} incomplete={Boolean(i.incomplete)} />
          : i.subject ? <Subject subject={i.subject} folded={codeFolded} onOpenAll={() => setOpened(true)} />
          : plan !== undefined ? <PlanText text={plan} compact={compact} folded={planFolded} overflows={planOverflows} onMeasure={(overflows) => setPlanMeasure({ text: plan, overflows })} onOpenAll={() => setOpened(true)} />
          : i.context && <Context interaction={i} text={i.context} compact={compact} clamp={clampOnly} folded={codeFolded} onOpenAll={() => setOpened(true)} />}
      </div>

      {typing ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-3">
            <Keyboard aria-hidden className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <div className="flex flex-col gap-0.5">
              <p className="text-body font-medium text-foreground">The terminal's text box has focus</p>
              <p className="text-footnote text-muted-foreground">Answers come back when typing ends</p>
            </div>
          </div>
          {onOpen && (
            <Button type="button" size="block" aria-busy={(compact && primaryOpening) || undefined} onClick={openFrom(true)}>
              {compact ? primaryOpening && openingSpinner : <TerminalSquare aria-hidden className="size-4 shrink-0" />}{openLabelFor}
            </Button>
          )}
        </div>
      ) : <>
        {lockLine && <p className="text-footnote text-muted-foreground">{lockLine}</p>}
        {/* A plan without its hint shows only its on-screen tail; a command may well be whole, just unverified. */}
        {approvalHidden && !i.detailComplete && i.kind === "plan" && (
          <p className="text-footnote text-muted-foreground">The full plan isn't on this card.</p>
        )}

        {opensOnly ? toThread : !answerable ? <>
          {/* Read-only: what the agent offers, nothing to press. Cut short on Home: answered in the thread. */}
          <StaticOptions ref={clamped ? setAnswerList : undefined} options={clamped ? listed : compact ? choices.filter((o) => !escapes.includes(o)) : choices} labelsOnly={compact && !clamped} clamp={clamped} />
          {clamped && toThread}
        </> : <>
          {(listed.length > 0 || (replies.length > 0 && !reply)) && (
            <OptionList ref={setAnswerList} data-answers aria-label="Answers">
              {listed.map((option) => <ChoiceRow key={option.index} {...rowProps(option)} toggle={isToggle(i, option)} clamp={compact && answers} />)}
              {!reply && replies.map(replyRow)}
            </OptionList>
          )}
          {/* While a reply is written its Send is the one commit: Submit would go without the typed text. */}
          {writing?.to !== "reply" && advance.map((option) => (
            <Button key={option.index} type="button" size="block" variant={quiet(option) ? "secondary" : "default"}
              data-role={option.role} data-quiet={quiet(option) || undefined} data-failed={failed === option.index || undefined}
              disabled={rowProps(option).disabled} aria-busy={busy === option.index || undefined} onClick={() => press(option)}
              className={cn(failed === option.index && FAILED)}>
              {busy === option.index && <Loader2 aria-label="Sending" className="size-4 shrink-0 animate-spin" />}
              {/* One flex item: the button's gap would otherwise split "Submit" from its count. */}
              <span>{decisionLabel(option) ?? option.label}</span>
            </Button>
          ))}
          {/* Home approves only with the whole request on the card; until then the thread does. */}
          {compact && approvalHidden && toThread}
        </>}

        {notice?.at === "options" && noticeView}

        {writing && (
          <form ref={form} id={textId} className="flex flex-col gap-2" onSubmit={(e) => {
            e.preventDefault();
            if (reply && !locked && draft.trim()) void send(reply, { text: draft });
          }}>
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={FEEDBACK_MAX_LENGTH} rows={compact ? 2 : 3} autoFocus
              aria-label={reply ? reply.label : "Note with your answer"}
              placeholder={reply ? reply.label : "Add a note, then pick an answer"} disabled={lockLine !== null}
              className="min-h-16 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-body outline-none focus-visible:ring-2 focus-visible:ring-ring" />
            {reply && (
              <Button type="submit" size="block" disabled={locked || !draft.trim()} aria-busy={busy === reply.index || undefined}>
                {busy === reply.index && <Loader2 aria-hidden className="size-4 shrink-0 animate-spin" />}Send
              </Button>
            )}
            <div className="-mx-2 flex items-center gap-2">
              <button type="button" disabled={busy !== null} onClick={() => write(null)} className={SECONDARY}>Cancel</button>
              <span aria-live="polite" className="ml-auto px-2 text-caption tabular-nums text-muted-foreground">{draft.length}/{FEEDBACK_MAX_LENGTH}</span>
            </div>
          </form>
        )}

        {notice?.at === "reply" && noticeView}

        {i.terminalOnly && i.terminalOnly.length > 0 && (
          <p className="min-w-0 break-words text-footnote text-muted-foreground">
            Also in the terminal: <span className="text-foreground">{i.terminalOnly.join(" · ")}</span>
          </p>
        )}

        {/* Leaving without an answer, a note, and the ways to the terminal: apart from the answers. */}
        {((!staticList && escapes.length > 0) || (answerable && notable && !writing)
          || (inTerminal.length > 0 && (compact ? answerable && onOpen : onKeys)) || (!compact && onOpen)) && (
          <SecondaryActions>
            {!staticList && escapes.map((option) => (
              <button key={option.index} type="button" data-role={option.role} disabled={rowProps(option).disabled} onClick={() => press(option)} className={SECONDARY}>
                {busy === option.index && <Loader2 aria-label="Sending" className="size-4 animate-spin" />}{option.label}
              </button>
            ))}
            {answerable && notable && !writing && <NoteButton locked={locked} textId={textId} className={SECONDARY} onClick={() => write({ to: "note" })} />}
            {compact ? answerable && onOpen && inTerminal.map((option) => (
              <button key={option.index} type="button" data-in-terminal onClick={openFrom(false)} className={SECONDARY} title={`${bare(option.label)} in the thread`}>
                Type your own answer<ChevronRight aria-hidden className="size-4 shrink-0" />
              </button>
            )) : onKeys && inTerminal.map((option) => (
              <button key={option.index} type="button" data-in-terminal onClick={onKeys} className={SECONDARY}
                aria-label="Type your own answer in the terminal" title={`${bare(option.label)} in the terminal`}>
                <Keyboard aria-hidden className="size-4 shrink-0" />Type your own
              </button>
            ))}
            {!compact && onOpen && (
              <button type="button" onClick={onOpen} className={cn(SECONDARY, "sm:ml-auto")}>
                <TerminalSquare aria-hidden className="size-4 shrink-0" />Terminal
              </button>
            )}
          </SecondaryActions>
        )}
      </>}
    </Frame>
  );
}

function Frame({ ref, compact, answered, label, busy = false, children }: { ref?: Ref<HTMLElement>; compact: boolean; answered?: boolean; label?: string; busy?: boolean; children: ReactNode }) {
  return (
    <section ref={ref} aria-label={label ?? "Answered"} aria-busy={busy || undefined} data-question-card={compact ? "compact" : "full"}
      className={cn(
        "flex min-w-0 flex-col",
        answered
          ? "rounded-xl border border-border/60 bg-muted/30 px-3.5 py-2.5"
          // A card is a message waiting on you, not an alarm: the dot carries the urgency, in the thread
          // and on Home alike. Home's header row bleeds to the card's edge, so its padding starts below.
          : cn(DIALOG_CARD, compact && "gap-2 pt-1"),
      )}>
      {children}
    </section>
  );
}

/** Home's card header: who is asking, and the whole row opens the thread; while that thread loads, its
 *  chevron turns into the spinner every opening row on Home shows. Section already says Needs you. */
function CompactHeader({ title, onOpen, opening }: { title?: ReactNode; onOpen?: () => void; opening: boolean }) {
  const who = <>
    <span aria-hidden className="size-2 shrink-0 rounded-full bg-status-blocked" />
    <span className="min-w-0 flex-1 truncate text-subhead font-medium text-foreground">{title ?? "Waiting on you"}</span>
  </>;
  if (!onOpen) return <div className="flex min-h-11 min-w-0 items-center gap-2.5">{who}</div>;
  return (
    <button type="button" onClick={onOpen} aria-busy={opening || undefined}
      className="-mx-2 flex min-h-11 min-w-0 select-none items-center gap-2.5 rounded-lg px-2 text-left transition-colors hover:bg-muted active:bg-muted">
      {who}
      <span className="sr-only">, open thread</span>
      {opening
        ? <Loader2 aria-hidden className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
        : <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
    </button>
  );
}

/** Back or Next across a wizard's questions: a 32 px chevron with the 44 px touch target. */
function StepButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} disabled={disabled} onClick={onClick}
      className="hit-area flex size-8 items-center justify-center rounded-md text-foreground transition-colors hover:bg-muted active:bg-muted disabled:text-muted-foreground">
      {children}
    </button>
  );
}

/** A multi-question dialog's questions, as its header chips: answered, on screen, still to come. */
function Stepper({ steps }: { steps: InteractionStep[] }) {
  return (
    <ol aria-label="Questions" className="-mx-2 flex min-w-0 flex-wrap items-center gap-1">
      {steps.map((step, n) => (
        <li key={n} aria-current={step.current ? "step" : undefined}
          aria-label={`${step.label}${step.answered ? ", answered" : ""}`}
          className={cn(
            "inline-flex min-w-0 items-center gap-1 rounded-full px-2 py-0.5 text-caption",
            step.current ? "bg-foreground/10 font-medium text-foreground" : "text-muted-foreground",
          )}>
          {step.answered && <Check aria-hidden className="size-3 shrink-0 text-status-done" />}
          <span className="truncate">{step.label}</span>
        </li>
      ))}
    </ol>
  );
}

const CODE = "w-full min-w-0 whitespace-pre-wrap rounded-lg bg-muted px-3 py-2.5 font-mono text-code text-foreground [overflow-wrap:anywhere]";

function ShowAll({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="-mx-1 min-h-11 rounded-md px-1 text-footnote font-medium text-muted-foreground hover:text-foreground">
      Show all {count} lines
    </button>
  );
}

/**
 * What a permission asks for, as the dialog draws it: the tool, what it is for, then the command or
 * file as code. The command is whole unless it is folded past SUBJECT_ROWS rows.
 */
function Subject({ subject, folded, onOpenAll }: { subject: InteractionSubject; folded: boolean; onOpenAll: () => void }) {
  const rows = (subject.command ?? subject.preview ?? "").split("\n");
  const visible = folded ? rows.slice(0, SUBJECT_ROWS) : rows;
  return (
    <div data-subject className="flex min-w-0 flex-col items-start gap-1.5">
      {subject.tool && <p className="text-footnote font-semibold text-muted-foreground">{subject.tool}</p>}
      {subject.description && <p className="text-body text-foreground text-pretty">{subject.description}</p>}
      {subject.file && <p role="group" aria-label="File" className="w-full min-w-0 font-mono text-code text-foreground [overflow-wrap:anywhere]">{subject.file}</p>}
      {subject.command !== undefined && <pre role="group" aria-label="Command" className={CODE}>{visible.join("\n")}</pre>}
      {subject.preview !== undefined && <Preview rows={visible} />}
      {folded && <ShowAll count={rows.length} onClick={onOpenAll} />}
      {subject.meta && subject.meta.length > 0 && <p className="text-footnote text-muted-foreground">{subject.meta.join(" · ")}</p>}
    </div>
  );
}

/** A file preview's rows, the dialog's own line numbers in a gutter apart from the text. */
function Preview({ rows }: { rows: string[] }) {
  const lines = rows.map((row) => /^(\d+)(?:\s(.*))?$/.exec(row));
  const gutter = Math.max(1, ...lines.map((m) => m?.[1]?.length ?? 0));
  return (
    <div role="group" aria-label="Preview" className="w-full min-w-0 rounded-lg bg-muted py-2 font-mono text-code text-foreground">
      {rows.map((row, n) => (
        <div key={n} className="flex gap-3 px-3">
          <span aria-hidden="true" className="shrink-0 text-right tabular-nums text-muted-foreground select-none" style={{ width: `${gutter}ch` }}>{lines[n]?.[1] ?? ""}</span>
          <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{lines[n] ? lines[n][2] ?? "" : row}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * The plan as formatted text, folded to its first lines with a fade. The fold is measured: a plan
 * that fits is never folded, and until it is measured it counts as folded, so Home never offers to
 * approve a plan it is still cutting (ADR 0057 §4).
 */
function PlanText({ text, compact, folded, overflows, onMeasure, onOpenAll }: {
  text: string; compact: boolean; folded: boolean; overflows: boolean | null; onMeasure: (overflows: boolean) => void; onOpenAll: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  // Measured once per text, while folded: unfolding needs no new measure.
  useLayoutEffect(() => {
    const el = box.current;
    if (el && overflows === null) onMeasure(el.scrollHeight > el.clientHeight + 1);
  }, [text, overflows, onMeasure]);
  // Its own surface, so the plan's headings read as the document under the question, not as more questions.
  return (
    <div className="flex min-w-0 flex-col items-start rounded-lg border border-border px-3.5 pt-3 pb-1">
      <div ref={box} role="group" aria-label="Plan" className={cn(
        "w-full min-w-0 pb-2 [&>div]:text-body",
        // The fade is clear a full line (1.5rem) above the cut, so a row the cut slices is never seen.
        folded && "overflow-hidden [mask-image:linear-gradient(to_bottom,black_calc(100%-5rem),transparent_calc(100%-1.5rem))]",
        folded && (compact ? "max-h-36" : "max-h-64"),
      )}>
        <MarkdownText text={text} />
      </div>
      {folded && overflows && (
        <button type="button" onClick={onOpenAll} className="-mx-1 -mt-1 min-h-11 rounded-md px-1 text-footnote font-medium text-muted-foreground hover:text-foreground">
          Read the full plan
        </button>
      )}
    </div>
  );
}

/**
 * A question's own detail as text; anything else in mono, folded past SUBJECT_ROWS rows. Home's card
 * without the whole request clamps it to three lines instead: it cannot approve it either way.
 */
function Context({ interaction: i, text, compact, clamp, folded, onOpenAll }: {
  interaction: Interaction; text: string; compact: boolean; clamp: boolean; folded: boolean; onOpenAll: () => void;
}) {
  if (ANSWER_KINDS.has(i.kind)) {
    return <p className={cn("min-w-0 whitespace-pre-wrap break-words text-footnote text-muted-foreground", compact && "line-clamp-2")}>{text}</p>;
  }
  const rows = text.split("\n");
  return (
    // The padding sits outside the clamped box: a clamp only cuts at its own padding edge, so
    // padding on the clamped element itself shows the top half of the next line.
    <div className="flex min-w-0 flex-col items-start gap-1 rounded-lg bg-muted/60 px-2.5 py-2">
      <pre role="group" aria-label="Request details" className={cn(
        "w-full min-w-0 whitespace-pre-wrap break-words font-mono text-code text-foreground",
        clamp && "line-clamp-3",
      )}>{folded ? rows.slice(0, SUBJECT_ROWS).join("\n") : text}</pre>
      {folded && <ShowAll count={rows.length} onClick={onOpenAll} />}
    </div>
  );
}

/** A review: what Submit sends, question over answer, and a warning when a question has none. */
function ReviewAnswers({ answers, incomplete }: { answers: InteractionAnswer[]; incomplete: boolean }) {
  return <>
    {answers.length > 0 && (
      <ul aria-label="Your answers" className="flex flex-col gap-1.5 rounded-lg bg-muted/60 px-3 py-2.5 text-footnote">
        {answers.map((a, n) => (
          <li key={n} className="flex min-w-0 flex-col">
            <span className="text-muted-foreground">{a.question}</span>
            <span className="font-medium text-foreground">{a.answer}</span>
          </li>
        ))}
      </ul>
    )}
    {incomplete && (
      <p className="flex items-center gap-2 text-body text-status-working">
        <AlertTriangle aria-hidden className="size-4 shrink-0" />Some questions have no answer
      </p>
    )}
  </>;
}

/** Options the card shows but cannot answer (a read-only device, or answered in the thread): the same
 *  list, drawn unavailable like a paused row, with rows sized to read rather than to tap. Home's keeps
 *  the labels. */
function StaticOptions({ ref, options, labelsOnly, clamp = false }: { ref?: Ref<HTMLUListElement>; options: InteractionOption[]; labelsOnly: boolean; clamp?: boolean }) {
  return (
    <ul ref={ref} aria-label="Options" data-option-list className={OPTION_LIST}>
      {options.map((option) => (
        <li key={option.index} className="flex min-h-9 min-w-0 flex-col justify-center gap-0.5 px-3.5 py-1.5">
          <OptionLabel label={option.label} dim />
          {option.description && !labelsOnly && <OptionDescription clamp={clamp}>{option.description}</OptionDescription>}
        </li>
      ))}
    </ul>
  );
}

function NoteButton({ locked, textId, className, onClick }: { locked: boolean; textId: string; className: string; onClick: () => void }) {
  return (
    <button type="button" disabled={locked} aria-expanded={false} aria-controls={textId} onClick={onClick} className={className}>
      Add a note…
    </button>
  );
}

const SECONDARY = SECONDARY_ACTION;
/** The tapped option a refusal is about, until the next tap. */
const FAILED = "outline outline-1 -outline-offset-1 outline-destructive";

interface RowProps {
  option: InteractionOption;
  armed: boolean;
  busy: boolean;
  failed: boolean;
  disabled: boolean;
  onPress: () => void;
}

/** A label without its trailing dots or ellipsis, to end it with our own. */
const bare = (label: string) => label.replace(/[.…]+$/, "");

/**
 * One choice of the card's list, whatever the dialog: a question's answer, a multi-select's box, a
 * permission's or a plan's Yes and No. Its title, what it means in small grey, a quiet Recommended.
 * A decline is an answer like any other, so it stays neutral: red reads as an error, and the dot
 * already says it is your turn. A persistent answer says it changes a setting and asks for a second
 * tap: armed, the row takes the selected fill and its Confirm pill runs out on the detail line.
 */
function ChoiceRow({ option, toggle, armed, busy, failed, disabled, onPress, clamp = false }: RowProps & { toggle: boolean; clamp?: boolean }) {
  const detail = armed ? "Applies to future prompts" : option.role === "persistent" ? "Changes a setting beyond this answer" : option.description;
  const checked = toggle && Boolean(option.checked);
  return (
    <button type="button" disabled={disabled} onClick={onPress} data-role={option.role} data-failed={failed || undefined}
      aria-pressed={toggle ? checked : undefined} aria-label={armed ? `Confirm: ${option.label}` : undefined}
      className={cn(optionRow(busy || checked || armed ? "selected" : "default"), failed && FAILED)}>
      {toggle && <OptionCheckbox checked={checked} />}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <OptionLabel label={option.label} dim={disabled && !busy} />
        {/* Armed, the pill runs out on the detail line, so the label keeps the row's width. */}
        {(detail || armed) && (
          <span className="flex min-w-0 items-center justify-between gap-3">
            {detail && <OptionDescription clamp={clamp && !armed}>{detail}</OptionDescription>}
            {armed && <ConfirmPill />}
          </span>
        )}
      </span>
      {busy && <Loader2 aria-label="Sending" className="size-4 shrink-0 animate-spin text-muted-foreground" />}
    </button>
  );
}

/**
 * The armed state of a persistent option: its label stays, a Confirm pill trails it with a ring that
 * runs out with CONFIRM_MS, and the line under it says what the second tap applies to.
 */
function ConfirmPill() {
  const ring = useRef<SVGCircleElement>(null);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const animation = ring.current?.animate?.([{ strokeDashoffset: 0 }, { strokeDashoffset: 38 }], { duration: CONFIRM_MS, easing: "linear", fill: "forwards" });
    return () => animation?.cancel();
  }, []);
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-foreground py-1 pr-2.5 pl-1.5 text-footnote font-medium text-background">
      <svg aria-hidden viewBox="0 0 16 16" className="size-4 -rotate-90">
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2" />
        <circle ref={ring} cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="38" strokeDashoffset="0" />
      </svg>
      Confirm
    </span>
  );
}
