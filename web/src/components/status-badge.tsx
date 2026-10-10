import { cn } from "@/lib/utils";
import type { AgentStatus } from "@/lib/types";

const DOT: Record<AgentStatus, string> = {
  blocked: "bg-status-blocked",
  working: "bg-status-working",
  done: "bg-status-done",
  idle: "bg-status-idle",
  unknown: "bg-status-unknown",
};

/**
 * As a FILL, the status palette needs a different ramp than it does as text. Every --status-* value
 * is tuned near the same lightness for text contrast, so drawn as solid discs the resting states
 * (idle / unknown) carry exactly as much weight as blocked — eighteen idle dots would out-shout the
 * one thing that needs you. The resting states are therefore hollow rings; the states that mean
 * something is happening stay solid.
 */
const RESTING: ReadonlySet<AgentStatus> = new Set(["idle", "unknown"]);

const RING: Record<AgentStatus, string> = {
  blocked: "border-status-blocked",
  working: "border-status-working",
  done: "border-status-done",
  idle: "border-status-idle/60",
  unknown: "border-status-unknown/60",
};

export function StatusDot({
  status,
  surface = "bg-background",
  className,
}: {
  status: AgentStatus;
  /**
   * The colour the dot sits ON. A hollow ring must be FILLED with its surface, not left
   * transparent: over the avatar's corner a transparent interior showed orange logo through one
   * half and page grey through the other, reading as a notch cut out of the icon rather than a
   * badge. Pass the card's surface when the dot sits on a card.
   */
  surface?: string;
  className?: string;
}) {
  const hollow = RESTING.has(status);
  // One static node per status. Colour alone carries activity, avoiding a permanent compositor
  // animation and the extra ping node for every working pane. `className` can still resize it.
  return (
    <span
      className={cn(
        "inline-flex size-2.5 shrink-0 rounded-full",
        hollow ? cn("border-[1.5px]", surface, RING[status]) : DOT[status],
        className,
      )}
    />
  );
}
