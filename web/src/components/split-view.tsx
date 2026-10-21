import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useRevalidator } from "react-router";
import { Maximize2, ChatCircle, SquareTerminal, X } from "@/components/ui/icon";

import { AgentChat, type DockedHeaderView } from "@/components/agent-chat";
import { threadTree } from "@/components/project-tasks";
import { NodeDot } from "@/components/node-row";
import { ColumnEdge, ICON_BUTTON, type SessionInspectorState } from "@/components/session-inspector";
import { Chip, ChipStrip } from "@/components/ui/chip";
import { isLocked, useLocked } from "@/lib/idle";
import { concerns, isLiveHealthy, onLiveEvent } from "@/lib/live-events";
import { fetchPane } from "@/lib/api";
import { getRequestedLines, type HomeData, type PaneData } from "@/lib/loaders";
import { nodePath } from "@/lib/nav";
import { nodeState } from "@/lib/org-tree";
import { isReadOnly, type ProjectThreadView, type ProjectView } from "@/lib/types";

/**
 * Poll cadence of a docked mirror. The stream names only the route's own pane to the bridge watcher
 * (ADR 0058), so a docked screen keeps its own fast poll; its chat view relaxes on a healthy stream.
 */
export const DOCKED_POLL_MS = { live: 10_000, terminal: 1_500, hidden: 4_000 } as const;

/** One read of a docked pane. It skips the route loader's text cache, so a failure keeps the last read. */
async function readDocked(paneId: string, session: string | undefined, previous: PaneData | null): Promise<PaneData> {
  const lines = getRequestedLines(paneId, session);
  try {
    const read = await fetchPane(paneId, lines, session);
    return { paneId, session, text: read.text, truncated: read.truncated, requestedLines: lines, revision: read.revision,
      atPrompt: read.atPrompt, nativeTelemetry: read.nativeTelemetry, error: false, authError: false };
  } catch {
    return { ...(previous ?? { paneId, session, text: "", truncated: false, requestedLines: lines, revision: 0, authError: false }), error: true };
  }
}

/**
 * The mirror of a pane shown beside the route's own: read on mount, on a live event naming it, after
 * every app-wide revalidation (a send or an answer asks for one), and on its poll.
 */
