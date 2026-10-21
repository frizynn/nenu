import type { ComponentProps, ReactNode } from "react";
import { Check } from "@/components/ui/icon";

import { RecommendedBadge, recommendedLabel } from "@/components/recommended-badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// The one shared visual language for a dialog: the card every dialog is drawn as (the bridge's
// QuestionCard and each block a grammar lifts off the screen), its option list and its actions. One
// source, so a menu, a preview and a permission can't drift into different styles again. Theme tokens
// only, and no `dark:` variant: a block also renders inside the terminal mirror (ADR 0002).
//
// XSS boundary unchanged: labels/descriptions passed in are React text nodes; nothing is ever set as
// innerHTML.

/** The card's surface: an elevated card with a hairline and no shadow (direction.md), in the thread and the mirror. */
export const DIALOG_CARD = "flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-4";

/** The card's status: the blocked dot carries the urgency, the words stay plain (direction.md). */
export function WaitingOnYou() {
  return (
    <span className="flex shrink-0 items-center gap-2 font-medium text-foreground">
      <span aria-hidden className="size-2 rounded-full bg-status-blocked" />
      Waiting on you
    </span>
  );
}

/**
 * A dialog a grammar lifted off the screen, drawn as the card: the status line, then the block's own
 * content. Named by its question, like the QuestionCard.
 */
export function DialogCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} data-dialog-card className={DIALOG_CARD}>
      <div className="flex min-w-0 items-center gap-2 text-footnote">
        <WaitingOnYou />
      </div>
      {children}
    </section>
  );
}

/** The card's question, the same headline on Home and in the thread, always whole. */
export function QuestionHeading({ children }: { children: ReactNode }) {
  return <p className="text-headline text-pretty text-foreground">{children}</p>;
}

/**
 * The option list every card draws, whatever the kind: one grouped surface with a hairline between
 * rows, the rows' radius (lg). Its rows clip to it, so a row's focus ring is drawn inside (see
 * `optionRow`).
 */
export const OPTION_LIST = "flex min-w-0 flex-col divide-y divide-border overflow-hidden rounded-lg border border-border";

export function OptionList({ className, ...props }: ComponentProps<"div">) {
  return <div role="group" data-option-list {...props} className={cn(OPTION_LIST, className)} />;
}

/** A chosen row (the previewed design, a ticked box, the current answer): the neutral fill of a
 *  selected row elsewhere in the app. The blue stays on its radio, checkbox or check. */
export const ROW_SELECTED = "bg-[var(--workbench-row-selected)]";

/**
 * Surface tone of an option row:
 *  - `default`  — a plain, selectable choice.
 *  - `selected` — the TUI's current/chosen row (ROW_SELECTED).
 *  - `busy`     — this option's keystroke is in flight: the same fill, and NOT dimmed even while the
 *                 button is disabled (the caller renders a spinner in the trailing slot), so the
 *                 pressed row stays visibly distinct while its siblings dim.
 */
export type OptionTone = "default" | "selected" | "busy";

/** A row of the option list: 36 px on a fine pointer, 44 on a coarse one, a tint on hover and press. */
export function optionRow(tone: OptionTone = "default"): string {
  return cn(
    "flex min-h-9 w-full min-w-0 items-center gap-3 px-3.5 py-1.5 text-left select-none coarse:min-h-11 coarse:py-2",
    "transition-colors duration-120 ease-out motion-reduce:transition-none focus-visible:outline-offset-[-2px] disabled:cursor-not-allowed",
    tone === "default" ? "enabled:hover:bg-[var(--workbench-row-hover)] enabled:active:bg-[var(--workbench-row-selected)]" : ROW_SELECTED,
  );
}

