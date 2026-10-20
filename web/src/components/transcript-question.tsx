import { createContext, useContext } from "react";

import { RecommendedBadge, recommendedLabel } from "@/components/recommended-badge";
import { cn } from "@/lib/utils";

export const QuestionReplyContext = createContext<((text: string) => void) | null>(null);
/** Who owns this pane's live dialog: the card at the thread's tail, another dialog surface, or nobody. */
export const QuestionLiveContext = createContext<"card" | "dialog" | null>(null);

export function TranscriptQuestion({ title, options, descriptions, active }: { title: string; options: string[]; descriptions?: string[]; active: boolean }) {
  const live = useContext(QuestionLiveContext);
  const reply = useContext(QuestionReplyContext);
  const prepare = live ? null : reply;
  // The card right under it asks the same question and owns the answer.
  if (active && live === "card") return null;
  const described = descriptions?.some(Boolean) ?? false;
  return <section aria-label="Agent question" className="space-y-2 rounded-lg border bg-muted/30 p-3">
    <p className="text-sm font-medium">{title}</p>
    {/* Options that say what they mean read as rows, label over meaning, like the live card's answers. */}
    {options.length > 0 && <div className={described ? "flex flex-col gap-2" : "flex flex-wrap gap-2"}>
      {options.map((option, index) => {
        // The agent's "(Recommended)" reads as a badge, as on the live card.
        const { text, recommended } = recommendedLabel(option);
        const description = descriptions?.[index];
        return <button key={index} type="button" disabled={!active || !prepare}
          className={cn("inline-flex min-h-11 items-center gap-2 rounded-md border bg-background px-3 text-left text-sm disabled:text-muted-foreground",
            described && "w-full flex-col items-start justify-center gap-0.5 py-2")}
          onClick={() => prepare?.(`${title}\n${option}`)}>
          <span className="inline-flex flex-wrap items-center gap-2">
            {text}
            {recommended && <RecommendedBadge />}
          </span>
          {description && <span className="text-footnote text-muted-foreground">{description}</span>}
        </button>;
      })}
    </div>}
    {active && prepare && <p className="text-xs text-muted-foreground">Choose an option to prepare your reply, or answer in the message field.</p>}
  </section>;
}
