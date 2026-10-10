import { createContext, useContext } from "react";

export const QuestionReplyContext = createContext<((text: string) => void) | null>(null);
/** The bridge holds this pane's dialog as a QuestionCard, which then owns the answer. */
export const QuestionLiveContext = createContext(false);

export function TranscriptQuestion({ title, options, active }: { title: string; options: string[]; active: boolean }) {
  const live = useContext(QuestionLiveContext);
  const reply = useContext(QuestionReplyContext);
  const prepare = live ? null : reply;
  return <section aria-label="Agent question" className="space-y-2 rounded-lg border bg-muted/30 p-3">
    <p className="text-sm font-medium">{title}</p>
    {options.length > 0 && <div className="flex flex-wrap gap-2">
      {options.map((option, index) => <button key={index} type="button" disabled={!active || !prepare}
        className="min-h-11 rounded-md border bg-background px-3 text-sm disabled:opacity-60"
        onClick={() => prepare?.(`${title}\n${option}`)}>{option}</button>)}
    </div>}
    {active && prepare && <p className="text-xs text-muted-foreground">Choose an option to prepare your reply, or answer in the message field.</p>}
    {active && live && <p className="text-xs text-muted-foreground">Answer it in the card below.</p>}
  </section>;
}
