import { useId, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { Check, ExternalLink, TriangleAlert } from "@/components/ui/icon";

import { errorMessage } from "@/components/node-start";
import { StatusDot } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { answerOrgAsk } from "@/lib/api";
import { coordinatorName, linkChip, type AskEntry, type askSections, type ChipTone } from "@/lib/asks";
import type { AskGroup } from "@/lib/types";
import { nodePath } from "@/lib/nav";
import { cn } from "@/lib/utils";

// The asks of Your asks and of a coordinator's card, drawn by one component (ADR 0093): each group under
// its label, each row its words, whose it is, its answer or why it does not close, its links as chips,
// and Answer on an ask that waits on you where Organizations can take one.

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

export function AskSections({ sections, session, whose, answers, compact = false }: {
  sections: Sections;
  session?: string;
  /** Name each row's project and coordinator, and link the row to that coordinator: Your asks does, a coordinator's own card does not. */
  whose: boolean;
  /** This Organizations can answer an ask. */
  answers: boolean;
  /** A card's lighter headings. */
  compact?: boolean;
}) {
  // Answered here, until the next read of the asks moves the row where Organizations puts it.
  const [answered, setAnswered] = useState<Record<string, string>>({});
  if (sections.length === 0) return null;
  return <div className={cn("flex flex-col", compact ? "gap-3" : "gap-6")}>
    {sections.map((section) => (
      <section key={section.group} aria-label={section.label}>
        <h2 className={cn("flex items-center gap-2 pb-1 text-footnote font-medium text-muted-foreground", !compact && "px-2.5", compact && "font-semibold")}>
          <span className={compact ? undefined : "text-foreground"}>{section.label}</span><span className="font-normal tabular-nums">{section.entries.length}</span>
        </h2>
        <ul className="flex flex-col">
          {section.entries.map((entry) => <AskItem key={entry.key} entry={entry} session={session} whose={whose} compact={compact}
            answer={answered[entry.key]} answerable={answers && section.group === "waiting" && entry.line > 0}
            onAnswered={(text) => setAnswered((current) => ({ ...current, [entry.key]: text }))} />)}
        </ul>
      </section>
    ))}
  </div>;
}

function AskItem({ entry, session, whose, compact, answer, answerable, onAnswered }: {
  entry: AskEntry;
  session?: string;
  whose: boolean;
  compact: boolean;
  /** What was answered here, before the asks are read again. */
  answer?: string;
  answerable: boolean;
  onAnswered: (text: string) => void;
}) {
  const [writing, setWriting] = useState(false);
  const line = [whose && entry.project.name, whose && coordinatorName(entry.coordinator), answer === undefined && entry.detail].filter(Boolean).join(" · ");
  const coordinator = nodePath(entry.project.slug, entry.coordinator.id, session);
  return (
    <li className={cn("flex min-w-0 items-start gap-2.5 rounded-lg py-2", !compact && "px-2.5")}>
      <span className="pt-0.5">{answer === undefined ? <AskMark group={entry.group} /> : <AskMark group="done" />}</span>
      <div className="min-w-0 flex-1">
        {whose
          ? <Link to={coordinator} className="block break-words text-subhead hover:underline underline-offset-2">{entry.text}</Link>
          : <p className="break-words text-subhead">{entry.text}</p>}
        {line && <p className="break-words text-footnote text-muted-foreground">{line}</p>}
        {answer !== undefined && <p className="break-words text-footnote text-muted-foreground"><span className="font-medium text-status-done">Answered</span> · {answer}</p>}
        {entry.links.length > 0 && <ul aria-label="Links" className="mt-1.5 flex flex-wrap gap-1.5">
          {entry.links.map((link, index) => <li key={index}><Chip chip={linkChip(link)} project={entry.project.slug} session={session} /></li>)}
        </ul>}
        {answerable && answer === undefined && (writing
          ? <AnswerForm entry={entry} session={session} onCancel={() => setWriting(false)} onAnswered={(text) => { setWriting(false); onAnswered(text); }} />
          : <button type="button" className="quiet-action mt-1 -ml-2" aria-label={`Answer ${entry.text}`} onClick={() => setWriting(true)}>Answer</button>)}
      </div>
    </li>
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
