import { useId, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { ChatCircle, Check, ChevronRight, ExternalLink, TriangleAlert } from "@/components/ui/icon";

import { AskContext } from "@/components/ask-context";
import { errorMessage } from "@/components/node-start";
import { StatusDot } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { answerOrgAsk, sendMessage } from "@/lib/api";
import { coordinatorName, linkChip, partText, unclosed, type AskEntry, type askSections, type ChipTone, type Unclosed } from "@/lib/asks";
import type { AskGroup } from "@/lib/types";
import { timeAgo } from "@/lib/format";
import { nodePath } from "@/lib/nav";
import { cn } from "@/lib/utils";

// The asks of Your asks and of a coordinator's card, drawn by one component (ADR 0093): each group under
// its label, each row its words, whose it is, its answer or why it does not close, its links as chips,
// and Answer on an ask that waits on you where Organizations can take one. A question carries its parts
// (the decisions about the same thread or task) and opens its context in place: the report of the
// thread behind it, with Answer at its foot (ADR 0096).

type Sections = ReturnType<typeof askSections>;

/** An ask's mark in its group: red waits on you, a warning does not close, yellow is in progress, a check is done. */
export function AskMark({ group }: { group: AskGroup }) {
  const box = "flex size-4 shrink-0 items-center justify-center";
  if (group === "unclosed") return <span className={box}><TriangleAlert aria-hidden size={14} className="text-status-working" /></span>;
  if (group === "done") return <span className={box}><Check aria-hidden size={14} className="text-status-done" /></span>;
  if (group === "other") return <span className={box}><span aria-hidden className="size-1 rounded-full bg-muted-foreground" /></span>;
  return <span className={box}><StatusDot status={group === "waiting" ? "blocked" : "working"} surface="bg-transparent" className="size-2" /></span>;
}


const TONE_CLASS: Record<ChipTone, string> = {
  waiting: "bg-status-blocked", moving: "bg-status-working", review: "bg-primary", done: "bg-status-done", off: "bg-muted-foreground/60",
};

export function AskSections({ sections, session, whose, answers, readOnly, compact = false }: {
  sections: Sections;
  session?: string;
  /** Name each row's project and coordinator, and link the row to that coordinator: Your asks does, a coordinator's own card does not. */
  whose: boolean;
  /** This Organizations can answer an ask. */
  answers: boolean;
  /** A read-only device: nothing is sent to a coordinator from here. */
  readOnly: boolean;
  /** A card's lighter headings. */
  compact?: boolean;
}) {
  // Answered here, until the next read of the asks moves the row where Organizations puts it.
  const [answered, setAnswered] = useState<Record<string, string>>({});
  if (sections.length === 0) return null;
  const answer = (entry: AskEntry, group: AskGroup): Answering => ({
    answer: answered[entry.key],
    answerable: answers && entry.answerable && group === "waiting" && entry.line > 0,
    onAnswered: (text) => setAnswered((current) => ({ ...current, [entry.key]: text })),
  });
  return <div className={cn("flex flex-col", compact ? "gap-3" : "gap-6")}>
    {sections.map((section) => (
      <section key={section.group} aria-label={section.label}>
        <h2 className={cn("flex items-center gap-2 pb-1 text-footnote font-medium text-muted-foreground", !compact && "px-2.5", compact && "font-semibold")}>
          <span className={compact ? undefined : "text-foreground"}>{section.label}</span><span className="font-normal tabular-nums">{section.entries.length}</span>
        </h2>
        <ul className="flex flex-col">
          {section.entries.map((entry) => <AskItem key={entry.key} entry={entry} session={session} whose={whose} compact={compact} readOnly={readOnly}
            answering={answer(entry, section.group)} parts={entry.parts.map((part) => answer(part, section.group))} />)}
        </ul>
      </section>
    ))}
  </div>;
}

/** One line's answer: what was answered here, whether it takes one, and the hand-off once sent. */
interface Answering {
  /** What was answered here, before the asks are read again. */
  answer?: string;
  answerable: boolean;
  onAnswered: (text: string) => void;
}

function AskItem({ entry, session, whose, compact, readOnly, answering, parts }: {
  entry: AskEntry;
  session?: string;
  whose: boolean;
  compact: boolean;
  readOnly: boolean;
  answering: Answering;
  /** The answer of each of its parts, in order. */
  parts: Answering[];
}) {
  const [writing, setWriting] = useState(false);
  const [open, setOpen] = useState(false);
  const { answer } = answering;
  const line = [whose && entry.project.name, whose && coordinatorName(entry.coordinator), answer === undefined && entry.detail].filter(Boolean).join(" · ");
  const coordinator = nodePath(entry.project.slug, entry.coordinator.id, session);
  const why = unclosed(entry);
  // A row with nothing behind it (no thread, task or page) has no context to open.
  const explained = [entry, ...entry.parts].some((part) => part.links.length > 0);
  const answerable = answering.answerable && answer === undefined;
  const answerButton = answerable && !writing &&
    <button type="button" className="quiet-action" aria-label={`Answer ${entry.text}`} onClick={() => setWriting(true)}>Answer</button>;
  const answerForm = answerable && writing &&
    <AnswerForm entry={entry} session={session} onCancel={() => setWriting(false)} onAnswered={(text) => { setWriting(false); answering.onAnswered(text); }} />;
  return (
    <li className={cn("flex min-w-0 items-start gap-2.5 rounded-lg py-2", !compact && "px-2.5")}>
      <span className="pt-0.5">{answer === undefined ? <AskMark group={entry.group} /> : <AskMark group="done" />}</span>
      <div className="min-w-0 flex-1">
        {whose
          ? <Link to={coordinator} className="block break-words text-subhead hover:underline underline-offset-2">{entry.text}</Link>
          : <p className="break-words text-subhead">{entry.text}</p>}
        {line && <p className="break-words text-footnote text-muted-foreground">{line}</p>}
        <Answered answer={answer} at={entry.answeredAt} />
        {why && <Why why={why} entry={entry} session={session} readOnly={readOnly} />}
        {entry.links.length > 0 && <Chips entry={entry} links={entry.links} session={session} />}
        {entry.parts.length > 0 && <ul aria-label="Parts of this question" className="mt-2 flex flex-col gap-2">
          {entry.parts.map((part, index) => <Part key={part.key} head={entry} part={part} session={session} answering={parts[index]!} />)}
        </ul>}
        <div className="mt-1 -ml-2 flex flex-wrap items-center">
          {explained && <button type="button" className="quiet-action" aria-expanded={open} onClick={() => setOpen(!open)}>
            <ChevronRight aria-hidden className={cn("size-3.5 transition-transform", open && "rotate-90")} />Context
          </button>}
          {!open && answerButton}
        </div>
        {!open && answerForm}
        {open && explained && <AskContext entry={entry} session={session}>
          {answerable && <div className="mt-3 -ml-2 border-t border-border pt-2">{answerButton}{answerForm}</div>}
        </AskContext>}
      </div>
    </li>
  );
}

/** One part of a question: a decision about the same thread or task, with its own line and Answer. */
function Part({ head, part, session, answering }: { head: AskEntry; part: AskEntry; session?: string; answering: Answering }) {
  const [writing, setWriting] = useState(false);
  const { answer } = answering;
  return <li className="min-w-0 border-l-2 border-border pl-3">
    <p className="break-words text-subhead">{partText(head, part)}</p>
    {answer === undefined && part.detail && <p className="break-words text-footnote text-muted-foreground">{part.detail}</p>}
    <Answered answer={answer} at={part.answeredAt} />
    {part.links.length > 0 && <Chips entry={part} links={part.links} session={session} />}
    {answering.answerable && answer === undefined && (writing
      ? <AnswerForm entry={part} session={session} onCancel={() => setWriting(false)} onAnswered={(text) => { setWriting(false); answering.onAnswered(text); }} />
      : <button type="button" className="quiet-action mt-1 -ml-2" aria-label={`Answer ${part.text}`} onClick={() => setWriting(true)}>Answer</button>)}
  </li>;
}

function Answered({ answer, at }: { answer?: string; at?: string }) {
  if (answer !== undefined) return <p className="break-words text-footnote text-muted-foreground"><span className="font-medium text-status-done">Answered</span> · {answer}</p>;
  if (!at) return null;
  return <p className="text-footnote text-muted-foreground"><span className="font-medium text-status-done">Answered</span> {timeAgo(Date.parse(at), Date.now())}</p>;
}

function Chips({ entry, links, session }: { entry: AskEntry; links: AskEntry["links"]; session?: string }) {
  return <ul aria-label="Links" className="mt-1.5 flex flex-wrap gap-1.5">
    {links.map((link, index) => <li key={index}><Chip chip={linkChip(link)} project={entry.project.slug} session={session} /></li>)}
  </ul>;
}

/**
 * Why a row does not close, in plain words: what is still open and where. Its coordinator wrote the
 * line, so the remedy is to ask it, through the guarded send, after a confirm, where its pane is live.
 */
function Why({ why, entry, session, readOnly }: { why: Unclosed; entry: AskEntry; session?: string; readOnly: boolean }) {
  const [asking, setAsking] = useState(false);
  const [asked, setAsked] = useState(false);
  const pane = coordinatorPane(entry);
  return <div className="mt-1">
    <p className="break-words text-footnote font-medium text-status-working">{why.said}</p>
    {why.title && <p className="break-words text-footnote text-muted-foreground">{why.title}</p>}
    {asked ? <p className="mt-1 text-footnote text-muted-foreground">Asked its coordinator.</p>
      : pane && !readOnly && <button type="button" className="quiet-action mt-1 -ml-2" onClick={() => setAsking(true)}>
        <ChatCircle aria-hidden className="size-3.5" />Ask the coordinator</button>}
    {pane && <AskCoordinator open={asking} paneId={pane} session={session} why={why} name={coordinatorName(entry.coordinator)}
      onCancel={() => setAsking(false)} onAsked={() => { setAsking(false); setAsked(true); }} />}
  </div>;
}

/** The live pane of a row's coordinator, as the snapshot binds it; undefined when it is not running. */
function coordinatorPane(entry: AskEntry): string | undefined {
  const { project, coordinator } = entry;
  return coordinator.id === "root" ? project.coordinator?.paneId : project.threads.find((thread) => thread.id === coordinator.id)?.paneId;
}

function AskCoordinator({ open, paneId, session, why, name, onCancel, onAsked }: {
  open: boolean; paneId: string; session?: string; why: Unclosed; name: string; onCancel: () => void; onAsked: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ask = async () => {
    setBusy(true);
    setError(null);
    try {
      const outcome = await sendMessage(paneId, { text: why.request, requestId: crypto.randomUUID() }, session);
      if (outcome.ok) onAsked();
      else setError(outcome.error);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => { setError(null); onCancel(); };
  return (
    <Dialog open={open} onClose={cancel} title="Ask the coordinator?"
      description={<>Nenu asks {name} to close what is still open, or to update the line and say why. {why.said}</>}>
      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="ghost" size="lg" onClick={cancel} disabled={busy}>Cancel</Button>
        <Button type="button" size="lg" onClick={() => void ask()} disabled={busy} aria-busy={busy || undefined}>{busy ? "Sending…" : "Ask the coordinator"}</Button>
      </div>
    </Dialog>
  );
}

/** A link as a short chip: a dot in its state's colour, what it points at, and the state in words. */
function Chip({ chip, project, session }: { chip: ReturnType<typeof linkChip>; project: string; session?: string }) {
  const body = <>
    <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TONE_CLASS[chip.tone])} />
    <span className="max-w-[12rem] truncate font-medium text-foreground">{chip.label}</span>
    {chip.state && <span className="shrink-0">{chip.state}</span>}
    {chip.href && <ExternalLink aria-hidden className="size-3 shrink-0" />}
  </>;
  const shape = "inline-flex h-6 max-w-full items-center gap-1.5 rounded-md bg-muted px-2 text-caption text-muted-foreground";
  if (chip.thread) return <Link to={nodePath(project, chip.thread, session)} className={cn(shape, "hover:bg-accent")}>{body}</Link>;
  if (chip.href) return <a href={chip.href} target="_blank" rel="noreferrer" className={cn(shape, "hover:bg-accent")}>{body}</a>;
  return <span className={shape}>{body}</span>;
}

/** The person's answer, on one line, sent to the coordinator's STATUS.md through Organizations. */
function AnswerForm({ entry, session, onCancel, onAnswered }: {
  entry: AskEntry;
  session?: string;
  onCancel: () => void;
  onAnswered: (text: string) => void;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const answer = text.trim();
    if (!answer || busy) return;
    setBusy(true);
    setError(null);
    try {
      await answerOrgAsk({ project: entry.project.slug, coordinator: entry.coordinator.id, line: entry.line, text: answer }, session);
      onAnswered(answer);
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  }

  return (
    <form className="mt-2 flex flex-col gap-2" onSubmit={(event) => void submit(event)}>
      <label htmlFor={id} className="sr-only">Your answer</label>
      {/* STATUS.md keeps an ask on one line, so a line break becomes a space. */}
      <textarea id={id} rows={2} value={text} maxLength={2_000} autoFocus disabled={busy}
        onChange={(event) => setText(event.target.value.replace(/[\r\n]+/g, " "))}
        className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-subhead" />
      {error && <p role="alert" className="text-footnote text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !text.trim()} aria-busy={busy || undefined}>
          {busy ? "Sending…" : <><Check aria-hidden className="size-3.5" />Send answer</>}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
