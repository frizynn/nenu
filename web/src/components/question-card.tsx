import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Check, Keyboard, Loader2, TerminalSquare } from "lucide-react";

import { isToggle, type AnswerExtra, type Receipt } from "@/hooks/use-interactions";
import { FEEDBACK_MAX_LENGTH } from "@/lib/prompt-action";
import type { AnswerOutcome, Interaction, InteractionOption } from "@/lib/types";
import { cn } from "@/lib/utils";

// One card for every dialog the bridge detected (ADR 0057): inline at the bottom of a thread, and
// compact on Home. A tap is one POST naming the option by index; the bridge re-reads the screen,
// refuses a stale signature and owns every key. Text stays React text nodes (the XSS boundary).

/** How long a persistent option stays armed for its confirming second tap. */
export const CONFIRM_MS = 5_000;

export interface QuestionCardProps {
  interaction?: Interaction;
  /** Shown instead of a card once the dialog was answered and before the pane's next one. */
  receipt?: Receipt;
  onAnswer: (option: InteractionOption, extra?: AnswerExtra) => Promise<AnswerOutcome>;
  readOnly?: boolean;
  /** Home's variant: one line of options and the question clamped. */
  compact?: boolean;
  /** Who is asking (the pane's name), for a card shown away from its thread. */
  title?: ReactNode;
  /** Where the full dialog lives: the terminal mirror in a thread, the thread from Home. */
  onOpen?: () => void;
  openLabel?: string;
  /** The keys pad next to the terminal, for a text row the card cannot type (Home has none: `onOpen` is on the card). */
  onKeys?: () => void;
  /**
   * A permission may be approved only while its full command or file is on the card; otherwise the
   * card offers `onOpen` instead. Defaults to on for the compact (Home) card.
   */
  approveNeedsDetail?: boolean;
}

type Notice = { tone: "warn" | "error"; text: string };
/** The text box open on the card: a text row's reply (required), or a note other answers may carry. */
type Writing = { to: "reply"; option: InteractionOption } | { to: "note" } | null;

