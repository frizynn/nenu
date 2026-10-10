import { useState } from "react";
import { Check, Pencil, Send, X, Zap } from "lucide-react";
import type { QueueMessage } from "@/lib/api";
import { queueRowStatus, type DeliveredRow } from "@/hooks/use-message-queue";
import { serializeMessage, splitMessageImages } from "@/lib/message-images";
import { cn } from "@/lib/utils";
import { MessageImages } from "./message-images";

const ICON_BUTTON = "flex size-11 items-center justify-center disabled:opacity-40";

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
  const [text, setText] = useState("");
  if (!messages.length && !delivered.length && !error) return null;
  const waiting = messages.length;
  return (
    <section
      aria-label="Queued messages"
      className="mb-2 max-h-52 overflow-y-auto rounded-lg border border-border/50 px-3 py-1"
    >
      {waiting > 0 && (
        <p className="py-1 text-xs text-muted-foreground">
          {waiting === 1 ? "1 message waits" : `${waiting} messages wait`} in Nenu
        </p>
      )}
      {error && (
        <p role="alert" className="py-1 text-xs text-destructive">
          {error}
        </p>
      )}
      <ol className="divide-y divide-border/40">
        {messages.map((item, index) => {
          // The prose is what gets edited; the images ride along unchanged.
          const { text: prose, images } = splitMessageImages(item.text);
          const status = queueRowStatus(agent, item);
          const can = (action: (typeof status.actions)[number]) => status.actions.includes(action);
          return (
          <li key={item.id} className="py-1" data-queue-row={item.stranded ? "stranded" : item.state}>
            {editing === item.id ? (
              <textarea
                aria-label="Edit queued message"
                className="w-full resize-y rounded-md bg-background p-2 text-base"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            ) : (
              <div className="flex items-start gap-2">
                <span className="pt-0.5 text-xs text-muted-foreground">{index + 1}</span>
                <div className="min-w-0 flex-1 space-y-1">
                  {prose && <p className="line-clamp-2 break-words text-sm">{prose}</p>}
                  <MessageImages paths={images} size="sm" />
                </div>
              </div>
            )}
            <div className="flex items-center gap-1">
              <span className={cn("min-w-0 flex-1 text-xs text-muted-foreground", status.tone === "problem" && "text-destructive")}>
                {status.label}
                {item.device ? <span className="text-muted-foreground"> · from {item.device}</span> : null}
              </span>
              {editing === item.id ? (
                <button
                  type="button"
                  aria-label="Save queued message"
                  disabled={busy || (!text.trim() && !images.length)}
                  className={ICON_BUTTON}
                  onClick={async () => {
                    if (await change("edit", serializeMessage(text, images), item)) setEditing(null);
                  }}
                >
                  <Check className="size-3.5" />
                </button>
              ) : (
                <>
                  {/* A paused row's delivery is uncertain: it is removed, not edited in place. */}
                  {can("edit") && item.state !== "paused" && (
                    <button
                      type="button"
                      aria-label={`Edit queued message ${index + 1}`}
                      disabled={busy || item.state === "sending"}
                      className={ICON_BUTTON}
                      onClick={() => {
                        setEditing(item.id);
                        setText(prose);
                      }}
                    >
                      <Pencil className="size-3.5" />
                    </button>
                  )}
                  {can("sendNow") && (
                    <button
                      type="button"
                      aria-label={item.stranded ? `Send queued message ${index + 1} here` : `Send queued message ${index + 1} now`}
                      title={item.stranded ? "Send here" : "Send now"}
                      disabled={busy || item.state === "sending"}
                      className={ICON_BUTTON}
                      onClick={() => void change("send", undefined, item)}
                    >
                      <Send className="size-3.5" />
                    </button>
                  )}
                </>
              )}
              <button
                type="button"
                aria-label={`Remove queued message ${index + 1}`}
                disabled={busy || item.state === "sending"}
                className={ICON_BUTTON}
                onClick={() => void change("remove", undefined, item)}
              >
                <X className="size-3.5" />
              </button>
            </div>
          </li>
          );
        })}
        {delivered.map((row) => {
          const { text: prose, images } = splitMessageImages(row.text);
          const status = queueRowStatus(agent, { state: "sent", deliveryMode: row.deliveryMode, native: row.native });
          const armed = readNowArmed === row.id;
          return (
            <li key={row.id} className="py-1" data-queue-row={row.native ?? "sent"}>
              <div className="min-w-0 space-y-1">
                {prose && <p className="line-clamp-2 break-words text-sm">{prose}</p>}
                <MessageImages paths={images} size="sm" />
              </div>
              <div className="flex items-center gap-1">
                <span className="min-w-0 flex-1 text-xs text-muted-foreground">{status.label}</span>
                {readNow && status.actions.includes("readNow") && (
                  <button
                    type="button"
                    disabled={busy}
                    className={cn(
                      "flex min-h-11 items-center gap-1 rounded-md px-2 text-xs font-medium disabled:opacity-40",
                      armed && "bg-destructive/10 text-destructive",
                    )}
                    onClick={() => readNow(row.id)}
                  >
                    <Zap className="size-3.5" aria-hidden="true" />
                    {armed ? "Tap again to read it now" : "Read it now"}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
