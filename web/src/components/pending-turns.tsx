import { Pencil, RotateCcw, Send, SquareTerminal, Trash2, Zap, type IconComponent } from "@/components/ui/icon";

import { QueuedMessage, type QueuedAction, type QueuedTone } from "@/components/queued-message";
import { queueRowStatus } from "@/hooks/use-message-queue";
import type { LocalSend, LocalSendActions } from "@/lib/local-sends";

/** What a pending bubble says about itself, and which of its buttons make sense right now. */
export function pendingStatus(send: LocalSend): {
  tone: QueuedTone;
  label: string;
  actions: Array<keyof LocalSendActions>;
} {
  if (send.state === "failed") {
    // Text that may already be in the terminal is checked there, never resent blind.
    if (send.textDelivered) return { tone: "problem", label: send.error || "Not confirmed. Check Terminal.", actions: ["openTerminal", "edit"] };
    return { tone: "problem", label: send.error || "Not sent", actions: ["retry", "edit"] };
  }
  if (send.state === "sent" && !send.queueId) return { tone: "done", label: send.unverified ? "Sent, not verified" : "Sent", actions: [] };
  if (send.state === "sending") return { tone: "busy", label: "Sending…", actions: [] };
  return queueRowStatus(send.agent, {
    state: send.state === "sent" || send.native ? "sent" : (send.queueState ?? "queued"),
    deliveryMode: send.deliveryMode,
    waitingFor: send.waitingFor,
    until: send.until,
    stranded: send.stranded,
    native: send.native,
    readNowAt: send.readNowAt,
    error: send.error,
  });
}

// Managing the message lives behind its ⋯; a remedy for what went wrong (or a read it can still get)
// stays on the status line.
const ACTION: Record<keyof LocalSendActions, { label: string; icon: IconComponent; remedy: boolean }> = {
  retry: { label: "Retry", icon: RotateCcw, remedy: true },
  openTerminal: { label: "Open Terminal", icon: SquareTerminal, remedy: true },
  readNow: { label: "Read it now", icon: Zap, remedy: true },
  sendNow: { label: "Send now", icon: Send, remedy: false },
  edit: { label: "Edit", icon: Pencil, remedy: false },
  remove: { label: "Remove", icon: Trash2, remedy: false },
};

/**
 * The operator's own messages that the journal does not show yet, at the end of the conversation:
 * the same bubble as a sent message, set in a quieter ink, with one status line under it. A message
 * queued on another device is drawn by the same QueuedMessage in the queue strip.
 */
export function PendingTurns({ sends, actions }: { sends: readonly LocalSend[]; actions?: LocalSendActions }) {
  if (!sends.length) return null;
  return (
    <div className="mt-3 space-y-3">
      {sends.map((send) => {
        const status = pendingStatus(send);
        const ids = actions ? status.actions : [];
        const offer = (id: keyof LocalSendActions): QueuedAction => ({
          id,
          label: id === "sendNow" && send.stranded ? "Send here" : ACTION[id].label,
          icon: ACTION[id].icon,
          run: () => actions?.[id](send),
        });
        return (
          <div key={send.id} data-pending-send={send.state}>
            <QueuedMessage
              text={send.text}
              tone={status.tone}
              label={status.label}
              menuLabel="Queued message actions"
              menu={ids.filter((id) => !ACTION[id].remedy).map(offer)}
              remedies={ids.filter((id) => ACTION[id].remedy).map(offer)}
            />
          </div>
        );
      })}
    </div>
  );
}