export function QuestionCard({
  interaction: i, receipt, onAnswer, readOnly = false, compact = false, title, onOpen,
  openLabel = compact ? "Open" : "Open terminal", onKeys, approveNeedsDetail = compact,
}: QuestionCardProps) {
  const [busy, setBusy] = useState<number | null>(null);
  const [armed, setArmed] = useState<number | null>(null);
  const [writing, setWriting] = useState<Writing>(null);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const textId = useId();
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (armed === null) return;
    const timer = setTimeout(() => setArmed(null), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  // The card sits in a capped scroll box under the thread; the box it just opened must be in view.
  useEffect(() => {
    if (writing) form.current?.scrollIntoView?.({ block: "nearest" });
  }, [writing]);

  if (!i) {
    if (!receipt) return null;
    return (
      <Frame compact={compact} answered>
        <p role="status" className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
          <Check aria-hidden className="size-4 shrink-0 text-status-done" />
          {title && <span className="shrink-0 font-medium text-foreground">{title}</span>}
          <span className="min-w-0 truncate">Answered: {receipt.label}</span>
        </p>
      </Frame>
    );
  }

  const typing = Boolean(i.typing);
  const locked = readOnly || typing || busy !== null;
  // Approving needs the whole request on the card; a deny never does.
  const approvalHidden = approveNeedsDetail && i.kind === "permission" && !i.detailComplete;
  const shown = i.options.filter((o) => !(approvalHidden && o.role !== "deny"));
  // A text row the bridge can type takes a reply on the card; one without a measured recipe is typed
  // in the terminal. Any other option that accepts text may carry an optional note.
  const replies = shown.filter((o) => o.role === "freeText" && o.acceptsText);
  const inTerminal = shown.filter((o) => o.role === "freeText" && !o.acceptsText);
  const choices = shown.filter((o) => o.role !== "freeText");
  const notable = choices.some((o) => o.acceptsText);
  const note = writing?.to === "note" ? draft.trim() : "";

  async function send(option: InteractionOption, extra: AnswerExtra = {}) {
    setBusy(option.index);
    setNotice(null);
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
    if (outcome.code === "interaction_changed") setNotice({ tone: "warn", text: "Menu changed. Refreshing." });
    else if (outcome.code === "confirm_required") {
      setArmed(option.index);
      setNotice({ tone: "warn", text: outcome.error });
    } else setNotice({ tone: "error", text: outcome.error || "Answer failed" });
  }

  function press(option: InteractionOption) {
    if (locked) return;
    if (option.role === "persistent" && armed !== option.index) {
      setNotice(null);
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

  const question = <p className={cn("text-foreground", compact ? "line-clamp-3 text-sm" : "text-[15.5px] leading-snug")}>{i.question}</p>;
  const reply = writing?.to === "reply" ? writing.option : undefined;
  const replyLabel = (o: InteractionOption) => (i.kind === "plan" ? "Reply…" : `${o.label.replace(/[.…]+$/, "")}…`);

  return (
    <Frame compact={compact} label={i.question}>
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn("flex shrink-0 items-center gap-1.5 font-medium text-status-blocked", compact ? "text-xs" : "text-[13px]")}>
          <span aria-hidden className="size-1.5 rounded-full bg-status-blocked ring-2 ring-status-blocked/25" />
          Waiting on you
        </span>
        {title && <span className="min-w-0 truncate text-xs text-muted-foreground">· {title}</span>}
      </div>
      {question}
      {i.context && (
        // The padding sits outside the clamped box: a clamp only cuts at its own padding edge, so
        // padding on the clamped element itself shows the top half of the next line.
        <div className={cn("min-w-0 rounded-lg bg-muted/60 px-2.5 py-2", !compact && "max-h-56 overflow-y-auto")}>
          <pre aria-label="Request details" className={cn(
            "min-w-0 whitespace-pre-wrap break-words font-mono text-[12.5px] leading-relaxed text-foreground",
            compact && "line-clamp-3",
          )}>{i.context}</pre>
        </div>
      )}
      {typing && <p className="text-xs text-muted-foreground">Someone is typing in this dialog in the terminal. Answer there, or wait.</p>}
      {readOnly && <p className="text-xs text-muted-foreground">Read-only on this device.</p>}
      {approvalHidden && <p className="text-xs text-muted-foreground">The full request isn't on this card. {compact ? "Open the thread" : "Open the terminal"} to approve it.</p>}

      {inTerminal.map((option) => (
        <p key={option.index} data-in-terminal className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="min-w-0 break-words"><span className="text-foreground">{option.label}</span> Answer in the terminal.</span>
          {onKeys && (
            <button type="button" onClick={onKeys}
              className="inline-flex min-h-8 items-center gap-1 font-medium text-foreground underline underline-offset-2">
              <Keyboard aria-hidden className="size-3.5 shrink-0" />Open keys
            </button>
          )}
        </p>
      ))}

      <div className={cn("flex gap-2", compact ? "flex-row flex-wrap" : "flex-col lg:flex-row lg:flex-wrap")}>
        {choices.map((option) => (
          <OptionRow key={option.index} option={option} toggle={isToggle(i, option)} compact={compact}
            armed={armed === option.index} busy={busy === option.index}
            // A typed note must never vanish into an answer that cannot carry it.
            disabled={locked || (note !== "" && !option.acceptsText)}
            onPress={() => press(option)} />
        ))}
        {!reply && replies.map((option) => (
          <button key={option.index} type="button" disabled={locked} aria-expanded={false} aria-controls={textId}
            onClick={() => write({ to: "reply", option })}
            className={cn(rowBase(compact), "border border-border bg-transparent text-muted-foreground disabled:opacity-50")}>
            {replyLabel(option)}
          </button>
        ))}
        {notable && !writing && (
          <button type="button" disabled={locked} aria-expanded={false} aria-controls={textId}
            onClick={() => write({ to: "note" })}
            className={cn(rowBase(compact), "border border-border bg-transparent text-muted-foreground disabled:opacity-50")}>
            Add a note…
          </button>
        )}
        {onOpen && (
          <button type="button" onClick={onOpen}
            className={cn(rowBase(compact), "border border-border bg-transparent text-muted-foreground", compact && "ml-auto", !compact && "lg:ml-auto")}>
            <TerminalSquare aria-hidden className="size-4 shrink-0" />{openLabel}
          </button>
        )}
      </div>

      {writing && (
        <form ref={form} id={textId} className="flex flex-col gap-2" onSubmit={(e) => {
          e.preventDefault();
          if (reply && !locked && draft.trim()) void send(reply, { text: draft });
        }}>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={FEEDBACK_MAX_LENGTH} rows={compact ? 2 : 3} autoFocus
            aria-label={reply ? reply.label : "Note with your answer"}
            placeholder={reply ? reply.label : "Add a note, then pick an answer"} disabled={readOnly || typing}
            className="min-h-16 w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm" />
          <div className="flex items-center gap-2">
            {reply && (
              <button type="submit" disabled={locked || !draft.trim()}
                className={cn(rowBase(compact), "bg-foreground text-background disabled:opacity-50")}>
                {busy === reply.index && <Loader2 aria-hidden className="size-4 animate-spin" />}Send
              </button>
            )}
            <button type="button" disabled={busy !== null} onClick={() => write(null)}
              className={cn(rowBase(compact), "border border-border text-muted-foreground")}>Cancel</button>
            <span aria-live="polite" className="ml-auto text-xs tabular-nums text-muted-foreground">{draft.length}/{FEEDBACK_MAX_LENGTH}</span>
          </div>
        </form>
      )}

      {notice && <p role="status" className={cn("text-xs", notice.tone === "error" ? "text-destructive" : "text-status-working")}>{notice.text}</p>}
    </Frame>
  );
}

function Frame({ compact, answered, label, children }: { compact: boolean; answered?: boolean; label?: string; children: ReactNode }) {
  return (
    <section aria-label={label ?? "Answered"} data-question-card={compact ? "compact" : "full"}
      className={cn(
        "flex min-w-0 flex-col rounded-2xl",
        compact ? "gap-2 p-3" : "gap-3 p-3.5",
        answered
          ? "border border-border/60 bg-muted/30"
          : "border border-status-blocked/40 bg-status-blocked/[0.06]",
      )}>
      {children}
    </section>
  );
}

const rowBase = (compact: boolean) => cn(
  "inline-flex items-center gap-2 rounded-xl px-3.5 text-left font-medium transition-colors active:scale-[0.99]",
  compact ? "min-h-10 text-sm" : "min-h-12 text-[15px]",
);

function OptionRow({ option, toggle, compact, armed, busy, disabled, onPress }: {
  option: InteractionOption; toggle: boolean; compact: boolean; armed: boolean; busy: boolean; disabled: boolean; onPress: () => void;
}) {
  const tone = armed ? "armed" : option.role;
  return (
    <button type="button" disabled={disabled} onClick={onPress} data-role={option.role}
      aria-pressed={toggle ? Boolean(option.checked) : undefined}
      className={cn(
        rowBase(compact),
        !compact && "w-full lg:w-auto",
        "disabled:opacity-50",
        busy && "disabled:opacity-100",
        tone === "primary" && "bg-foreground text-background",
        tone === "neutral" && "border border-border bg-secondary text-foreground",
        tone === "persistent" && "border border-dashed border-border bg-secondary text-foreground",
        tone === "deny" && "border border-status-blocked/40 bg-transparent text-status-blocked",
        tone === "armed" && "border border-status-working bg-status-working/15 text-foreground",
      )}>
      {toggle ? (
        <span aria-hidden className={cn("flex size-4 shrink-0 items-center justify-center rounded border",
          option.checked ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/60")}>
          {option.checked && <Check className="size-3" />}
        </span>
      ) : !compact && (
        <span aria-hidden className={cn("w-3 shrink-0 tabular-nums", tone === "primary" ? "text-background/60" : "text-muted-foreground")}>{option.index + 1}</span>
      )}
      <span className="flex min-w-0 flex-1 flex-col py-1.5">
        <span className="break-words">{armed ? `Tap again to confirm: ${option.label}` : option.label}</span>
        {!compact && (armed || option.role === "persistent" || option.description) && (
          <span className={cn("text-xs font-normal", tone === "primary" ? "text-background/70" : "text-muted-foreground")}>
            {option.role === "persistent" ? "Changes a setting beyond this answer" : option.description}
          </span>
        )}
      </span>
      {busy && <Loader2 aria-label="Sending" className="size-4 shrink-0 animate-spin" />}
    </button>
  );
}
