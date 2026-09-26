import { useEffect, useState } from "react";
import { fetchSubagentHistory, isApiErrorStatus } from "@/lib/api";
import { isLocked, useLocked } from "@/lib/idle";
import { CONNECTION_LOST_MS } from "@/lib/connection-health";
import { modelDisplayName } from "@/lib/model-display";
import type { SubagentHistoryResponse } from "@/lib/types";
import type { SubagentSelection } from "./session-subagents";
import { TranscriptView } from "./transcript-view";
import { ChatMessageList } from "./ui/chat/chat-message-list";

/** Child journals have no independent terminal input owner. Main's composer remains mounted. */
export function SubagentConversation({
  paneId,
  session,
  selection,
  agent,
  onMain,
}: {
  paneId: string;
  session?: string;
  selection: SubagentSelection;
  agent?: string;
  onMain: () => void;
}) {
  const locked = useLocked();
  const [page, setPage] = useState<SubagentHistoryResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (locked) return;
    let disposed = false;
    let failedAt: number | null = null;
    let received = false;
    let active =
      selection.agent.status === "running" ||
      selection.agent.status === "waiting";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    async function poll() {
      if (disposed || document.hidden || isLocked() || controller) return;
      const request = new AbortController();
      controller = request;
      try {
        const next = await fetchSubagentHistory(
          paneId,
          selection.agent.id,
          session,
          request.signal,
        );
        if (disposed || request.signal.aborted) return;
        if (next.sessionKey !== selection.parentKey) {
          setPage(null);
          setFailed(true);
          return;
        }
        received = true;
        failedAt = null;
        active =
          next.agent.status === "running" || next.agent.status === "waiting";
        setPage(next);
        setFailed(false);
      } catch (error) {
        if (!disposed && !request.signal.aborted) {
          const denied =
            isApiErrorStatus(error, 401) || isApiErrorStatus(error, 403);
          failedAt ??= Date.now();
          setFailed(
            denied || !received || Date.now() - failedAt >= CONNECTION_LOST_MS,
          );
          if (denied) setPage(null);
        }
      } finally {
        if (controller === request) {
          controller = undefined;
          if (!disposed && !document.hidden)
            timer = setTimeout(
              () => void poll(),
              active || failedAt !== null ? 3000 : 12000,
            );
        }
      }
    }
    const wake = () => {
      clearTimeout(timer);
      void poll();
    };
    const visibility = () => {
      if (document.hidden) {
        clearTimeout(timer);
        controller?.abort();
        controller = undefined;
      } else wake();
    };
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", visibility);
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [
    paneId,
    session,
    selection.agent.id,
    selection.parentKey,
    locked,
    attempt,
  ]);
  const child = page?.agent ?? selection.agent;
  return (
    <section
      aria-label={`${child.name} conversation`}
      className="flex min-h-0 flex-1 flex-col border-t border-border/40"
    >
      <div className="flex items-center gap-3 border-b border-border/40 px-4 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium">{child.name}</h2>
          <p className="text-xs text-muted-foreground">
            Subagent{child.model ? ` · ${modelDisplayName(child.model)}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={onMain}
          className="min-h-11 rounded-md px-3 text-xs hover:bg-muted"
        >
          Back to Main
        </button>
      </div>
      <ChatMessageList dep={page} className="px-4 py-3">
        {failed && (
          <div
            role="status"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            Couldn’t refresh this conversation.
            <button
              className="min-h-11 px-2 underline"
              onClick={() => setAttempt((n) => n + 1)}
            >
              Retry
            </button>
          </div>
        )}
        {page ? (
          <TranscriptView entries={page.entries} agent={agent} />
        ) : (
          !failed && (
            <p role="status" className="text-sm text-muted-foreground">
              Loading conversation…
            </p>
          )
        )}
        {page?.truncated && (
          <p className="text-xs text-muted-foreground">
            Showing the most recent conversation entries.
          </p>
        )}
      </ChatMessageList>
      <p className="border-t border-border/40 px-4 py-3 text-xs text-muted-foreground">
        Live conversation. Send instructions through Main.
      </p>
    </section>
  );
}