/** An option's title, with the agent's "(Recommended)" suffix drawn as the badge every card uses. */
export function OptionLabel({ label, dim = false }: { label: string; dim?: boolean }) {
  const { text, recommended } = recommendedLabel(label);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
      <span data-option-title className={cn("min-w-0 break-words text-body font-medium", dim ? "text-muted-foreground" : "text-foreground")}>{text}</span>
      {recommended && <RecommendedBadge />}
    </span>
  );
}

/** What an option means, under its title. `clamp` cuts it to two lines (Home measures the cut). */
export function OptionDescription({ clamp = false, children }: { clamp?: boolean; children: ReactNode }) {
  return <span data-description className={cn("break-words text-footnote text-muted-foreground", clamp && "line-clamp-2")}>{children}</span>;
}

/** A multi-select row's box: the blue is the tick, never the row. */
export function OptionCheckbox({ checked }: { checked: boolean }) {
  return (
    <span aria-hidden className={cn("flex size-5 shrink-0 items-center justify-center rounded-sm border",
      checked ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground")}>
      {checked && <Check className="size-3.5" />}
    </span>
  );
}

/** A one-of-many row's radio: the blue is the dot, never the row. */
export function OptionRadio({ checked }: { checked: boolean }) {
  return (
    <span aria-hidden className={cn("flex size-5 shrink-0 items-center justify-center rounded-full border-2",
      checked ? "border-primary" : "border-muted-foreground")}>
      {checked && <span className="size-2.5 rounded-full bg-primary" />}
    </span>
  );
}

/** A full option row: a leading control (box, radio), label + description, and a trailing slot
 *  (spinner or a state mark). Every block's options are these, inside an OptionList. */
export function OptionButton({
  tone = "default",
  label,
  description,
  leading,
  trailing,
  disabled,
  className,
  ...props
}: Omit<ComponentProps<"button">, "children"> & {
  tone?: OptionTone;
  label: string;
  description?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <button type="button" disabled={disabled} {...props} className={cn(optionRow(tone), className)}>
      {leading}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <OptionLabel label={label} dim={disabled && tone !== "busy"} />
        {description ? <OptionDescription>{description}</OptionDescription> : null}
      </span>
      {trailing}
    </button>
  );
}

/** The card's one commit, as a class for a control that is not a Button: the Button's large primary. */
export const PRIMARY_ACTION = cn(buttonVariants({ size: "block" }));
/** A second key the screen names that commits too, beside the primary but never as loud. */
export const NEUTRAL_ACTION = cn(buttonVariants({ variant: "secondary", size: "block" }));
/** An escape or a utility under the card (Cancel, Chat about this, Add a note…): plain text, neutral. */
export const SECONDARY_ACTION =
  "inline-flex min-h-11 select-none items-center gap-1.5 rounded-lg px-2 text-subhead font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted disabled:text-disabled-foreground";
/** The row of SECONDARY_ACTIONs, bled into the card's padding so their text lines up with the content. */
export const SECONDARY_ROW = "-mx-2 -mb-2 flex flex-wrap items-center";

/** The card's footer of escapes and utilities, apart from the answers above it. */
export function SecondaryActions({ children }: { children: ReactNode }) {
  return <div data-secondary-actions className={SECONDARY_ROW}>{children}</div>;
}

/**
 * The enclosing surface for a block that is not a dialog (the completion popup): a bordered panel
 * that lifts it off the raw terminal mirror behind it. Owns `role="group"` + its aria label.
 */
export function PromptPanel({ ariaLabel, children }: { ariaLabel: string; children: ReactNode }) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="my-1.5 flex flex-col gap-1.5 rounded-xl border border-border bg-card p-1.5 shadow-sm"
    >
      {children}
    </div>
  );
}

/** The compact caption above a PromptPanel's rows. Non-semantic (the group is already labelled). */
export function OptionGroupCaption({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 pl-0.5">
      <span aria-hidden className="h-3 w-0.5 shrink-0 rounded-full bg-primary/60" />
      <span className="text-footnote font-medium text-muted-foreground">
        {children}
      </span>
    </div>
  );
}
