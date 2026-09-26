import { isLocked, useLocked } from "@/lib/idle";
import { modelDisplayName } from "@/lib/model-display";
import { useEffect, useRef, useState } from "react";
import { Bot, ChevronRight, RefreshCw, Users } from "lucide-react";
import { WorkbenchPopover } from "@/components/ui/workbench-popover";
import { fetchSubagents, isApiErrorStatus } from "@/lib/api";
import type {
  SubagentsResponse,
  SubagentStatus,
  SubagentView,
} from "@/lib/types";

const LABEL: Record<SubagentStatus, string> = {
  running: "Working",
  waiting: "Needs input",
  idle: "Idle",
  completed: "Finished",
  failed: "Error",
  unknown: "Status unavailable",
};
const COLOR: Record<SubagentStatus, string> = {
  running: "bg-status-working",
  waiting: "bg-status-blocked",
  idle: "bg-status-idle",
  completed: "bg-muted-foreground/50",
  failed: "bg-destructive",
  unknown: "bg-status-unknown",
};

function AgentActivity({ entry }: { entry: SubagentView }) {
  const date = entry.updatedAt ? new Date(entry.updatedAt) : null;
  const time = date && Number.isFinite(date.getTime()) ? date : null;
  return (
    <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span
        className={`size-1.5 shrink-0 rounded-full ${COLOR[entry.status]}`}
      />
      <span>{LABEL[entry.status]}</span>
      {entry.model && (
        <span title={entry.model}>{modelDisplayName(entry.model)}</span>
      )}
      {time && (
        <time dateTime={entry.updatedAt} title={time.toLocaleString()}>
          {time.toDateString() === new Date().toDateString()
            ? time.toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })
            : time.toLocaleDateString([], { month: "short", day: "numeric" })}
        </time>
      )}
    </span>
  );
}

export type SubagentSelection = { agent: SubagentView; parentKey: string };

