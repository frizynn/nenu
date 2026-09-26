import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Bot, ChevronRight, RefreshCw, Users } from "lucide-react";
import { WorkbenchPopover } from "@/components/ui/workbench-popover";
import { TranscriptView } from "@/components/transcript-view";
import { fetchSubagents, fetchSubagentHistory, isApiErrorStatus } from "@/lib/api";
import type { SubagentsResponse, SubagentHistoryResponse, SubagentStatus } from "@/lib/types";

const LABEL: Record<SubagentStatus, string> = { running: "Working", waiting: "Needs input", idle: "Idle", completed: "Finished", failed: "Error", unknown: "Unknown state" };
const COLOR: Record<SubagentStatus, string> = { running: "bg-status-working", waiting: "bg-status-blocked", idle: "bg-status-idle", completed: "bg-status-done", failed: "bg-destructive", unknown: "bg-status-unknown" };

export function SessionSubagents({ paneId, session, agent, enabled = true }: { paneId: string; session?: string; agent: string; enabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [list, setList] = useState<SubagentsResponse | null>(null);
  const [history, setHistory] = useState<SubagentHistoryResponse | null>(null);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const scope = JSON.stringify([paneId, session]);
  const loadedSessionKey = useRef<string | null>(null);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  useEffect(() => { setList(null); setHistory(null); setSelected(null); setOpen(false); loadedSessionKey.current = null; }, [scope]);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    async function poll() {
      if (disposed || document.hidden || controller) return;
      controller = new AbortController();
      const request = controller;
      try {
        const next = await fetchSubagents(paneId, session, request.signal);
        if (disposed || request.signal.aborted || currentScope.current !== scope) return;
        setList(next); setError(false);
        const nextKey = next.available ? next.sessionKey : null;
        const changedSession = loadedSessionKey.current !== null && loadedSessionKey.current !== nextKey;
        loadedSessionKey.current = nextKey;
        if (changedSession) { setHistory(null); setSelected(null); return; }
        if (open && selected && next.available && next.agents.some((child) => child.id === selected)) {
          const page = await fetchSubagentHistory(paneId, selected, session, request.signal);
          if (!disposed && !request.signal.aborted && currentScope.current === scope && page.sessionKey === next.sessionKey) setHistory(page);
        } else { setHistory(null); if (selected) setSelected(null); }
      } catch (failure) {
        if (!disposed && !request.signal.aborted && currentScope.current === scope) {
          setError(true);
          if (isApiErrorStatus(failure, 401) || isApiErrorStatus(failure, 403)) { setList(null); setHistory(null); }
        }
      } finally {
        if (controller === request) {
          controller = undefined;
          if (!disposed && !document.hidden) timer = setTimeout(() => void poll(), open ? 3000 : 12000);
        }
      }
    }
    const wake = () => { clearTimeout(timer); void poll(); };
    const visibility = () => {
      if (document.hidden) { clearTimeout(timer); controller?.abort(); controller = undefined; }
      else wake();
    };
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", visibility);
    void poll();
    return () => { disposed = true; clearTimeout(timer); controller?.abort(); window.removeEventListener("online", wake); document.removeEventListener("visibilitychange", visibility); };
  }, [scope, paneId, session, enabled, open, selected, refresh]);
  const stale = error || !enabled;
  const agents = list?.available ? list.agents : [];
  const child = agents.find((entry) => entry.id === selected);
  return <>
    <button ref={trigger} type="button" aria-label={`Subagents${agents.length ? ` (${agents.length})` : ""}`} title="Subagents" aria-haspopup="dialog" aria-expanded={open}
      disabled={!enabled} onClick={() => setOpen(!open)} className="flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground disabled:opacity-50">
      <Users aria-hidden="true" className="size-4" /><span className="hidden sm:inline">Agents</span>{agents.length > 0 && <span className="tabular-nums">{agents.length}</span>}
    </button>
    <WorkbenchPopover open={open} onDismiss={() => setOpen(false)} anchorRef={trigger} label="Subagents" className="w-[min(36rem,calc(100vw-2rem))]">
      {stale && <div role="status" className="mb-3 flex items-center justify-between gap-2 text-xs text-muted-foreground"><span>Couldn’t refresh. Showing last known activity.</span><button type="button" aria-label="Retry subagents" onClick={() => setRefresh((n) => n + 1)} className="flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-muted"><RefreshCw className="size-4" /></button></div>}
      {child ? <>
        <button type="button" onClick={() => { setSelected(null); setHistory(null); }} className="mb-2 flex min-h-11 items-center gap-2 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />All agents</button>
        <h4 className="break-words text-sm font-medium">{child.name}</h4>
        <p className="mb-3 break-words text-xs text-muted-foreground">{child.task}</p>
        {history ? <TranscriptView entries={history.entries} agent={agent} /> : <p role="status" className="text-sm text-muted-foreground">Loading conversation…</p>}
        {history?.truncated && <p className="mt-3 text-xs text-muted-foreground">Showing the most recent conversation entries.</p>}
      </> : <>
        {!list && !error && <p role="status" className="text-sm text-muted-foreground">Checking this session…</p>}
        {list?.available === false && <p className="text-sm text-muted-foreground">{list.reason === "disabled" ? "Conversation history is disabled." : "Connect a conversation to see its subagents."}</p>}
        {list?.available && !agents.length && <p className="text-sm text-muted-foreground">No subagents in this session yet. Delegated tasks will appear here.</p>}
        <div className="divide-y divide-border/40">{agents.map((entry) => <button key={entry.id} type="button" onClick={() => { setHistory(null); setSelected(entry.id); }} className="flex min-h-11 w-full items-start gap-2 rounded-md py-3 text-left hover:bg-muted/40">
          <Bot aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1"><span className="block break-words text-sm font-medium">{entry.name}</span>{entry.task && <span className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">{entry.task}</span>}
            <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"><span className={`size-1.5 rounded-full ${COLOR[stale ? "unknown" : entry.status]}`} /><span>{LABEL[stale ? "unknown" : entry.status]}</span>{entry.model && <span>{entry.model}</span>}{entry.updatedAt && <time dateTime={entry.updatedAt} title={entry.updatedAt}>{new Date(entry.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>}</span>
            {agents.some((a) => a.id === entry.parentId) && <span className="mt-1 block truncate text-xs text-muted-foreground">Under {agents.find((a) => a.id === entry.parentId)?.name}</span>}
          </span><ChevronRight aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        </button>)}</div>
        {list?.available && list.truncated && <p className="mt-3 text-xs text-muted-foreground">Showing recent agents. Some older activity may be unavailable.</p>}
      </>}
    </WorkbenchPopover>
  </>;
}
