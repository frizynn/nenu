import { useContext, useId, useRef, useState, type ReactNode } from "react";
import { CircleAlert, Check, Clock, Pending, Ellipsis, type IconComponent } from "@/components/ui/icon";

import { ActionGroups } from "@/components/conversation-actions";
import { MarkdownText } from "@/components/markdown-text";
import { PlacedMessage, pathImages } from "@/components/message-images";
import { WorkbenchPopover } from "@/components/ui/workbench-popover";
import type { queueRowStatus } from "@/hooks/use-message-queue";
import { pathPieces } from "@/lib/message-images";
import { FileMediaContext } from "@/lib/file-preview-context";
import { cn } from "@/lib/utils";

// One tone vocabulary for both devices: the queue's own status decides it (hooks/use-message-queue.ts).
export type QueuedTone = ReturnType<typeof queueRowStatus>["tone"];

export interface QueuedAction {
  id: string;
  label: string;
  icon: IconComponent;
  run: () => void;
  disabled?: boolean;
  /** An accessible name that says more than the visible label (it must still contain it). */
  name?: string;
  /** A first tap that only arms a confirm: drawn in the destructive tone. */
  armed?: boolean;
}

// Inline, so the mark flows with the words of the status line it leads.
const MARK = "mr-0.5 inline-block size-3.5 align-[-2px]";
const TONE_ICON: Record<Exclude<QueuedTone, "waiting">, ReactNode> = {
  busy: <Pending aria-hidden="true" className={MARK} />,
  done: <Check aria-hidden="true" className={MARK} />,
  problem: <CircleAlert aria-hidden="true" className={MARK} />,
};

/**
 * One of the operator's own messages that has not reached the conversation yet, drawn the same way
 * whether this device queued it or another one did, at the end of the chat: the bubble, a status
 * line under it and one trailing ⋯ of 44px. A message waiting in a queue wears a Queued badge. What
 * it can do now (Retry, Open Terminal, Read it now, Edit, Remove) is on the line, one tap away, next
 * to the words that call for it (ADR 0117); Send now, which skips the wait, lives behind the ⋯.
 */
export function QueuedMessage({
  text,
  tone,
  label,
  device,
  menuLabel,
  menu,
  remedies = [],
  editor,
}: {
  /** The wire text: prose plus image paths. */
  text: string;
  tone: QueuedTone;
  label: string;
  /** The device that queued it, when it was not this one. */
  device?: string;
  /** The ⋯ button's accessible name. */
  menuLabel: string;
  menu: QueuedAction[];
  remedies?: QueuedAction[];
  /** Replaces the bubble's text while the message is edited in place. */
  editor?: ReactNode;
}) {
  const { pieces, paths } = pathPieces(text);
  const media = useContext(FileMediaContext);
  const [open, setOpen] = useState(false);
  // The message started going (or went) while its menu was open: the ⋯ is gone, so is its menu, and
  // it stays closed if the ⋯ comes back.
  if (open && !menu.length) setOpen(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // The ⋯ is described by the message it manages, so two of them read apart.
  const bubbleId = useId();
  const queued = tone === "waiting";
  return (
    <div className="flex flex-col items-end">
      <div
        id={bubbleId}
        className={cn(
          "max-w-[85%] min-w-0 space-y-1.5 rounded-xl rounded-br-md bg-muted px-3.5 py-2 [overflow-wrap:anywhere]",
          // Not in the conversation yet: a quieter ink, never a translucent one.
          (tone === "waiting" || tone === "busy") && !editor && "text-muted-foreground",
          editor && "w-full max-w-full",
        )}
      >
        {editor ?? (
          <>
            <PlacedMessage pieces={pieces} images={pathImages(paths, media)}
              words={(words, key) => <MarkdownText key={key} text={words} query="" />} />
          </>
        )}
      </div>
      {/* The words take the line while they leave them 15rem; past that (a long failure next to Open
          Terminal on a phone) the buttons wrap under them, together, instead of squeezing the words
          into a column or leaving the ⋯ on a row of its own. Every line ends under the bubble's edge
          and its mark leads its words. Nenu's own short words stay one right-aligned run even when
          they wrap; a failure is the bridge's sentence, so once it wraps it reads as a paragraph. */}
      <div className="flex w-full flex-wrap items-center justify-end gap-x-1">
        <p
          role="status"
          aria-live="polite"
          className={cn("min-w-0 grow basis-60 px-1 py-1 text-right text-pretty text-footnote text-muted-foreground [overflow-wrap:anywhere]", tone === "problem" && "text-destructive")}
        >
          <span className={cn(tone === "problem" && "inline-block text-left")}>
            {queued ? (
              <span className="mr-0.5 inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 align-middle text-micro text-foreground">
                <Clock aria-hidden="true" className="size-3" />
                Queued
              </span>
            ) : (
              TONE_ICON[tone]
            )}{" "}
            {label}
            {/* Bound to its dot, so a wrapped line breaks before the device, never inside "· from". */}
            {device ? ` ·\u00a0from\u00a0${device}` : null}
          </span>
        </p>
        {(remedies.length > 0 || menu.length > 0) && (
          <div className="flex shrink-0 items-center gap-x-1">
            {remedies.map(({ id, label: text, icon: Icon, run, disabled, name, armed }) => (
              <button
                key={id}
                type="button"
                aria-label={name}
                disabled={disabled}
                onClick={run}
                className={cn(
                  "flex min-h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-footnote font-medium text-foreground hover:bg-hover disabled:text-disabled-foreground coarse:min-h-11",
                  armed && "bg-destructive/10 text-destructive hover:bg-destructive/15",
                )}
              >
                <Icon aria-hidden="true" className="size-3.5" />
                {text}
              </button>
            ))}
            {menu.length > 0 && (
              <button
                ref={trigger}
                type="button"
                aria-label={menuLabel}
                aria-describedby={bubbleId}
                aria-haspopup="dialog"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
                className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-hover hover:text-foreground active:bg-muted"
              >
                <Ellipsis aria-hidden="true" className="size-5" />
              </button>
            )}
          </div>
        )}
      </div>
      <WorkbenchPopover
        open={open}
        onDismiss={() => setOpen(false)}
        anchorRef={trigger}
        label="Queued message"
        className="w-56 [&>div:first-child]:hidden [&>div:last-child]:p-1.5"
      >
        <ActionGroups
          groups={[{ label: "Queued message", actions: menu }]}
          onRun={(run) => {
            setOpen(false);
            run();
          }}
        />
      </WorkbenchPopover>
    </div>
  );
}
