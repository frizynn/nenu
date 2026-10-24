import { useEffect } from "react";
import { Pending } from "@/components/ui/icon";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// The cover shown while the idle lock is engaged. It sits ABOVE a still-mounted router (see App), so
// resuming returns you to the exact screen, draft and scroll position you left — nothing is unmounted
// and nothing is rebuilt.
//
// The scrim is deliberately GLASS rather than opaque. The cover's job is to say "this is frozen, not
// live" — a paused mirror read as a current one is the actual hazard — and it does that better while
// the herd stays legible underneath: you can see WHAT is stale instead of losing the screen entirely.
// The trade is that an unattended screen no longer hides agent output; that's accepted, because the
// device's own screen lock is the thing that was ever going to handle shoulder-surfing. The panel
// itself is a solid floating surface, so its copy reads over any pane text.
//
// It leads with the Nenu mark for a plain reason: this is the one screen in the app with no header,
// no herd chrome and no nav, so without the mark a full-viewport panel is unattributable — it could
// be any app that happened to be open. The mark is the STATIC app icon, never <DogGallop/>: that
// sprite's rest frame is a full-stretch mid-stride pose that reads as "frozen mid-run", and this
// screen is the app's most literal rest state.
//
// It fades in as a panel does, once, and leaves at once: Resume returns to the screen without a wait.
// Resume unmounts it for a render before the catch-up beat mounts it again (use-polling), so only the
// pause itself fades; the catch-up cover is simply there.
//
// No lock iconography and no "for safety" — the pause guards nothing (.adr/0007). Saying otherwise
// would promise a gate that a page reload has always walked straight through.
interface IdleLockProps {
  onUnlock: () => void;
  /** The refetch fired on resume is still in flight — hold the cover rather than dropping straight
   *  back onto the frozen screen this panel just warned about. */
  catchingUp?: boolean;
}

export function IdleLock({ onUnlock, catchingUp = false }: IdleLockProps) {
  // Enter resumes at a desk. The app behind is inert, so the key cannot reach a composer.
  useEffect(() => {
    if (catchingUp) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      onUnlock();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [catchingUp, onUnlock]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Nenu paused"
      className={cn("fixed inset-0 z-50 flex items-center justify-center bg-background/40 px-6 backdrop-blur-[3px]",
        !catchingUp && "animate-in fade-in duration-180 ease-out motion-reduce:duration-120")}
    >
      {/* One fixed width for both states, so the panel does not resize when Resume is pressed. */}
      <div className="flex w-80 max-w-full flex-col items-center rounded-2xl border border-border bg-popover px-6 pb-6 pt-8 text-center text-popover-foreground shadow-(--shadow-float)">
        <img src="/nenu-mark.png" alt="" className="nenu-mark size-12" />
        <h2 className="mt-4 text-headline">{catchingUp ? "Catching up" : "Paused"}</h2>
        <p className="mt-1 text-subhead text-muted-foreground text-pretty">
          {catchingUp ? "Fetching what changed while it was paused." : "Live updates stopped while this screen sat idle."}
        </p>
        {/* The button keeps its slot while catching up: disabled and busy, with a spinner that stays
            visible (still) under reduced motion, so there is always a cue that something is happening. */}
        <Button size="lg" className="mt-6 w-full" onClick={onUnlock} disabled={catchingUp} aria-busy={catchingUp || undefined}>
          {catchingUp && <Pending aria-hidden="true" />}
          {catchingUp ? "Resuming…" : "Resume"}
        </Button>
      </div>
    </div>
  );
}
