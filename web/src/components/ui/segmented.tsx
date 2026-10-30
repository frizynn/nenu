import { useRef, type KeyboardEvent } from "react";

import type { IconComponent } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: IconComponent;
}

const STEP: Partial<Record<string, number>> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/** A segmented control: a neutral thumb slides under the selected option. The accent stays for
 *  focus and on-states, so a choice never reads as the page's call to action. One tab stop; the
 *  arrow keys move the selection, as a radio group's do. */
export function Segmented<T extends string>({ label, options, value, onChange, className }: {
  label: string;
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  const radios = useRef<Array<HTMLButtonElement | null>>([]);
  const index = Math.max(0, options.findIndex((o) => o.value === value));

  function onKeyDown(event: KeyboardEvent) {
    // Alt+Left is Back and Cmd+arrows move through text: the browser's, not a change of option.
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const step = STEP[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    onChange(options[next]!.value);
    radios.current[next]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn("relative grid h-9 rounded-md bg-muted p-0.5 coarse:h-11", className)}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0.5 left-0.5 rounded-sm bg-card shadow-[0_1px_2px_rgb(0_0_0/0.12)] transition-transform duration-120 ease-out motion-reduce:transition-none dark:bg-input"
        style={{ width: `calc((100% - 4px) / ${options.length})`, transform: `translateX(${index * 100}%)` }}
      />
      {options.map((option, i) => {
        const selected = i === index;
        return (
          <button
            key={option.value}
            ref={(el) => {
              radios.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={cn(
              "hit-area relative flex select-none items-center justify-center gap-1.5 rounded-sm text-subhead transition-colors duration-120 ease-out motion-reduce:transition-none",
              selected ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.icon && <option.icon aria-hidden="true" className="size-4 shrink-0" />}
            <span className="min-w-0 truncate">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
