import { useState } from "react";
import { Check, Pencil, Send, X } from "lucide-react";
import type { QueueMessage } from "@/lib/api";

export function MessageQueueStrip({
  messages,
  busy,
  error,
  change,
}: {
  messages: QueueMessage[];
  busy: boolean;
  error: string;
  change: (
    action: "edit" | "remove" | "send",
    text?: string,
    item?: QueueMessage,
  ) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  if (!messages.length && !error) return null;
  return (
    <section
      aria-label="Queued messages"
      className="mb-2 max-h-52 overflow-y-auto rounded-lg border border-border/50 px-3 py-1"
    >
      <p className="py-1 text-xs text-muted-foreground">
        Queue · {messages.length} · sends after the current turn
      </p>
      {error && (
        <p role="alert" className="py-1 text-xs text-destructive">
          {error}
        </p>
      )}
      <ol className="divide-y divide-border/40">
        {messages.map((item, index) => (
          <li key={item.id} className="py-1">
            {editing === item.id ? (
              <textarea
                aria-label="Edit queued message"
                className="w-full resize-y rounded-md bg-background p-2 text-base"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            ) : (
              <p className="line-clamp-2 break-words text-sm">
                <span className="mr-2 text-xs text-muted-foreground">
                  {index + 1}
                </span>
                {item.text}
              </p>
            )}
            <div className="flex items-center gap-1">
              <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                {item.state === "sending"
                  ? "Sending…"
                  : item.state === "paused"
                    ? item.error || "Paused. Check Terminal."
                    : "Queued"}
              </span>
              {editing === item.id ? (
                <button
                  type="button"
                  aria-label="Save queued message"
                  disabled={busy || !text.trim()}
                  className="flex size-11 items-center justify-center"
                  onClick={async () => {
                    if (await change("edit", text, item)) setEditing(null);
                  }}
                >
                  <Check className="size-3.5" />
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    aria-label={`Edit queued message ${index + 1}`}
                    disabled={busy || item.state === "sending"}
                    className="flex size-11 items-center justify-center disabled:opacity-40"
                    onClick={() => {
                      setEditing(item.id);
                      setText(item.text);
                    }}
                  >
                    <Pencil className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Send queued message ${index + 1} now`}
                    title="Send now"
                    disabled={busy || item.state === "sending"}
                    className="flex size-11 items-center justify-center disabled:opacity-40"
                    onClick={() => void change("send", undefined, item)}
                  >
                    <Send className="size-3.5" />
                  </button>
                </>
              )}
              <button
                type="button"
                aria-label={`Remove queued message ${index + 1}`}
                disabled={busy || item.state === "sending"}
                className="flex size-11 items-center justify-center disabled:opacity-40"
                onClick={() => void change("remove", undefined, item)}
              >
                <X className="size-3.5" />
              </button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
