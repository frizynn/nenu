import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { PanelRightOpen } from "@/components/ui/icon";
import { clampTo, ResizeHandle, type WidthRange } from "@/components/ui/resize-handle";

import { useMediaQuery } from "@/hooks/use-media-query";
import { loadSessionPanel } from "@/lib/desk-chunks";
import { isLocked } from "@/lib/idle";
import type { HomeData } from "@/lib/loaders";
import { MOTION_CONTROL_MS, MOTION_EASE, MOTION_PANEL_MS, reducedMotion } from "@/lib/motion";
import type { ProjectThreadView, ThreadPullRequest } from "@/lib/types";
import { cn } from "@/lib/utils";

// The panel is its own chunk: a phone never loads it, a desk on first open.
const SessionPanel = lazy(loadSessionPanel);

/** The panel's tabs; Overview only for a pane that belongs to a project. */
export type InspectorTab = "overview" | "changes" | "files" | "terminal";
export const INSPECTOR_TABS: readonly InspectorTab[] = ["overview", "changes", "files", "terminal"];

/** The breakpoint where the workbench shows its sidebar; the panel exists only from there. */
const DESK = "(min-width: 1024px)";
const STORE_KEY = "nenu:session-panel:v1";
/** The right column's widths, the session panel's and a docked thread's alike. */
export const PANEL_WIDTH: WidthRange = { min: 320, initial: 460, max: 960, step: 16 };

interface Stored { open: boolean; width: number; tab: InspectorTab }
const INITIAL: Stored = { open: true, width: PANEL_WIDTH.initial, tab: "overview" };
const clampWidth = (width: number) => clampTo(PANEL_WIDTH, width);

function readStored(): Stored {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null") as Partial<Stored> | null;
    return {
      open: typeof raw?.open === "boolean" ? raw.open : INITIAL.open,
      width: typeof raw?.width === "number" ? clampWidth(raw.width) : INITIAL.width,
      tab: INSPECTOR_TABS.includes(raw?.tab as InspectorTab) ? raw!.tab! : INITIAL.tab,
    };
  } catch {
    return INITIAL;
  }
}

function writeStored(value: Stored) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(value));
  } catch {
    // A blocked store only forgets the choice.
  }
}

/** The Terminal tab's two places, which the chat draws into while the tab is on screen. */
export interface TerminalSlots {
  mirror: HTMLElement;
  controls: HTMLElement;
}

/**
 * What the chat beside the panel gets from it. The chat owns the mirror and Type into terminal, and
 * draws them in the Terminal tab; the + menu leaves out Type, Keys and Quick replies wherever this is given.
 */
export interface SessionPanelLink {
  /** The Terminal tab's places while it is on screen, else null. */
  terminal: TerminalSlots | null;
  /** Open the panel on its Terminal tab. */
  showTerminal: () => void;
  /** What the chat read of its agent's session, for the Overview; given only where there is one. */
  report?: (reading: SessionReading) => void;
}

/** The model and how full the context is, as the agent last reported them; absent while unknown. */
export interface SessionReading {
  model?: string;
  contextPercent?: number;
}

export interface SessionInspectorState {
  /** Wide enough for the panel; below this nothing of it renders and its shortcut does nothing. */
  desk: boolean;
  open: boolean;
  width: number;
  /** The tab last picked; the panel shows Changes instead where it is not offered. */
  tab: InspectorTab;
  setOpen: (open: boolean) => void;
  setTab: (tab: InspectorTab) => void;
  setWidth: (width: number) => void;
  /** The panel's element, which folding slides out before it unmounts. */
  panelRef: React.RefObject<HTMLElement | null>;
  /** Set by an open the person asked for, so only that open slides the panel in. */
  entering: React.RefObject<boolean>;
  /** Whichever of the two toggles is on screen, so a press hands focus to its counterpart. */
  toggleRef: React.RefObject<HTMLButtonElement | null>;
  /** The Terminal tab's places, published by the tab while it is on screen. */
  terminal: TerminalSlots | null;
  setTerminal: (slots: TerminalSlots | null) => void;
  /** The chat's reading of its session, published through `panelLink`. */
  reading: SessionReading;
  setReading: (reading: SessionReading) => void;
}

