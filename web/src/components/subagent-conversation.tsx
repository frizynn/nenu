import { useEffect, useState } from "react";
import { ChevronLeft, ChatCircleDots } from "@/components/ui/icon";
import { fetchSubagentHistory, isApiErrorStatus } from "@/lib/api";
import { isLocked, useLocked } from "@/lib/idle";
import { CONNECTION_LOST_MS } from "@/lib/connection-health";
import { modelDisplayName } from "@/lib/model-display";
import type { SubagentHistoryResponse, SubagentStatus, SubagentView } from "@/lib/types";
import type { SubagentSelection } from "@/hooks/use-subagents";
import { TranscriptView } from "./transcript-view";
import { ChatMessageList } from "./ui/chat/chat-message-list";

type Harness = "claude" | "codex";

/**
 * Why there is no composer here, in the harness's words. Claude Code takes a subagent's messages only
 * from its main chat (the TUI's own panel types into it; nothing outside the process can), so Main
 * forwards them with SendMessage. Codex's app-server would take one on the sub-agent's thread, but
 * Nenu does not send there yet.
 */
const WHY: Record<Harness, string> = {
  claude: "Claude Code takes messages for a subagent only from its main chat, which forwards them with SendMessage.",
  codex: "Nenu does not write to a Codex sub-agent directly yet. Its main chat forwards what you send it.",
};

/** The start of a message to Main that names the child and the tool that reaches it. */
function forwardDraft(harness: Harness, agent: Pick<SubagentView, "id" | "name">): string {
  return harness === "codex"
    ? `Send to sub-agent "${agent.name}" (${agent.id}) with send_input: `
    : `Send to subagent "${agent.name}" (${agent.id}) with SendMessage: `;
}

/** A state worth naming beside the model; an unknown one says nothing. */
const STATUS_WORD: Partial<Record<SubagentStatus, string>> = {
  running: "running", waiting: "waiting on you", idle: "idle", completed: "done", failed: "failed",
};
const STATUS_TONE: Partial<Record<SubagentStatus, string>> = {
  running: "text-status-working", waiting: "text-status-blocked", completed: "text-status-done", failed: "text-destructive",
};

/** What a subagent is, under its name: the kind, its model and a state worth naming. */
export function SubagentSubtitle({ agent, harness = "claude" }: { agent: Pick<SubagentView, "model" | "status">; harness?: Harness }) {
  return <>
    {harness === "codex" ? "Sub-agent" : "Subagent"}{agent.model ? ` · ${modelDisplayName(agent.model)}` : ""}
    {STATUS_WORD[agent.status] && <> · <span className={STATUS_TONE[agent.status]}>{STATUS_WORD[agent.status]}</span></>}
  </>;
}

/**
 * A subagent's conversation in place of Main's. Only what it said can be selected; the bars around it
 * are controls. Writing to it goes through Main (`onWrite` returns there with a draft addressed to it),
 * and a device that cannot write gets the explanation without the button. The chat's own header says
 * "‹ Main" and the subagent's name; a chat docked beside another, whose header is the dock's, keeps
 * this view's own row for that (`ownHeader`). On a desk it reads in the chat's column.
 */
export function SubagentConversation({
  paneId,
  session,
  selection,
  harness = "claude",
  ownHeader = true,
  onMain,
  onWrite,
}: {
  paneId: string;
  session?: string;
  selection: SubagentSelection;
  harness?: Harness;
  ownHeader?: boolean;
  onMain: () => void;
  onWrite?: (draft: string) => void;
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
      className="flex min-h-0 flex-1 flex-col border-t border-border/40 select-none"
    >
      {ownHeader && <div className="flex min-h-12 items-center gap-1 border-b border-border/40 py-1 pr-4 pl-1 [-webkit-touch-callout:none]">
        <button
          type="button"
          onClick={onMain}
          aria-label="Back to Main"
          className="flex min-h-11 shrink-0 items-center gap-0.5 rounded-md pr-2 pl-1 text-subhead text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft aria-hidden className="size-5" />
          Main
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-subhead font-medium">{child.name}</h2>
          <p className="truncate text-footnote text-muted-foreground"><SubagentSubtitle agent={child} harness={harness} /></p>
        </div>
      </div>}
      {/* The list takes what the bars leave: at full height it pushed the footer out and the whole chat scrolled. */}
      <div className="min-h-0 flex-1">
      <ChatMessageList dep={page} className="chat-scroll-under px-(--page-gutter) py-3">
      <div className="mx-auto w-full max-w-(--chat-column)">
        {failed && (
          <div
            role="status"
            className="flex items-center gap-2 text-footnote text-muted-foreground"
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
        {page?.truncated && (
          <p className="pb-3 text-center text-xs text-muted-foreground">
            Showing the most recent conversation entries.
          </p>
        )}
        {page ? (
          <TranscriptView entries={page.entries} />
        ) : (
          !failed && (
            <p role="status" className="text-footnote text-muted-foreground">
              Loading conversation…
            </p>
          )
        )}
      </div>
      </ChatMessageList>
      </div>
      <div className="workbench-composer flex flex-col gap-1.5 pt-2">
        {onWrite && (
          <button
            type="button"
            onClick={() => onWrite(forwardDraft(harness, child))}
            aria-label={`Write to ${child.name} through Main`}
            className="flex min-h-11 items-center gap-2 rounded-2xl border border-input bg-card px-3.5 text-left text-footnote text-muted-foreground transition-colors hover:text-foreground active:bg-muted"
          >
            <ChatCircleDots aria-hidden className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Write to it through Main…</span>
          </button>
        )}
        <p className="px-1 text-xs leading-snug text-muted-foreground">{WHY[harness]}</p>
      </div>
    </section>
  );
}
