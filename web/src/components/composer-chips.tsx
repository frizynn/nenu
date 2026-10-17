import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ArrowLeft, Clock, GitBranch, GitPullRequest, Laptop, X } from "@/components/ui/icon";

import { StatusDot } from "@/components/status-badge";
import { WorkbenchPopover } from "@/components/ui/workbench-popover";
import { useBackCloses } from "@/hooks/use-back-closes";
import { useMediaQuery } from "@/hooks/use-media-query";
import { threadAge, threadDetail } from "@/components/project-tasks";
import { fetchOrgRoutines } from "@/lib/api";
import { timeAgoShort } from "@/lib/format";
import { nodeState } from "@/lib/org-tree";
import type { AgentView, ProjectThreadView, ProjectView, RoutineView } from "@/lib/types";
import { cn } from "@/lib/utils";

// The row above the composer (issue: Cursor-style chips): what needs you, what works, the open pull
// requests and the routines around this chat, one chip each, and the chip's panel floating over the
// thread. It takes the place of the PR bar and of the Background chip that sat under the box, and
// shares its line with the composer's Stop. Every mark is still: a working state is a dot, never a
// spinner, so an idle page draws nothing.

export type ChipId = "needs" | "working" | "prs" | "routines";

/** What a project hands the chat it wraps: the threads around it and how to open one. */
export interface ProjectChipsSource {
  project: ProjectView;
  /** The chat's own thread; absent for the project's coordinator. */
  thread?: ProjectThreadView;
  /** The threads around it: a coordinator's subtree, or a thread's siblings under its coordinator. */
  threads: readonly ProjectThreadView[];
  session?: string;
  readOnly: boolean;
  onOpenPane: (paneId: string) => void;
  onOpenNode: (id: string) => void;
  onChanged: () => void;
}

export interface ChipView {
  id: ChipId;
  label: string;
  /** Shown beside the label when above zero. */
  count: number;
  /** The panel's name, when it says more than the label ("Pull requests" for "PRs"). */
  title?: string;
  mark?: ReactNode;
  /** Only finished work behind it: drawn a step back from the chips that are live. */
  quiet?: boolean;
  content: ReactNode;
}

/** The threads around a chat, the chat's own left out: it is on screen already. */
export function threadsAround(source: ProjectChipsSource, paneId: string) {
  const others = source.threads.filter((thread) => thread.id !== source.thread?.id && thread.paneId !== paneId);
  return {
    needs: others.filter((thread) => nodeState(thread) === "needs"),
    working: others.filter((thread) => nodeState(thread) === "working"),
    /** History, newest first: never a chip of its own, only folded under what still works. */
    resolved: others.filter((thread) => nodeState(thread) === "resolved").sort((a, b) => (Date.parse(b.updated ?? "") || 0) - (Date.parse(a.updated ?? "") || 0)),
  };
}

export const NEEDS_MARK = <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-status-blocked" />;
export const WORKING_MARK = <StatusDot status="working" className="size-1.5" />;
const RESOLVED_MARK = <span aria-hidden className="size-1.5 shrink-0 rounded-full border border-muted-foreground/60" />;
const MARKS = { needs: NEEDS_MARK, resolved: RESOLVED_MARK } as const;

/** One row per thread: its mark, its name, what it is doing and since when. A tap opens it. */
export function ThreadRows({ threads, panes, now, onOpen }: {
  threads: readonly ProjectThreadView[];
  panes: readonly AgentView[];
  now: number;
  onOpen: (thread: ProjectThreadView) => void;
}) {
  return (
    <ul className="flex flex-col">
      {threads.map((thread) => {
        const state = nodeState(thread);
        return <li key={thread.id}>
          <button type="button" className={cn("composer-chip-item", state === "resolved" && "text-muted-foreground")} onClick={() => onOpen(thread)}>
            <span className="flex w-3.5 shrink-0 justify-center">{state === "needs" || state === "resolved" ? MARKS[state] : WORKING_MARK}</span>
            <span className="min-w-0 flex-1 truncate">{thread.title} <span className="text-muted-foreground">{threadDetail(thread, panes)}</span></span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{threadAge(thread, now)}</span>
          </button>
        </li>;
      })}
    </ul>
  );
}

/**
 * A project's routines, read when the chat opens and again each time their chip opens: Organizations
 * runs them on its own clock, so nothing here polls. An Organizations that cannot list them, or a read
 * that fails, leaves the last list (none at first), never a claim that there are none.
 */
