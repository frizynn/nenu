import { useEffect, useRef, useState } from "react";
import { useRevalidate } from "@/hooks/use-router";

import { agentName } from "@/hooks/use-message-queue";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import * as api from "@/lib/api";
import { setStatus } from "@/lib/status";
import type { InterruptResponse } from "@/lib/types";

// Stop stays offered this long after a send for the turn to show up (the bridge waits 4 s for it).
export const TURN_PENDING_MS = 8_000;
// "Stopping…" gives the button back if Herdr never reports the pane idle.
const STOPPING_MS = 8_000;

/** Beyond `working`: a sent message whose turn has not shown up yet, or one Stop in flight. */
type Phase = "idle" | "awaitingTurn" | "stopping";

export interface StopTurn {
  /** Show Stop: the agent works, its turn is about to start, or a Stop is in flight. */
  offered: boolean;
  phase: Phase;
  /** The bridge asked to confirm: stopping sends what the CLI's own queue holds. */
  armed: boolean;
  stop(): void;
  /** A message went out: offer Stop until its turn shows up. */
  turnSent(): void;
}

/**
 * Stop for one pane (ADR 0066). The bridge presses the CLI's interrupt key; this owns what the
 * composer shows meanwhile, so a second tap during "Stopping…" sends nothing.
 */
export function useStopTurn({ paneId, session, agent, interruptible, working, locked }: {
  paneId: string;
  session?: string;
  agent: string | null | undefined;
  /** The agent has a measured interrupt key and this device may write to the pane. */
  interruptible: boolean;
  working: boolean;
  locked: boolean;
}): StopTurn {
  const revalidate = useRevalidate();
  const confirm = usePendingConfirm(8_000);
  const [phase, setPhase] = useState<Phase>("idle");
  const workingRef = useRef(working);
  workingRef.current = working;
  useEffect(() => setPhase("idle"), [paneId, session]);
  // The turn showed up, or the stopped one ended.
  useEffect(() => setPhase((current) => (working ? (current === "awaitingTurn" ? "idle" : current) : current === "stopping" ? "idle" : current)), [working]);
  useEffect(() => {
    if (phase === "idle") return;
    const timer = setTimeout(() => setPhase("idle"), phase === "stopping" ? STOPPING_MS : TURN_PENDING_MS);
    return () => clearTimeout(timer);
  }, [phase]);
  const offered = interruptible && (working || phase !== "idle");
  const armed = confirm.pending === "stop";

  async function stop() {
    if (!offered || locked || phase === "stopping") return;
    const before = phase;
    if (armed) confirm.reset();
    setPhase("stopping");
    try {
      const result = await api.interruptPane(paneId, session, armed);
      if (!result.ok) {
        setPhase(result.code === "not_running" ? "idle" : before);
        if (result.code === "confirm_required") confirm.confirm("stop");
        setStatus(result.error, result.code === "confirm_required" || result.code === "not_running" ? "info" : "error");
        return;
      }
      // Stopped before this view saw it working, or Claude went straight on to its queued message:
      // no change of `working` is coming to end "Stopping…".
      if (!workingRef.current || result.queued === "sends") setPhase("idle");
      const note = stoppedNote(agentName(agent), result);
      if (note) setStatus(note, "info");
      revalidate();
    } catch (error) {
      setPhase(before);
      setStatus(error instanceof Error ? error.message : String(error), "error");
    }
  }

  return { offered, phase, armed, stop: () => void stop(), turnSent: () => setPhase("awaitingTurn") };
}

/** What a Stop did beyond stopping, for the status line; null when the button says enough. */
function stoppedNote(name: string, result: Extract<InterruptResponse, { ok: true }>): string | null {
  const notes = [
    result.pressed && result.confirmed === false ? `Escape went out, but ${name} still reports a running turn.` : null,
    result.queued === "sends" ? `${name} stopped and is reading your queued message.` : null,
    result.queued === "returns" ? `${name} stopped and put your queued message back in its input box.` : null,
    result.held === 1 ? "Your message queued in Nenu waits until you send it." : null,
    result.held > 1 ? `${result.held} messages queued in Nenu wait until you send them.` : null,
  ].filter(Boolean);
  return notes.length ? notes.join(" ") : null;
}
