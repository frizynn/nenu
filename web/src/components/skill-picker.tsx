import { useEffect, useRef } from "react";
import { BookOpen, Terminal } from "lucide-react";
import type { SkillOption } from "@/lib/skill-completion";

interface SkillPickerProps {
  /** Use this id for the composer's aria-controls; active option is `${id}-option-${activeIndex}`. */
  id: string;
  skills: readonly SkillOption[];
  total: number;
  activeIndex: number;
  onSelect: (skill: SkillOption) => void;
  label?: string;
  loading?: boolean;
  error?: boolean;
  truncated?: boolean;
  onRetry?: () => void;
}

/** An input-owned suggestion popup: it never takes focus and never sends a message. */
export function SkillPicker({ id, skills, total, activeIndex, onSelect, label = "Skills", loading, error, truncated, onRetry }: SkillPickerProps) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = listRef.current;
    const row = list?.children[activeIndex] as HTMLElement | undefined;
    if (!list || !row) return;
    // Scroll just this list; scrollIntoView could move the surrounding composer on a phone.
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
    }
  }, [activeIndex, skills.length]);

  return (
    <div className="absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 text-xs text-muted-foreground">
        <span className="font-medium">{label} · {skills.length === total ? total : `${skills.length} / ${total}`}{truncated ? "+" : ""}</span>
        <span className="hidden text-caption sm:inline">↑↓ navigate · Tab to insert</span>
      </div>
      <div ref={listRef} id={id} role="listbox" aria-label={label} className="relative max-h-[min(18rem,40dvh)] overflow-y-auto overscroll-contain p-1">
        {skills.map((skill, index) => (
          <div
            key={skill.invocation}
            id={`${id}-option-${index}`}
            role="option"
            aria-selected={activeIndex === index}
            className={`flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 ${activeIndex === index ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(skill)}
          >
            {skill.kind === "command" ? <Terminal aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /> : <BookOpen aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
            <div className="min-w-0 flex-1">
              <div className="truncate text-subhead font-medium">{skill.invocation}</div>
              <div className="truncate text-footnote text-muted-foreground">{skill.description || skill.invocation}</div>
            </div>
          </div>
        ))}
      </div>
      {loading ? <p className="px-3 py-2 text-xs text-muted-foreground" role="status">Loading skills…</p>
        : error ? <p className="px-3 py-2 text-xs text-muted-foreground" role="status">Skills unavailable. <button type="button" className="min-h-8 px-1 underline" onMouseDown={(event) => event.preventDefault()} onClick={onRetry}>Retry</button></p>
        : skills.length === 0 && <p className="px-3 py-3 text-xs text-muted-foreground" role="status">No matching {label.toLowerCase()}</p>}
    </div>
  );
}