/**
 * The desk's session panel: open or folded, its width and its tab, kept per device. ⌘⌥B (Ctrl+Alt+B
 * elsewhere) folds it. Owned by the pane route, so a switch between sessions keeps it as it was.
 */
export function useSessionInspector(): SessionInspectorState {
  const desk = useMediaQuery(DESK);
  const [stored, setStored] = useState(readStored);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const entering = useRef(false);
  /** The fold under way, cancelled by an open that comes before it ends. */
  const folding = useRef<Animation | null>(null);
  const [terminal, setTerminal] = useState<TerminalSlots | null>(null);
  const [reading, setReadingState] = useState<SessionReading>({});
  // Every poll hands over a fresh object; only a changed value renders the panel again.
  const setReading = useCallback((next: SessionReading) => setReadingState((current) =>
    current.model === next.model && current.contextPercent === next.contextPercent ? current : next), []);
  const pressed = useRef(false);
  const update = (patch: Partial<Stored>) => setStored((current) => {
    const next = { ...current, ...patch };
    writeStored(next);
    return next;
  });
  /**
   * Open slides in once mounted; folding slides out first, and unmounts when that ends. Only a press
   * moves it: the shortcut opens and folds at once, as a key does.
   */
  const show = (open: boolean, slide: boolean) => {
    if (open) {
      const fold = folding.current;
      folding.current = null;
      // Still mounted mid-fold: the panel just stays, without sliding in again.
      if (fold) fold.cancel();
      else entering.current = slide;
      update({ open });
      return;
    }
    if (folding.current) return;
    const out = slide && panelRef.current && slidePanel(panelRef.current, "out");
    if (!out) return update({ open: false });
    folding.current = out;
    out.finished.then(() => {
      if (folding.current !== out) return;
      folding.current = null;
      update({ open: false });
    }, () => {});
  };
  const setOpen = (open: boolean) => {
    pressed.current = true;
    show(open, true);
  };

  useEffect(() => {
    if (pressed.current) toggleRef.current?.focus({ preventScroll: true });
    pressed.current = false;
  }, [stored.open]);

  // The shortcut leaves focus where it was: folding while typing keeps the cursor in the composer.
  const latest = useRef({ desk, open: stored.open, show });
  latest.current = { desk, open: stored.open, show };
  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      // `code`, not `key`: Option+B types "∫" on a Mac.
      if (event.defaultPrevented || event.shiftKey || !event.altKey || !(event.metaKey || event.ctrlKey) || event.code !== "KeyB") return;
      if (!latest.current.desk || isLocked()) return;
      event.preventDefault();
      // Mid-fold the panel reads as folded already, so the shortcut brings it back.
      latest.current.show(!latest.current.open || folding.current !== null, false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return {
    desk,
    open: stored.open,
    width: stored.width,
    tab: stored.tab,
    setOpen,
    setTab: (tab) => update({ tab }),
    setWidth: (width) => update({ width: clampWidth(width) }),
    panelRef,
    entering,
    toggleRef,
    terminal,
    setTerminal,
    reading,
    setReading,
  };
}

/** The panel as the chat beside it sees it (agent-chat.tsx `sessionPanel`). */
export function panelLink(inspector: SessionInspectorState): SessionPanelLink {
  return {
    // Null whenever the tab is not on screen: it publishes its places on mount and withdraws them.
    terminal: inspector.terminal,
    showTerminal: () => {
      inspector.setOpen(true);
      inspector.setTab("terminal");
    },
  };
}

/**
 * The right column's slide when the person opens or folds it: its width moves, so the chat beside it
 * follows instead of jumping, while what it holds keeps its full width and fades (project.css
 * `data-sliding`). A panel's length in, a control's out, both decelerating (index.css --motion-*). Null, so the change is instant, under
 * reduced motion or without Web Animations.
 */
export function slidePanel(panel: HTMLElement, direction: "in" | "out"): Animation | null {
  if (typeof panel.animate !== "function" || reducedMotion()) return null;
  const width = panel.getBoundingClientRect().width;
  const hidden = { width: "0px", opacity: 0 };
  const shown = { width: `${width}px`, opacity: 1 };
  panel.style.setProperty("--slide-width", `${width}px`);
  panel.dataset.sliding = "";
  const slide = direction === "in"
    ? panel.animate([hidden, shown], { duration: MOTION_PANEL_MS, easing: MOTION_EASE })
    : panel.animate([shown, hidden], { duration: MOTION_CONTROL_MS, easing: MOTION_EASE, fill: "forwards" });
  const done = () => { delete panel.dataset.sliding; };
  slide.finished.then(done, done);
  return slide;
}

/** The chat keeps 22rem beside the right column (project.css `.session-panel`). */
const CHAT_MIN = 352;

/** The right column's left edge, the session panel's or a docked thread's: one width for both. */
export function ColumnEdge({ inspector, label }: { inspector: SessionInspectorState; label: string }) {
  return <ResizeHandle label={label} edge="start" width={inspector.width} range={PANEL_WIDTH} onChange={inspector.setWidth}
    limit={(column) => {
      // A frame not laid out yet measures nothing: the range alone bounds the width then.
      const room = column.parentElement?.getBoundingClientRect().width;
      return room ? room - CHAT_MIN : Infinity;
    }} />;
}

/** A session's pull request as the panel's Changes shows it, from GitHub or from Organizations. */
export interface SessionPr {
  number?: number;
  title: string;
  url?: string;
  head?: string;
  base?: string;
  state?: ThreadPullRequest["state"];
  review?: ThreadPullRequest["review"];
  checks?: ThreadPullRequest["checks"];
  diff?: { additions: number; deletions: number };
}

/** The PR of the branch a pane's folder is on (GitHub), else the one its thread carries (Organizations). */
export function sessionPr(data: Pick<HomeData, "pullRequests">, paneId: string, thread?: ProjectThreadView): SessionPr | undefined {
  const repo = data.pullRequests?.find((pr) => pr.paneIds.includes(paneId));
  const pr = thread?.pr;
  // Organizations' ticker reads checks and review GitHub's list may leave out.
  if (repo) return { number: repo.number, title: repo.title, url: repo.url, head: repo.branch, base: repo.base, state: repo.draft ? "draft" : "open",
    review: repo.review ?? pr?.review, checks: repo.checks ?? pr?.checks, diff: repo.diff };
  return pr && { number: pr.number, title: thread.title, url: pr.url, head: thread.branch || undefined, state: pr.state, review: pr.review, checks: pr.checks, diff: pr.diff };
}

export const ICON_BUTTON = "flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground active:bg-muted aria-pressed:bg-accent aria-pressed:text-foreground";

/** The chat header's way back to a folded panel, with the PR's size when Nenu already knows it. */
export function InspectorToggle({ inspector, pr }: { inspector: SessionInspectorState; pr?: SessionPr }) {
  return (
    <button ref={inspector.toggleRef} type="button" aria-label="Show session panel" title="Show session panel (⌘⌥B)" onClick={() => inspector.setOpen(true)}
      className={cn(ICON_BUTTON, pr?.diff && "w-auto gap-1.5 px-2 text-xs")}>
      <PanelRightOpen aria-hidden className="size-4" />
      {pr?.diff && <span className="font-mono tabular-nums">
        <span className="text-status-done">+{pr.diff.additions}</span> <span className="text-status-blocked">−{pr.diff.deletions}</span>
      </span>}
    </button>
  );
}

/**
 * A session's panel on a desk, right of its chat (inspector-panels.tsx). Until its chunk lands it
 * holds its width empty, so the chat does not jump.
 */
export function SessionInspector(props: ComponentProps<typeof SessionPanel>) {
  return (
    <Suspense fallback={<div aria-hidden className="session-panel" style={{ width: props.inspector.width }} />}>
      <SessionPanel {...props} />
    </Suspense>
  );
}
