import { useId, type ReactNode } from "react";

// A grouped inset list, as iOS Settings draws one: a 13px header, one card holding the rows with a
// hairline between them that starts at the text, and a 13px footer for what the rows need said.

/** One row's box: 44px on a coarse pointer, 40px on a fine one, a hairline above every row but the
 *  first. For a row that is itself a control (a disclosure, a menu), spread it on that element. */
export const listRowClass =
  "relative flex min-h-10 w-full items-center gap-3 px-4 py-2 text-left coarse:min-h-11 not-first:before:absolute not-first:before:top-0 not-first:before:right-0 not-first:before:left-4 not-first:before:h-px not-first:before:bg-border";

/** The press and hover tint of a row that is a control, clipped to the card's corners. */
export const listRowPressable =
  "select-none transition-colors duration-120 ease-out first:rounded-t-xl last:rounded-b-xl hover:bg-hover active:bg-muted motion-reduce:transition-none focus-visible:outline-offset-[-2px]";

export function ListSection({ title, footer, children }: { title?: ReactNode; footer?: ReactNode; children: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={title ? headingId : undefined} className="flex flex-col">
      {title && (
        <h2 id={headingId} className="px-4 pb-1.5 text-footnote font-medium text-muted-foreground">
          {title}
        </h2>
      )}
      <div data-slot="list-group" className="flex flex-col rounded-xl border bg-card text-card-foreground">
        {children}
      </div>
      {footer && <div className="px-4 pt-1.5 text-footnote text-pretty text-muted-foreground">{footer}</div>}
    </section>
  );
}

/** A row: a title, an optional hint under it (a sentence, or a line of status), and its control at
 *  the end. */
export function ListRow({ title, hint, children }: { title: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div data-slot="list-row" className={listRowClass}>
      <div className="min-w-0 flex-1">
        <div className="text-body">{title}</div>
        {hint && <div className="text-footnote text-pretty text-muted-foreground">{hint}</div>}
      </div>
      {children}
    </div>
  );
}
