import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import { Check, Loader2, TerminalSquare } from "lucide-react";

import { isToggle, type LiveInteraction, type LiveOption, type Receipt } from "@/hooks/use-interactions";
import { FEEDBACK_MAX_LENGTH } from "@/lib/prompt-action";
import type { AnswerOutcome } from "@/lib/types";
import { cn } from "@/lib/utils";

// One card for every dialog the bridge detected (ADR 0057): inline at the bottom of a thread, and
// compact on Home. A tap is one POST naming the option by index; the bridge re-reads the screen,
// refuses a stale signature and owns every key. Text stays React text nodes (the XSS boundary).

/** How long a persistent option stays armed for its confirming second tap. */
export const CONFIRM_MS = 5_000;

export interface QuestionCardProps {
  interaction?: LiveInteraction;
  /** Shown instead of a card once the dialog was answered and before the pane's next one. */
  receipt?: Receipt;
  onAnswer: (option: LiveOption, extra?: { text?: string; confirm?: boolean }) => Promise<AnswerOutcome>;
  readOnly?: boolean;
  /** Home's variant: one line of options and the question clamped. */
  compact?: boolean;
  /** Who is asking (the pane's name), for a card shown away from its thread. */
  title?: ReactNode;
  /** Where the full dialog lives: the terminal mirror in a thread, the thread from Home. */
  onOpen?: () => void;
  openLabel?: string;
  /**
   * A permission may be approved only while its full command or file is on the card; otherwise the
   * card offers `onOpen` instead. Defaults to on for the compact (Home) card.
   */
  approveNeedsDetail?: boolean;
}

type Notice = { tone: "warn" | "error"; text: string };

export function QuestionCard({
  interaction: i, receipt, onAnswer, readOnly = false, compact = false, title, onOpen,
  openLabel = compact ? "Open" : "Open terminal", approveNeedsDetail = compact,
}: QuestionCardProps) {
  const [busy, setBusy] = useState<number | null>(null);
  const [armed, setArmed] = useState<number | null>(null);
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const replyId = useId();

  useEffect(() => {
    if (armed === null) return;
    const timer = setTimeout(() => setArmed(null), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [armed]);

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
  // Only the plan's "Tell Claude what to change" takes text from the card (the bridge's verified
  // feedback sequence); any other free-text row is typed in the terminal.
  const reply = i.kind === "plan" ? shown.find((o) => o.role === "freeText") : undefined;
  const choices = shown.filter((o) => o !== reply && !(o.role === "freeText" && !onOpen));

  async function send(option: LiveOption, extra: { text?: string; confirm?: boolean } = {}) {
    setBusy(option.index);
    setNotice(null);
    const outcome = await onAnswer(option, extra).catch((err: Error): AnswerOutcome => ({ ok: false, error: err.message || "Answer failed" }));
    setBusy(null);
    setArmed(null);
    if (outcome.ok) {
      if (extra.text !== undefined) {
        setDraft("");
        setReplying(false);
      }
      return;
    }
    if (outcome.code === "interaction_changed") setNotice({ tone: "warn", text: "Menu changed. Refreshing." });
    else if (outcome.code === "confirm_required") {
      setArmed(option.index);
      setNotice({ tone: "warn", text: outcome.error });
    } else setNotice({ tone: "error", text: outcome.error || "Answer failed" });
  }

  function press(option: LiveOption) {
    if (locked) return;
    if (option.role === "freeText") return onOpen?.();
    if (option.role === "persistent" && armed !== option.index) {
      setNotice(null);
      return setArmed(option.index);
    }
    void send(option, option.role === "persistent" ? { confirm: true } : {});
  }

  const question = <p className={cn("text-foreground", compact ? "line-clamp-3 text-sm" : "text-[15.5px] leading-snug")}>{i.question}</p>;

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
        <pre aria-label="Request details" className={cn(
          "min-w-0 whitespace-pre-wrap break-words rounded-lg bg-muted/60 px-2.5 py-2 font-mono text-[12.5px] leading-relaxed text-foreground",
          compact ? "line-clamp-3" : "max-h-56 overflow-y-auto",
        )}>{i.context}</pre>
      )}
      {typing && <p className="text-xs text-muted-foreground">Someone is typing in this dialog in the terminal. Answer there, or wait.</p>}
      {readOnly && <p className="text-xs text-muted-foreground">Read-only on this device.</p>}
      {approvalHidden && <p className="text-xs text-muted-foreground">The full request isn't on this card. {compact ? "Open the thread" : "Open the terminal"} to approve it.</p>}

      <div className={cn("flex gap-2", compact ? "flex-row flex-wrap" : "flex-col lg:flex-row lg:flex-wrap")}>
        {choices.map((option) => (
          <OptionRow key={option.index} option={option} toggle={isToggle(i, option)} compact={compact}
            armed={armed === option.index} busy={busy === option.index} disabled={locked}
            label={option.role === "freeText" ? `${option.label} (in terminal)` : undefined}
            onPress={() => press(option)} />
        ))}
        {reply && !replying && (
          <button type="button" disabled={locked} aria-expanded={false} aria-controls={replyId}
            onClick={() => setReplying(true)}
            className={cn(rowBase(compact), "border border-border bg-transparent text-muted-foreground disabled:opacity-50")}>
            Reply…
          </button>
        )}
        {onOpen && (
          <button type="button" onClick={onOpen}
            className={cn(rowBase(compact), "border border-border bg-transparent text-muted-foreground", compact && "ml-auto", !compact && "lg:ml-auto")}>
            <TerminalSquare aria-hidden className="size-4 shrink-0" />{openLabel}
          </button>
        )}
      </div>

      {reply && replying && (
        <form id={replyId} className="flex flex-col gap-2" onSubmit={(e) => {
          e.preventDefault();
          if (!locked && draft.trim()) void send(reply, { text: draft });
        }}>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={FEEDBACK_MAX_LENGTH} rows={3} autoFocus
            aria-label={reply.label} placeholder={reply.label} disabled={readOnly || typing}
            className="min-h-20 w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm" />
          <div className="flex gap-2">
            <button type="submit" disabled={locked || !draft.trim()}
              className={cn(rowBase(compact), "bg-foreground text-background disabled:opacity-50")}>
              {busy === reply.index && <Loader2 aria-hidden className="size-4 animate-spin" />}Send to Claude
            </button>
            <button type="button" disabled={busy !== null} onClick={() => setReplying(false)}
              className={cn(rowBase(compact), "border border-border text-muted-foreground")}>Cancel</button>
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

function OptionRow({ option, toggle, compact, armed, busy, disabled, label, onPress }: {
  option: LiveOption; toggle: boolean; compact: boolean; armed: boolean; busy: boolean; disabled: boolean; label?: string; onPress: () => void;
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
        (tone === "neutral" || tone === "freeText") && "border border-border bg-secondary text-foreground",
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
        <span className="break-words">{armed ? `Tap again to confirm: ${option.label}` : label ?? option.label}</span>
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
