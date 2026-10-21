import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { CircleAlert, ChevronRight, Pending, RefreshCw } from "@/components/ui/icon";

import { isOpening, OpeningSpinner } from "@/components/home-panels";
import { AutoDeny, QuestionCard, useLockLine, type LockReason } from "@/components/question-card";
import { StatusDot } from "@/components/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import type { InteractionsState, Receipt } from "@/hooks/use-interactions";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { NeedsYouItem } from "@/lib/home-stats";
import { panePath } from "@/lib/nav";
import { displayName, displayPlace } from "@/lib/display-name";
import { oneTapAnswers } from "@/lib/one-tap-answers";
import { ASK } from "@/lib/org-tree";
import type { AgentView, AnswerOutcome, Interaction, InteractionOption, ProjectView } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Who is asking and where it lives, by the names every other view gives the same pane. */
function asker(agent: AgentView | undefined, projects: readonly ProjectView[] | undefined, paneId: string): { name: string; where?: string } {
  if (!agent) return { name: paneId };
  return { name: displayName(agent, projects), where: displayPlace(agent, projects).place };
}

const WAITING = "waiting in the terminal";

/**
 * The button a row opens its thread with (Answer, Reply): solid on a phone, outlined on a desk, where a
 * solid one is the brightest thing on the page and the page's one primary belongs to the composer.
 */
function useOpenButton(): string {
  return buttonVariants({ size: "sm", variant: useMediaQuery("(min-width: 1024px)") ? "outline" : "default" });
}

/**
 * Home's "Needs you": one row per pane, oldest first, so the lists under it stay in the first screen.
 * A detected dialog says what it asks and, on a desk, takes its one-tap answers in place; anything
 * else opens the thread, where the whole card is. A blocked pane with no dialog the bridge could read,
 * and a thread waiting for your reply, are rows into their thread. Answers just sent stay as
 * receipts until the pane's next dialog.
 */
export function NeedsYouList({ agents, projects, session, items, receipts, interactions, lockReason, opening }: {
  agents: readonly AgentView[];
  projects?: readonly ProjectView[];
  session?: string;
  items: readonly NeedsYouItem<Interaction>[];
  receipts: readonly Receipt[];
  interactions: InteractionsState;
  /** Why answers are paused, if they are. */
  lockReason: LockReason | undefined;
  /** The path a tap is opening (useOpeningPath). */
  opening: string | null;
}) {
  const lockLine = useLockLine(lockReason);
  const openButton = useOpenButton();
  const byPane = new Map(agents.map((agent) => [agent.paneId, agent]));
  if (!items.length && !receipts.length) return null;

  return (
    <section aria-label="Needs you" className="flex flex-col gap-2">
      {items.map(({ paneId, interaction, reply }) => {
        const who = asker(byPane.get(paneId), projects, paneId);
        const to = panePath(paneId, session);
        const busy = isOpening(opening, to);
        if (interaction) {
          return <AskRow key={`${paneId}:${interaction.signature}`} interaction={interaction} who={who} to={to} opening={busy} lockLine={lockLine}
            readOnly={lockReason === "read-only"} refused={interactions.refusalFor(interaction)} onAnswer={(option) => interactions.answer(interaction, option)} />;
        }
        if (reply) {
          return <Row key={paneId} who={who} to={to} opening={busy} line={ASK.reply.label}
            actions={<Link to={to} className={openButton}>{ASK.reply.action}</Link>} />;
        }
        return <Row key={paneId} who={who} to={to} opening={busy} line={WAITING} actions={<ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />} />;
      })}
      {receipts.map((receipt) => (
        <QuestionCard key={`receipt:${receipt.paneId}`} compact receipt={receipt} title={asker(byPane.get(receipt.paneId), projects, receipt.paneId).name} onAnswer={() => Promise.resolve({ ok: true })} />
      ))}
    </section>
  );
}

/**
 * One row of Needs you on a quiet card: a small red dot is its only red, then who and where, one line
 * of what it waits on, and its actions at the end. The whole row opens the thread; the actions sit
 * above that link.
 */
function Row({ who, to, opening, line, lineRef, label = line, below, actions }: {
  who: { name: string; where?: string };
  to: string;
  opening: boolean;
  line: ReactNode;
  /** The line's element, to measure whether it is cut short. */
  lineRef?: (el: HTMLElement | null) => void;
  /** The line as words, for the row's name. */
  label?: ReactNode;
  below?: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className="relative flex min-w-0 items-center gap-3 rounded-xl border border-border/70 bg-card py-2.5 pr-3 pl-3.5">
      <StatusDot status="blocked" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Link to={to} aria-busy={opening || undefined} aria-label={[who.name, who.where, typeof label === "string" ? label : null].filter(Boolean).join(", ")}
          className="flex min-w-0 flex-col rounded-md after:absolute after:inset-0 after:rounded-xl">
          <span className="truncate text-subhead font-medium">{who.name}</span>
          <span className="flex min-w-0 items-baseline gap-1 text-footnote text-muted-foreground">
            {/* The place gives up width first: what it waits on is the line's point. */}
            {who.where && <><span className="min-w-0 max-w-[40%] shrink truncate">{who.where}</span><span aria-hidden className="shrink-0">·</span></>}
            <span ref={lineRef} data-ask className="min-w-0 flex-1 truncate">{line}</span>
          </span>
        </Link>
        {below}
      </div>
      <span className="relative flex shrink-0 items-center">{opening ? <OpeningSpinner /> : actions}</span>
    </div>
  );
}

