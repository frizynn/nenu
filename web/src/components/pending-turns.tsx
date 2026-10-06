import type { ReactNode } from "react";
import { AlertCircle, Check, Clock, Loader2 } from "lucide-react";

import { MarkdownText } from "@/components/markdown-text";
import { MessageImages } from "@/components/message-images";
import type { LocalSend, LocalSendActions } from "@/lib/local-sends";
import { splitMessageImages } from "@/lib/message-images";
import { cn } from "@/lib/utils";

/** What a pending bubble says about itself, and which of its buttons make sense right now. */
export function pendingStatus(send: LocalSend): {
  tone: "busy" | "waiting" | "done" | "problem";
  label: string;
  actions: Array<keyof LocalSendActions>;
} {
  if (send.state === "failed") return { tone: "problem", label: send.error || "Not sent", actions: ["retry", "edit"] };
  if (send.state === "sent") return { tone: "done", label: "Sent", actions: [] };
  if (send.state === "queued") {
    if (send.queueState === "sending") return { tone: "busy", label: "Sending…", actions: [] };
    if (send.queueState === "paused") return { tone: "problem", label: send.error || "Paused. Check the terminal.", actions: ["edit", "remove"] };
    return { tone: "waiting", label: "Waiting. It sends when the agent is free.", actions: ["sendNow", "edit", "remove"] };
  }
  return { tone: "busy", label: "Sending…", actions: [] };
}

const ACTION_LABEL: Record<keyof LocalSendActions, string> = {
  retry: "Retry",
  edit: "Edit",
  remove: "Remove",
  sendNow: "Send now",
};

const TONE_ICON: Record<ReturnType<typeof pendingStatus>["tone"], ReactNode> = {
  busy: <Loader2 aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none" />,
  waiting: <Clock aria-hidden="true" className="size-3" />,
  done: <Check aria-hidden="true" className="size-3" />,
  problem: <AlertCircle aria-hidden="true" className="size-3" />,
};

/**
 * The operator's own messages that the journal does not show yet, at the end of the conversation.
 * The same right-aligned bubble as a sent message, a little quieter, with one status line under it.
 */
export function PendingTurns({ sends, actions }: { sends: readonly LocalSend[]; actions?: LocalSendActions }) {
  if (!sends.length) return null;
  return (
    <div className="mt-3 space-y-3">
      {sends.map((send) => {
        const { text, images } = splitMessageImages(send.text);
        const status = pendingStatus(send);
        return (
          <div key={send.id} data-pending-send={send.state} className="flex flex-col items-end">
            <div className={cn("max-w-[85%] min-w-0 space-y-1.5 rounded-2xl rounded-br-md bg-muted px-3.5 py-2 [overflow-wrap:anywhere]", status.tone !== "problem" && "opacity-70")}>
              {text && <MarkdownText text={text} query="" />}
              <MessageImages paths={images} className="pt-1" />
            </div>
            <div className="flex max-w-full flex-wrap items-center justify-end gap-x-1 text-[11px] text-muted-foreground">
              <p role="status" aria-live="polite" className={cn("flex min-h-7 items-center gap-1 px-1", status.tone === "problem" && "text-destructive")}>
                {TONE_ICON[status.tone]}
                {status.label}
              </p>
              {actions && status.actions.map((action) => (
                <button
                  key={action}
                  type="button"
                  className="min-h-11 rounded-md px-2 font-medium text-foreground hover:bg-muted md:min-h-7"
                  onClick={() => actions[action](send)}
                >
                  {ACTION_LABEL[action]}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
