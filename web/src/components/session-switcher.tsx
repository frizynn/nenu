import { useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { Layers } from "@/components/ui/icon";

import { RowBody } from "@/components/nav-rows";
import { StatusDot } from "@/components/status-badge";
import { BottomSheet } from "@/components/ui/sheet";
import { isMachineSession } from "@/lib/machines";
import { homePath } from "@/lib/nav";
import { TITLE_SEP } from "@/lib/pane-name";
import type { AgentStatus, SessionSummary } from "@/lib/types";

interface SessionSwitcherProps {
  /** The bridge's session registry (primary-first). */
  sessions: SessionSummary[];
  /** The current session name (undefined = primary). */
  current: string | undefined;
}

// Compact session switcher for the header's right cluster. Backward compatible by construction: the
// trigger renders ONLY when there's a real choice — more than one reachable session, or you're
// already on a non-primary one (so you can always get back). A single-session install shows nothing.
// The sheet lists every session; unreachable ones (crashed / stale socket) are greyed out and
// non-clickable. Selecting one navigates home in that session (primary → no `?s=`).
export function SessionSwitcher({ sessions, current }: SessionSwitcherProps) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  // Another machine is a session to the browser, not one of this Herdr's: the machine lists name it.
  if (isMachineSession(current)) return null;
  const reachableCount = sessions.filter((s) => s.reachable).length;
  const onNonPrimary = current !== undefined;
  if (reachableCount <= 1 && !onNonPrimary) return null;

  // The name to show on the trigger: the current session, or the primary's registry name when on it.
  const currentName = current ?? sessions.find((s) => s.isPrimary)?.name ?? "default";
  const isActive = (s: SessionSummary): boolean =>
    current === undefined ? s.isPrimary : s.name === current;

  function select(s: SessionSummary): void {
    setOpen(false);
    if (!s.reachable) return; // unreachable rows are non-clickable (disabled), guard anyway
    const target = s.isPrimary ? undefined : s.name; // primary carries no `?s=`
    if (target === current) return; // already here
    navigate(homePath(target));
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Session: ${currentName}. Switch session`}
        className="hit-area flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-1 text-caption font-medium text-muted-foreground transition-colors hover:bg-muted/70 active:scale-95"
      >
        <Layers className="size-3.5" />
        <span className="max-w-[7rem] truncate">{currentName}</span>
      </button>

      {/* Portal to document.body so the sheet's `fixed inset-0` always resolves against the viewport,
          not an ancestor: any transform / filter / backdrop-filter on the app header (it has carried a
          backdrop-blur before) would make it the containing block and clip the sheet to the header band. */}
      {createPortal(
        <BottomSheet open={open} onClose={() => setOpen(false)} title="Sessions">
          {/* The navigation's own rows: a state dot, the name, the state in words under it. */}
          <ul className="-mx-2.5 flex flex-col">
            {sessions.map((s) => (
              <li key={s.name}>
                <button
                  type="button"
                  disabled={!s.reachable}
                  onClick={() => select(s)}
                  aria-current={isActive(s) ? "page" : undefined}
                  className="nav-pane"
                >
                  <RowBody mark={<StatusDot status={sessionState(s)} surface="bg-transparent" className="size-2" />}
                    title={s.name} detail={sessionDetail(s) || undefined} />
                </button>
              </li>
            ))}
          </ul>
        </BottomSheet>,
        document.body,
      )}
    </>
  );
}

/** The dot a session's row wears: its most pressing state, as a pane's dot says it. */
function sessionState(s: SessionSummary): AgentStatus {
  if (!s.reachable) return "unknown";
  return s.blocked > 0 ? "blocked" : s.working > 0 ? "working" : "idle";
}

/** The line under a session's name: primary or not, then what needs you and what runs, in words. */
function sessionDetail(s: SessionSummary): string {
  const state = s.reachable
    ? [s.blocked > 0 && `${s.blocked} needs you`, s.working > 0 && `${s.working} working`]
    : ["Unreachable"];
  return [s.isPrimary && "Primary", ...state].filter(Boolean).join(TITLE_SEP);
}