/** What a dialog asks, as the row's line: the command or file a permission would act on, else its question. */
function askOf(i: Interaction): { line: ReactNode; text: string; oneLine: boolean } {
  const target = i.subject?.command ?? i.subject?.file;
  if (i.kind !== "permission") return { line: i.question, text: i.question, oneLine: !i.context };
  if (target === undefined || target.includes("\n")) return { line: i.question, text: i.question, oneLine: false };
  const verb = i.subject?.command !== undefined ? "Run" : (i.subject?.tool ?? "Edit");
  return { line: <>{verb} <code className="font-mono text-code text-foreground">{target}</code>?</>, text: `${verb} ${target}?`, oneLine: true };
}

/** Whether the element's one line is cut short, measured again whenever it resizes. */
function useCutShort(text: string): [(el: HTMLElement | null) => void, boolean] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => setCut(el.scrollWidth > el.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, text]);
  return [setEl, cut];
}

/**
 * A dialog as a row. On a desk its one-tap answers (`oneTapAnswers`, a notification's own) are its
 * buttons, while the line shows the whole ask: a permission's whole command or file, a question whose
 * answers say all they mean in their label (DLG-10). Otherwise, and always on a phone, Answer opens
 * the thread. A tap is the card's answer: one POST under the dialog's signature, re-read and checked
 * by the bridge (ADR 0057). The buttons keep their width while hidden, so measuring the line never
 * moves what it measures.
 */
function AskRow({ interaction: i, who, to, opening, lockLine, readOnly, refused, onAnswer }: {
  interaction: Interaction;
  who: { name: string; where?: string };
  to: string;
  opening: boolean;
  /** Why answers are paused: the buttons stay, disabled, as the card's do. */
  lockLine: string | null;
  /** This device may never answer: no buttons at all, as the card lists options with nothing to press. */
  readOnly: boolean;
  refused: string | undefined;
  onAnswer: (option: InteractionOption) => Promise<AnswerOutcome>;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ tone: "warn" | "error"; text: string } | null>(null);
  const openButton = useOpenButton();
  // The row that replaced a refused one says why nothing was sent, until the next tap.
  useEffect(() => {
    if (refused) setNotice({ tone: "warn", text: refused });
  }, [refused]);
  const ask = askOf(i);
  const [lineRef, cut] = useCutShort(ask.text);
  const answers = oneTapAnswers(i);
  const quick = ask.oneLine && !readOnly && (i.kind === "permission" || answers.every((o) => !o.description)) ? answers : [];
  const inPlace = quick.length > 0 && !cut;

  async function press(option: InteractionOption) {
    if (busy !== null || lockLine !== null) return;
    setBusy(option.index);
    setNotice(null);
    const outcome = await onAnswer(option).catch((err: Error): AnswerOutcome => ({ ok: false, error: err.message || "Answer failed" }));
    setBusy(null);
    if (!outcome.ok) setNotice({ tone: outcome.code === "interaction_changed" ? "warn" : "error", text: outcome.error || "Answer failed" });
  }

  return (
    <Row who={who} to={to} opening={opening} line={ask.line} label={ask.text} lineRef={lineRef}
      below={<>
        {lockLine && <p className="text-footnote text-muted-foreground">{lockLine}</p>}
        {i.autoDenyAt !== undefined && <AutoDeny at={i.autoDenyAt} />}
        {notice && (
          <p role="status" className={cn("flex items-start gap-2 text-footnote", notice.tone === "error" ? "text-destructive" : "text-status-working")}>
            {notice.tone === "error" ? <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" /> : <RefreshCw aria-hidden className="mt-px size-3.5 shrink-0" />}
            <span className="min-w-0">{notice.text}</span>
          </p>
        )}
      </>}
      actions={
        <span className="grid items-center justify-items-end [&>*]:col-start-1 [&>*]:row-start-1">
          {quick.length > 0 && (
            <span inert={!inPlace || undefined} className={cn("flex items-center gap-2 max-sm:hidden", !inPlace && "invisible")}>
              {/* A decline first, as the dialog's own No sits apart from its Yes. */}
              {[...quick].sort((a, b) => Number(b.role === "deny") - Number(a.role === "deny")).map((option) => (
                <Button key={option.index} type="button" size="sm" variant={option.role === "primary" ? "default" : "outline"} title={option.description}
                  disabled={busy !== null || lockLine !== null} aria-busy={busy === option.index || undefined} onClick={() => void press(option)}>
                  {busy === option.index && <Pending aria-hidden className="size-3.5" />}{option.label}
                </Button>
              ))}
            </span>
          )}
          <Link to={to} className={cn(openButton, inPlace && "sm:invisible")}>Answer</Link>
        </span>
      } />
  );
}