export function useRoutines(project: string | undefined, session: string | undefined, opened: boolean): RoutineView[] {
  const [routines, setRoutines] = useState<RoutineView[]>([]);
  // Each opening is one more read; closing reads nothing.
  const [opens, setOpens] = useState(0);
  useEffect(() => { if (opened) setOpens((count) => count + 1); }, [opened]);
  useEffect(() => {
    if (!project) return;
    let live = true;
    fetchOrgRoutines(project, session).then((list) => { if (live && list.available) setRoutines(list.routines); }, () => {});
    return () => { live = false; };
  }, [project, session, opens]);
  return routines;
}

/** When a routine acts next: on every PR event it names, at its next run, or never while off. */
function routineWhen(routine: RoutineView, now: number): string {
  if (!routine.enabled) return "off";
  if (routine.trigger === "pr") return "on";
  const next = Date.parse(routine.nextRun);
  if (!Number.isFinite(next)) return "on";
  const left = timeAgoShort(now, next);
  return left === "now" || next <= now ? "due" : `in ${left}`;
}

export function RoutineRows({ routines, now }: { routines: readonly RoutineView[]; now: number }) {
  return (
    <ul className="flex flex-col">
      {routines.map((routine) => {
        const Icon = routine.trigger === "pr" ? GitPullRequest : Clock;
        return (
          <li key={routine.name} className={cn("composer-chip-item", !routine.enabled && "text-muted-foreground")}>
            <span className="flex w-3.5 shrink-0 justify-center"><Icon aria-hidden className="size-3.5" /></span>
            <span className="min-w-0 flex-1 truncate"><span>{routine.name}</span> <span className="text-muted-foreground">
              {routine.trigger === "pr" ? `on ${routine.events.join(", ")}` : routine.schedule}
            </span></span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{routineWhen(routine, now)}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** The chips a chat hands its composer, which one is open, and on a phone a process's details. */
export interface ChipLine {
  chips: readonly ChipView[];
  open: ChipId | null;
  onOpenChange: (id: ChipId | null) => void;
  detail?: { title: string; content: ReactNode; onBack: () => void } | null;
  /** Chips are likely here (a project's chat): while it settles, the line keeps its height for them. */
  likely?: boolean;
}

/** A press that belongs to something the panel opened, such as a confirmation or a diff over the page. */
const inLayerAbove = (target: Element) => target.closest('[role="dialog"], [role="alertdialog"], [data-workbench-popover]') !== null;

const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * The line above the box: the chips at its start and `trailing` (the composer's Stop) at its end, and
 * the open chip's panel floating over the thread, anchored to the line. The panel takes no height, so
 * opening it moves neither the box nor the conversation. One panel at a time; the chip toggles it, and
 * ✕, Escape, a press outside it or, on a phone, Back close it. While open, Tab stays inside it, and
 * closing gives focus back to the chip. On a phone a process's details take the panel's place, named
 * by its header, with Back.
 */
export function ComposerChips({ chips, open, onOpenChange, detail, trailing }: ChipLine & { trailing?: ReactNode }) {
  const buttons = useRef(new Map<ChipId, HTMLButtonElement>());
  const line = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const shown = chips.find((chip) => chip.id === open);
  const phoneBack = useMediaQuery("(pointer: coarse)");
  // A phone's Back closes the panel. Closed by a row that opens another page, its entry stays:
  // stepping back then would race the navigation the row just started.
  const leaveEntry = useBackCloses("nenuChipPanel", Boolean(shown), phoneBack, () => closeRef.current("back"));
  // How the panel closes says what follows. Its own ✕, Escape or chip steps back over the entry it
  // pushed, so Back afterwards leaves the chat, and hands focus to the chip; a press outside leaves
  // both alone, since it may be starting a navigation or placing a caret; Back has already stepped.
  const closeRef = useRef<(how: "own" | "outside" | "back") => void>(() => {});
  closeRef.current = (how) => {
    if (!shown) return;
    if (how === "own") leaveEntry();
    onOpenChange(null);
    if (how !== "outside") buttons.current.get(shown.id)?.focus({ preventScroll: true });
  };

  // The panel opens with focus inside it, where the keyboard stays until it closes.
  useEffect(() => {
    if (!shown) return;
    panel.current?.focus({ preventScroll: true });
  }, [shown?.id]);

  useEffect(() => {
    if (!shown) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || line.current?.contains(target) || inLayerAbove(target)) return;
      closeRef.current("outside");
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      if (event.target instanceof Element && !line.current?.contains(event.target) && inLayerAbove(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current("own");
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [Boolean(shown)]);

  if (chips.length === 0 && !trailing) return null;
  const close = () => closeRef.current("own");
  const trap = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab" || !panel.current) return;
    const stops = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.closest("[inert]"));
    if (stops.length === 0) { event.preventDefault(); return; }
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
  };
  const title = detail ? detail.title : shown && (shown.title ?? shown.label);
  return (
    <div ref={line} className="composer-chips">
      {shown && (
        <section ref={panel} id="composer-chip-panel" role="dialog" aria-label={title} tabIndex={-1} className="composer-chip-panel"
          onKeyDown={trap}>
          <div className="composer-chip-panel-head">
            {detail && <button type="button" aria-label="Back" onClick={detail.onBack} className="composer-chip-icon"><ArrowLeft aria-hidden className="size-4" /></button>}
            <h2 className="min-w-0 flex-1 truncate">{title}</h2>
            <button type="button" aria-label="Close" onClick={close} className="composer-chip-icon"><X aria-hidden className="size-3.5" /></button>
          </div>
          <div className="composer-chip-panel-body">{detail ? detail.content : shown.content}</div>
        </section>
      )}
      <div className="composer-line">
        {chips.length > 0 && <div role="group" aria-label="Status" className="composer-chip-row">
          {chips.map((chip) => (
            <button key={chip.id} ref={(node) => { if (node) buttons.current.set(chip.id, node); else buttons.current.delete(chip.id); }}
              type="button" className="composer-chip" data-quiet={chip.quiet || undefined}
              aria-label={chip.count > 0 ? `${chip.label}, ${chip.count}` : chip.label}
              aria-expanded={chip.id === open} aria-haspopup="dialog" aria-controls={chip.id === open ? "composer-chip-panel" : undefined}
              onClick={() => (chip.id === open ? close() : onOpenChange(chip.id))}>
              {chip.mark}
              <span>{chip.label}</span>
              {chip.count > 0 && <span className="composer-chip-count">{chip.count}</span>}
            </button>
          ))}
        </div>}
        {trailing}
      </div>
    </div>
  );
}

/** The machine Nenu reaches Herdr on, as the browser names it: a bare address whole, a host's first label. */
export function machineName(hostname = window.location.hostname): string {
  return /^[\d.]+$|:/.test(hostname) ? hostname : hostname.split(".")[0] || "local";
}

/**
 * Under the box: the branch the chat works on, when known, and the machine it runs on (Herdr's name
 * for it, with more than one). A desk has the room to say both whole. A phone gives the row to the
 * model and the context, and keeps the two behind one tap, so neither is ever cut mid-word.
 */
export function ComposerPlace({ branch, machine }: { branch?: string; machine?: string }) {
  const compact = !useMediaQuery("(min-width: 768px)");
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const host = machine ?? machineName();
  const branchItem = branch && <span className="composer-place-item" title={branch}><GitBranch aria-hidden className="size-3.5 shrink-0" /><span className="truncate font-mono">{branch}</span></span>;
  const hostItem = <span className="composer-place-item shrink-0"><Laptop aria-hidden className="size-3.5 shrink-0" /><span className="truncate">{host}</span></span>;
  if (!compact) return <span className="composer-place">{branchItem}{hostItem}</span>;
  const label = branch ? `${branch} on ${host}` : host;
  return (
    <span className="composer-place justify-end">
      <button ref={anchor} type="button" className="composer-quiet hit-area gap-1.5" aria-label={`Where this runs: ${label}`} aria-haspopup="dialog" aria-expanded={open}
        onClick={() => setOpen(!open)}>
        {branch && <GitBranch aria-hidden className="size-3.5 shrink-0" />}
        <Laptop aria-hidden className="size-3.5 shrink-0" />
      </button>
      <WorkbenchPopover open={open} onDismiss={() => setOpen(false)} anchorRef={anchor} label="Where this runs">
        <dl className="composer-place-detail">
          {branch && <><dt>Branch</dt><dd className="font-mono">{branch}</dd></>}
          <dt>Machine</dt><dd>{host}</dd>
        </dl>
      </WorkbenchPopover>
    </span>
  );
}
