import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { PanelRightOpen } from "@/components/ui/icon";

import { useMediaQuery } from "@/hooks/use-media-query";
import { isLocked } from "@/lib/idle";
import type { HomeData } from "@/lib/loaders";
import type { ProjectThreadView, ThreadPullRequest } from "@/lib/types";
import { cn } from "@/lib/utils";

// The panel is its own chunk: a phone never loads it, a desk on first open.
const SessionPanel = lazy(() => import("./inspector-panels"));

/** The panel's tabs; Overview only for a pane that belongs to a project. */
export type InspectorTab = "overview" | "changes" | "files" | "terminal";
export const INSPECTOR_TABS: readonly InspectorTab[] = ["overview", "changes", "files", "terminal"];

/** The breakpoint where the workbench shows its sidebar; the panel exists only from there. */
const DESK = "(min-width: 1024px)";
const STORE_KEY = "nenu:session-panel:v1";
export const PANEL_WIDTH = { min: 320, initial: 460, max: 760, step: 16 } as const;

interface Stored { open: boolean; width: number; tab: InspectorTab }
const INITIAL: Stored = { open: true, width: PANEL_WIDTH.initial, tab: "overview" };
export const clampWidth = (width: number) => Math.round(Math.min(PANEL_WIDTH.max, Math.max(PANEL_WIDTH.min, width)));

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
  /** What the chat read of its agent's session, for the panel's Overview. */
  report: (reading: SessionReading) => void;
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
  /** Open slides in once mounted; folding slides out first, and unmounts when that ends. */
  const show = (open: boolean) => {
    if (open) {
      const fold = folding.current;
      folding.current = null;
      // Still mounted mid-fold: the panel just stays, without sliding in again.
      if (fold) fold.cancel();
      else entering.current = true;
      update({ open });
      return;
    }
    if (folding.current) return;
    const slide = panelRef.current && slidePanel(panelRef.current, "out");
    if (!slide) return update({ open: false });
    folding.current = slide;
    slide.finished.then(() => {
      if (folding.current !== slide) return;
      folding.current = null;
      update({ open: false });
    }, () => {});
  };
  const setOpen = (open: boolean) => {
    pressed.current = true;
    show(open);
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
      latest.current.show(!latest.current.open || folding.current !== null);
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
    report: inspector.setReading,
  };
}

/**
 * The panel's slide when the person opens or folds it: transform and opacity only, 200 ms in and
 * 160 ms out. Null, so the change is instant, under reduced motion or without Web Animations.
 */
export function slidePanel(panel: HTMLElement, direction: "in" | "out"): Animation | null {
  if (typeof panel.animate !== "function" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return null;
  const hidden = { opacity: 0, transform: "translateX(16px)" };
  const shown = { opacity: 1, transform: "none" };
  return direction === "in"
    ? panel.animate([hidden, shown], { duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" })
    : panel.animate([shown, hidden], { duration: 160, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" });
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

export const ICON_BUTTON = "flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground active:bg-muted aria-pressed:bg-accent aria-pressed:text-foreground";

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
