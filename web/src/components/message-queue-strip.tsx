import { useRef, useState } from "react";
import { Check, Pencil, Send, Trash2, X, Zap } from "@/components/ui/icon";
import type { QueueMessage } from "@/lib/api";
import { queueRowStatus, type DeliveredRow } from "@/hooks/use-message-queue";
import { draftFromWire, editChips, serializeDraft } from "@/lib/message-images";
import { DraftChipLayer } from "./draft-chip-layer";
import { QueuedMessage, type QueuedAction } from "./queued-message";

/**
 * The messages waiting in Nenu's queue (and in Claude's own) that have no bubble in this device's
 * conversation: queued on another device, or before this page loaded. Each is drawn as the same
 * QueuedMessage this device uses for its own, with the same status copy, so a message reads the same
 * whichever device it was typed on. Delivery semantics are the queue's (ADR 0056); this only draws it.
 */
export function MessageQueueStrip({
  agent,
  messages,
  delivered = [],
  busy,
  error,
  change,
  readNow,
  readNowArmed = null,
}: {
  agent?: string | null;
  messages: QueueMessage[];
  /** Rows handed to the CLI that its own queue still holds (Claude's `enqueued`). */
  delivered?: DeliveredRow[];
  busy: boolean;
  error: string;
  change: (
    action: "edit" | "remove" | "send",
    text?: string,
    item?: QueueMessage,
  ) => Promise<boolean>;
  /** First tap arms (`readNowArmed`), the second reads it now; the composer owns the confirm. */
  readNow?: (id: string) => void;
  readNowArmed?: string | null;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  // The row being edited, as a draft: its words with each picture a chip in place, kept whole as in
  // the composer (ADR 0104); a chip the edit takes leaves with its picture. Files ride along.
  const [draft, setDraft] = useState<ReturnType<typeof draftFromWire>>({ text: "", images: [], files: [] });
  const editor = useRef<HTMLTextAreaElement>(null);
  if (!messages.length && !delivered.length && !error) return null;
  // The strip sits in the composer, so every px it takes comes off the conversation: rows show three
  // lines (Edit has the rest) and the strip stops at 13rem, less on a short screen. Below the desk
  // breakpoint the composer sits 8px from the edges and the thread a page gutter in, so the strip's
  // padding lines its bubbles up with the chat bubbles right above them.
  return (
    <section aria-label="Queued messages" className="mb-2 max-h-[min(13rem,30dvh)] overflow-y-auto overscroll-contain max-lg:px-[calc(var(--page-gutter)-8px)]">
      {error && (
        <p role="alert" className="px-1 pb-1 text-footnote text-destructive">
          {error}
        </p>
      )}
      <ol className="space-y-3">
        {messages.map((item, index) => {
          // The words are what gets edited, each picture a chip where it is; the files ride along unchanged.
          const status = queueRowStatus(agent, item);
          const can = (action: (typeof status.actions)[number]) => status.actions.includes(action);
          const locked = busy || item.state === "sending";
          const isEditing = editing === item.id;
          const menu: QueuedAction[] = [];
          if (!isEditing) {
            if (can("sendNow")) menu.push({ id: "send", label: item.stranded ? "Send here" : "Send now", icon: Send, disabled: locked, run: () => void change("send", undefined, item) });
            // A paused row's delivery is uncertain: it is removed, not edited in place.
            if (can("edit") && item.state !== "paused") menu.push({ id: "edit", label: "Edit", icon: Pencil, disabled: locked, run: () => { setEditing(item.id); setDraft(draftFromWire(item.text)); } });
            menu.push({ id: "remove", label: "Remove", icon: Trash2, disabled: locked, run: () => void change("remove", undefined, item) });
          }
          const remedies: QueuedAction[] = isEditing
            ? [
                { id: "cancel", label: "Cancel", icon: X, run: () => setEditing(null) },
                {
                  id: "save",
                  label: "Save",
                  name: "Save queued message",
                  icon: Check,
                  disabled: busy || (!draft.text.trim() && !draft.images.length && !draft.files.length),
                  run: () => void change("edit", serializeDraft(draft.text, draft.images, draft.files), item).then((saved) => { if (saved) setEditing(null); }),
                },
              ]
            : [];
          return (
            <li key={item.id} data-queue-row={item.stranded ? "stranded" : item.state}>
              <QueuedMessage
                text={item.text}
                tone={status.tone}
                label={status.label}
                device={item.device ?? undefined}
                menuLabel={`Queued message ${index + 1} actions`}
                menu={menu}
                remedies={remedies}
                clamp
                editor={isEditing ? (
                  <div className="composer-field rounded-lg bg-background">
                    <DraftChipLayer text={draft.text} field={editor} />
                    <textarea
                      aria-label="Edit queued message"
                      ref={editor}
                      className="block w-full resize-y rounded-lg bg-transparent p-2 text-body text-foreground"
                      value={draft.text}
                      onChange={(e) => {
                        const kept = editChips(draft.text, e.target.value, e.target.selectionStart, draft.images.length);
                        setDraft({ ...draft, text: kept.text, images: draft.images.filter((_path, i) => !kept.removed.includes(i + 1)) });
                      }}
                    />
                  </div>
                ) : undefined}
              />
            </li>
          );
        })}
        {delivered.map((row) => {
          const status = queueRowStatus(agent, { state: "sent", deliveryMode: row.deliveryMode, native: row.native, readNowAt: row.readNowAt });
          const armed = readNowArmed === row.id;
          return (
            <li key={row.id} data-queue-row={row.native ?? "sent"}>
              <QueuedMessage
                text={row.text}
                tone={status.tone}
                label={status.label}
                menuLabel="Queued message actions"
                menu={[]}
                clamp
                remedies={readNow && status.actions.includes("readNow")
                  ? [{ id: "readNow", label: armed ? "Tap again to read it now" : "Read it now", icon: Zap, disabled: busy, armed, run: () => readNow(row.id) }]
                  : []}
              />
            </li>
          );
        })}
      </ol>
    </section>
  );
}
