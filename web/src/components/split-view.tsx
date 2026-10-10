import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRevalidator } from "react-router";
import { Maximize2, MessageSquare, TerminalSquare, X } from "lucide-react";

import { AgentChat } from "@/components/agent-chat";
import { PrBar } from "@/components/pr-bar";
import { ThreadStateDot, threadDot } from "@/components/project-tasks";
import { useWatchPane } from "@/hooks/use-live-events";
import { isLocked, useLocked } from "@/lib/idle";
import { concerns, isLiveHealthy, onLiveEvent } from "@/lib/live-events";
import { readPane, type HomeData, type PaneData } from "@/lib/loaders";
import { isReadOnly, type ProjectThreadView, type ProjectView } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Fallback cadence of a docked mirror: the stream names its changes while it is healthy (ADR 0058). */
export const DOCKED_POLL_MS = { live: 10_000, terminal: 1_500, hidden: 4_000 } as const;

/**
 * The mirror of a pane shown beside the route's own: read on mount, on a live event naming it, after
 * every app-wide revalidation (a send or an answer asks for one), and on the fallback poll. While its
 * screen is on display the bridge watches it for this page.
 */
export function usePaneMirror(paneId: string, session: string | undefined, screenShown: boolean): PaneData | null {
  const [pane, setPane] = useState<PaneData | null>(null);
  const locked = useLocked();
  const revalidator = useRevalidator();
  const refreshRef = useRef<() => void>(() => {});
  const shownRef = useRef(screenShown);
  shownRef.current = screenShown;
  useWatchPane(screenShown ? paneId : undefined);

  useEffect(() => {
    setPane(null);
  }, [paneId, session]);

  useEffect(() => {
    if (locked) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let again = false;
    const schedule = () => {
      clearTimeout(timer);
      if (disposed || document.hidden) return;
      const ms = isLiveHealthy() ? DOCKED_POLL_MS.live : shownRef.current ? DOCKED_POLL_MS.terminal : DOCKED_POLL_MS.hidden;
      timer = setTimeout(() => void read(), ms);
    };
    async function read() {
      if (disposed || document.hidden || isLocked()) return;
      if (inFlight) return void (again = true);
      inFlight = true;
      clearTimeout(timer);
      try {
        const next = await readPane(paneId, session);
        if (!disposed) setPane((previous) => previous && previous.text === next.text && previous.revision === next.revision && previous.error === next.error ? previous : next);
      } finally {
        inFlight = false;
        if (again && !disposed) { again = false; void read(); } else schedule();
      }
    }
    refreshRef.current = () => void read();
    const stop = onLiveEvent((event) => { if (concerns(event, "pane", paneId)) void read(); });
    const visibility = () => { if (!document.hidden) void read(); };
    document.addEventListener("visibilitychange", visibility);
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
      stop();
      document.removeEventListener("visibilitychange", visibility);
      refreshRef.current = () => {};
    };
  }, [paneId, session, locked]);

  // Writes from the docked chat end with revalidate(), which re-runs the route's loaders only.
  const settled = useRef(revalidator.state);
  useEffect(() => {
    if (settled.current !== "idle" && revalidator.state === "idle") refreshRef.current();
    settled.current = revalidator.state;
  }, [revalidator.state]);

  return pane;
}

/** A coordinator's threads as chips: tap one to switch, the current one is raised. */
export function ThreadChips({ threads, coordinator, currentPaneId, onOpen, className }: {
  threads: readonly ProjectThreadView[];
  /** The coordinator's pane, offered as the last chip. */
  coordinator?: { paneId: string; label: string };
  currentPaneId?: string;
  onOpen: (paneId: string) => void;
  className?: string;
}) {
  const live = threads.filter((thread) => thread.paneId && thread.status !== "resolved");
  if (live.length + (coordinator ? 1 : 0) < 2) return null;
  const chip = (key: string, paneId: string, label: string, dot: ReactNode) => {
    const current = paneId === currentPaneId;
    return (
      <button key={key} type="button" aria-current={current ? "page" : undefined} onClick={() => !current && onOpen(paneId)}
        className={cn("inline-flex h-9 shrink-0 items-center gap-2 rounded-full px-3 text-[13px] lg:h-7 lg:rounded-md lg:px-2.5",
          current ? "bg-muted font-medium text-foreground ring-1 ring-border" : "text-muted-foreground hover:text-foreground")}>
        {dot}{label}
      </button>
    );
  };
  return (
    <nav aria-label="Threads" className={cn("flex shrink-0 gap-1.5 overflow-x-auto border-b border-border/60 px-3 py-2 [scrollbar-width:none]", className)}>
      {live.map((thread) => chip(thread.id, thread.paneId!, thread.title, <ThreadStateDot state={threadDot(thread)} />))}
      {coordinator && chip("coordinator", coordinator.paneId, coordinator.label, <span aria-hidden className="size-2 shrink-0 rounded-full border border-muted-foreground" />)}
    </nav>
  );
}