export function SessionSubagents({
  paneId,
  session,
  selected = null,
  onSelect,
  enabled = true,
}: {
  paneId: string;
  session?: string;
  selected?: SubagentSelection | null;
  onSelect: (selection: SubagentSelection | null) => void;
  enabled?: boolean;
}) {
  const locked = useLocked();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<SubagentsResponse | null>(null);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const selectionRef = useRef({ selected, onSelect });
  selectionRef.current = { selected, onSelect };
  const scope = JSON.stringify([paneId, session]);
  const loadedSessionKey = useRef<string | null>(null);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  useEffect(() => {
    setList(null);
    selectionRef.current.onSelect(null);
    setOpen(false);
    loadedSessionKey.current = null;
  }, [scope]);
  useEffect(() => {
    if (!enabled || locked) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    async function poll() {
      if (disposed || document.hidden || isLocked() || controller) return;
      controller = new AbortController();
      const request = controller;
      try {
        const next = await fetchSubagents(paneId, session, request.signal);
        if (
          disposed ||
          request.signal.aborted ||
          currentScope.current !== scope
        )
          return;
        setList(next);
        setError(false);
        const nextKey = next.available ? next.sessionKey : null;
        const changedSession =
          loadedSessionKey.current !== null &&
          loadedSessionKey.current !== nextKey;
        loadedSessionKey.current = nextKey;
        const chosen = selectionRef.current.selected;
        if (
          changedSession ||
          (chosen &&
            (!next.available ||
              !next.agents.some((entry) => entry.id === chosen.agent.id)))
        ) {
          selectionRef.current.onSelect(null);
        }
      } catch (failure) {
        if (
          !disposed &&
          !request.signal.aborted &&
          currentScope.current === scope
        ) {
          setError(true);
          if (
            isApiErrorStatus(failure, 401) ||
            isApiErrorStatus(failure, 403)
          ) {
            setList(null);
            selectionRef.current.onSelect(null);
          }
        }
      } finally {
        if (controller === request) {
          controller = undefined;
          if (!disposed && !document.hidden)
            timer = setTimeout(() => void poll(), open ? 3000 : 12000);
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
  }, [scope, paneId, session, enabled, open, refresh, locked]);
  const stale = error || !enabled;
  const agents = list?.available ? list.agents : [];
  const active = (entry: SubagentView) =>
    entry.status === "running" || entry.status === "waiting";
  const displayed = agents.map(
    (entry): SubagentView =>
      stale && active(entry) ? { ...entry, status: "unknown" } : entry,
  );
  const activeCount = displayed.filter(active).length;
  const groups = [
    { label: "Active", entries: displayed.filter(active) },
    {
      label: "Finished",
      entries: displayed.filter((entry) => entry.status === "completed"),
    },
    {
      label: "Errors",
      entries: displayed.filter((entry) => entry.status === "failed"),
    },
    {
      label: "Unconfirmed",
      entries: displayed.filter(
        (entry) => entry.status === "unknown" || entry.status === "idle",
      ),
    },
  ];

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={`Subagents${agents.length ? ` (${activeCount} active, ${agents.length} total)` : ""}`}
        title={`Subagents · ${activeCount} active · ${agents.length} total`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={!enabled}
        onClick={() => setOpen(!open)}
        className="flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground disabled:opacity-50"
      >
        <Users aria-hidden="true" className="size-4" />
        <span className="hidden sm:inline">Agents</span>
        {activeCount > 0 && <span className="tabular-nums">{activeCount}</span>}
      </button>
      <WorkbenchPopover
        open={open}
        onDismiss={() => setOpen(false)}
        anchorRef={trigger}
        label="Subagents"
        className="w-[min(36rem,calc(100vw-2rem))]"
      >
        {stale && (
          <div
            role="status"
            className="mb-3 flex items-center justify-between gap-2 text-xs text-muted-foreground"
          >
            <span>Couldn’t refresh. Showing last known activity.</span>
            <button
              type="button"
              aria-label="Retry subagents"
              onClick={() => setRefresh((n) => n + 1)}
              className="flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-muted"
            >
              <RefreshCw className="size-4" />
            </button>
          </div>
        )}
        <>
          <button
            type="button"
            aria-label="Main Parent"
            aria-pressed={!selected}
            onClick={() => {
              onSelect(null);
              setOpen(false);
            }}
            className="mb-3 flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted/40 aria-pressed:bg-muted/40"
          >
            <Bot aria-hidden="true" className="size-4 text-muted-foreground" />
            <span className="flex-1 font-medium">Main</span>
            <span className="text-xs text-muted-foreground">Parent</span>
          </button>
          {!list && !error && (
            <p role="status" className="text-sm text-muted-foreground">
              Checking this session…
            </p>
          )}
          {list?.available === false && (
            <p className="text-sm text-muted-foreground">
              {list.reason === "disabled"
                ? "Conversation history is disabled."
                : "Connect a conversation to see its subagents."}
            </p>
          )}
          {list?.available && !agents.length && (
            <p className="text-sm text-muted-foreground">
              No subagents in this session yet. Delegated tasks will appear
              here.
            </p>
          )}
          {!!agents.length && (
            <p className="mb-3 text-xs text-muted-foreground">
              {stale
                ? "Activity unavailable"
                : activeCount
                  ? `${activeCount} active · ${agents.length} total`
                  : displayed.some((entry) => entry.status === "unknown")
                    ? "No confirmed active agents"
                    : "No agents running"}
            </p>
          )}
          {groups
            .filter((group) => group.entries.length)
            .map((group) => (
              <details
                key={`${group.label}:${open}`}
                open={group.label === "Active" ? true : undefined}
                className="group mb-2 last:mb-0"
              >
                <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-xs font-medium text-muted-foreground">
                  <ChevronRight
                    aria-hidden="true"
                    className="size-3.5 group-open:rotate-90"
                  />
                  {group.label} ({group.entries.length})
                </summary>
                <div className="divide-y divide-border/40">
                  {group.entries.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => {
                        if (list?.available)
                          onSelect({
                            agent: entry,
                            parentKey: list.sessionKey,
                          });
                        setOpen(false);
                      }}
                      aria-pressed={selected?.agent.id === entry.id}
                      className="flex min-h-11 w-full items-start gap-2 rounded-md py-3 text-left hover:bg-muted/40 aria-pressed:bg-muted/40"
                    >
                      <Bot
                        aria-hidden="true"
                        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block break-words text-sm font-medium">
                          {entry.name}
                        </span>
                        {entry.task && entry.task !== entry.name && (
                          <span className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">
                            {entry.task}
                          </span>
                        )}
                        <AgentActivity entry={entry} />
                        {agents.some((a) => a.id === entry.parentId) && (
                          <span className="mt-1 block truncate text-xs text-muted-foreground">
                            Under{" "}
                            {agents.find((a) => a.id === entry.parentId)?.name}
                          </span>
                        )}
                      </span>
                      <ChevronRight
                        aria-hidden="true"
                        className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                      />
                    </button>
                  ))}
                </div>
                {group.label === "Unconfirmed" && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    No recent lifecycle signal. Open a conversation to inspect
                    its last activity.
                  </p>
                )}
              </details>
            ))}
          {list?.available && list.truncated && (
            <p className="mt-3 text-xs text-muted-foreground">
              Showing recent agents. Some older activity may be unavailable.
            </p>
          )}
        </>
      </WorkbenchPopover>
    </>
  );
}