export function usePaneMirror(paneId: string, session: string | undefined, screenShown: boolean): PaneData | null {
  const [pane, setPane] = useState<PaneData | null>(null);
  const locked = useLocked();
  const revalidator = useRevalidator();
  const refreshRef = useRef<() => void>(() => {});
  const shownRef = useRef(screenShown);
  shownRef.current = screenShown;
  const paneRef = useRef(pane);
  paneRef.current = pane;

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
      const ms = shownRef.current ? DOCKED_POLL_MS.terminal : isLiveHealthy() ? DOCKED_POLL_MS.live : DOCKED_POLL_MS.hidden;
      timer = setTimeout(() => void read(), ms);
    };
    async function read() {
      if (disposed || document.hidden || isLocked()) return;
      if (inFlight) return void (again = true);
      inFlight = true;
      clearTimeout(timer);
      try {
        const next = await readDocked(paneId, session, paneRef.current);
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

const chipThreads = (threads: readonly ProjectThreadView[]) => threads.filter((thread) => thread.paneId && thread.status !== "resolved");

/** Chips earn their row only when there is somewhere else to switch to. */
export function threadChipsShown(threads: readonly ProjectThreadView[], withCoordinator: boolean): boolean {
  return chipThreads(threads).length + (withCoordinator ? 1 : 0) >= 2;
}

/**
 * A coordinator's threads as chips in the strip a workspace's tabs would take, drawn with the same
 * chip and strip as the tabs and panes: tap one to switch, the open one wears the neutral fill.
 */
export function ThreadChips({ threads, coordinator, currentPaneId, onOpen }: {
  threads: readonly ProjectThreadView[];
  /** The coordinator's pane, offered as the last chip. */
  coordinator?: { paneId: string; label: string };
  currentPaneId?: string;
  onOpen: (paneId: string) => void;
}) {
  if (!threadChipsShown(threads, coordinator !== undefined)) return null;
  const chip = (key: string, paneId: string, label: string, dot: ReactNode) => (
    <Chip key={key} label={label} active={paneId === currentPaneId} icon={dot} onClick={() => { if (paneId !== currentPaneId) onOpen(paneId); }} />
  );
  return (
    <nav aria-label="Threads" className="flex shrink-0 flex-col">
      <ChipStrip band="tabs" activeKey={currentPaneId ?? ""}>
        {chipThreads(threads).map((thread) => chip(thread.id, thread.paneId!, thread.title, <NodeDot state={nodeState(thread)} />))}
        {coordinator && chip("coordinator", coordinator.paneId, coordinator.label, <span aria-hidden className="size-2 shrink-0 rounded-full border border-muted-foreground" />)}
      </ChipStrip>
    </nav>
  );
}

/**
 * A thread docked beside its coordinator on a wide screen: its own conversation (or terminal) and
 * composer, its siblings as tabs, and its pull request above the composer.
 */
export function DockedThread({ thread, project, siblings, data, subtitle, inspector, onSwitch, onExpand, onClose }: {
  thread: ProjectThreadView & { paneId: string };
  project: ProjectView;
  siblings: readonly ProjectThreadView[];
  data: HomeData;
  subtitle: string;
  /** The right column it takes, at the session panel's width. */
  inspector: SessionInspectorState;
  onSwitch: (paneId: string) => void;
  onExpand: () => void;
  onClose: () => void;
}) {
  const [screenShown, setScreenShown] = useState(false);
  const pane = usePaneMirror(thread.paneId, data.session, screenShown);
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const agent = data.agents.find((candidate) => candidate.paneId === thread.paneId);
  const onMirrorShown = useCallback((shown: boolean) => setScreenShown(shown), []);
  const readOnly = isReadOnly(data.device);
  const header = ({ terminal, canToggle, setTerminal, find, menu }: DockedHeaderView) => find
    ? <div className="flex min-h-13 shrink-0 items-center border-b border-border/60 px-3">{find}</div>
    : (
    <div className="@container flex min-h-13 shrink-0 items-center gap-1 border-b border-border/60 pl-3 pr-2">
      <NodeDot state={nodeState(thread)} />
      {/* The title comes first: a narrow column drops the subtitle, then Chat and Terminal keep only their icons. */}
      <span className="ml-1 min-w-0 shrink truncate text-subhead font-semibold">{thread.title}</span>
      <span className="ml-1 min-w-0 flex-1 truncate text-xs text-muted-foreground @max-[34rem]:hidden">{subtitle}</span>
      <span className="hidden flex-1 @max-[34rem]:block" />
      {canToggle && <div role="group" aria-label="View" className="flex shrink-0 items-center gap-0.5">
        {([[false, "Chat", ChatCircle], [true, "Terminal", SquareTerminal]] as const).map(([value, label, Icon]) => (
          <button key={label} type="button" aria-pressed={terminal === value} aria-label={label} title={label} onClick={() => setTerminal(value)} className="panel-tab shrink-0 px-1.5">
            <Icon aria-hidden className="size-3.5" /><span className="@max-[26rem]:sr-only">{label}</span>
          </button>
        ))}
      </div>}
      {menu}
      <button type="button" aria-label="Open full view" title="Open full view" onClick={onExpand} className={ICON_BUTTON}>
        <Maximize2 aria-hidden className="size-3.5" />
      </button>
      <button type="button" aria-label="Close thread" title="Close" onClick={onClose} className={ICON_BUTTON}>
        <X aria-hidden className="size-4" />
      </button>
    </div>
  );
  return (
    <aside aria-label={thread.title} className="session-panel" data-docked="" style={{ width: inspector.width }}>
      <ColumnEdge inspector={inspector} label="Resize thread" />
      <AgentChat
        key={thread.paneId}
        paneId={thread.paneId}
        session={data.session}
        agent={agent}
        agents={data.agents}
        shellPanes={data.shellPanes}
        tabs={data.tabs}
        project={{ slug: project.slug, name: project.name, role: thread.role }}
        title={thread.title}
        text={pane?.text ?? ""}
        nativeTelemetry={pane?.nativeTelemetry}
        atPrompt={pane?.atPrompt}
        requestedLines={pane?.requestedLines}
        revision={pane?.revision}
        device={data.device}
        bridge={data.bridge}
        error={data.error}
        authError={data.authError || pane?.authError}
        docked={{ header, onMirrorShown }}
        strip={<ThreadChips threads={siblings} currentPaneId={thread.paneId} onOpen={onSwitch} />}
        projectChips={{ project, thread, threads: threadTree(project, thread.parentId === "root" ? undefined : thread.parentId), session: data.session, readOnly,
          onOpenPane: onSwitch, onOpenNode: (id) => navigate(nodePath(project.slug, id, data.session)), onChanged: () => revalidator.revalidate() }}
        onBack={onClose}
        onSelect={onSwitch}
      />
    </aside>
  );
}