/**
 * A thread docked beside its coordinator on a wide screen: its own conversation (or terminal) and
 * composer, its siblings as tabs, and its pull request above the composer.
 */
export function DockedThread({ thread, project, siblings, data, subtitle, onSwitch, onExpand, onClose }: {
  thread: ProjectThreadView & { paneId: string };
  project: ProjectView;
  siblings: readonly ProjectThreadView[];
  data: HomeData;
  subtitle: string;
  onSwitch: (paneId: string) => void;
  onExpand: () => void;
  onClose: () => void;
}) {
  const [screenShown, setScreenShown] = useState(false);
  const pane = usePaneMirror(thread.paneId, data.session, screenShown);
  const revalidator = useRevalidator();
  const agent = data.agents.find((candidate) => candidate.paneId === thread.paneId);
  const onMirrorShown = useCallback((shown: boolean) => setScreenShown(shown), []);
  const readOnly = isReadOnly(data.device);
  const header = ({ terminal, canToggle, setTerminal }: { terminal: boolean; canToggle: boolean; setTerminal: (terminal: boolean) => void }) => (
    <div className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border px-3">
      <ThreadStateDot state={threadDot(thread)} />
      <span className="shrink-0 text-sm font-semibold">{thread.title}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{subtitle}</span>
      {canToggle && <div role="group" aria-label="View" className="flex shrink-0 rounded-lg bg-muted/50 p-0.5">
        {([[false, "Chat", MessageSquare], [true, "Terminal", TerminalSquare]] as const).map(([value, label, Icon]) => (
          <button key={label} type="button" aria-pressed={terminal === value} onClick={() => setTerminal(value)}
            className={cn("inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs", terminal === value ? "bg-background font-medium shadow-sm" : "text-muted-foreground")}>
            <Icon aria-hidden className="size-3.5" />{label}
          </button>
        ))}
      </div>}
      <button type="button" aria-label="Open full view" title="Open full view" onClick={onExpand} className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent">
        <Maximize2 aria-hidden className="size-3.5" />
      </button>
      <button type="button" aria-label="Close thread" title="Close" onClick={onClose} className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent">
        <X aria-hidden className="size-4" />
      </button>
    </div>
  );
  return (
    <aside aria-label={thread.title} className="flex min-h-0 w-[min(44rem,50%)] shrink-0 flex-col border-l border-border">
      <AgentChat
        key={thread.paneId}
        paneId={thread.paneId}
        session={data.session}
        agent={agent}
        agents={data.agents}
        shellPanes={data.shellPanes}
        tabs={data.tabs}
        project={{ slug: project.slug, name: project.name }}
        title={thread.title}
        text={pane?.text ?? ""}
        nativeTelemetry={pane?.nativeTelemetry}
        requestedLines={pane?.requestedLines}
        revision={pane?.revision}
        device={data.device}
        bridge={data.bridge}
        error={data.error}
        authError={data.authError || pane?.authError}
        docked={{ header, onMirrorShown }}
        strip={<ThreadChips threads={siblings} currentPaneId={thread.paneId} onOpen={onSwitch} />}
        composerTop={<PrBar project={project} thread={thread} session={data.session} readOnly={readOnly} onChanged={() => revalidator.revalidate()} />}
        onBack={onClose}
        onSelect={onSwitch}
      />
    </aside>
  );
}
