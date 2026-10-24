import { useEffect, useReducer } from "react";

/** Milliseconds from `now` to the next local midnight. */
export function untilMidnight(now = Date.now()): number {
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return next.getTime() - now;
}

/**
 * Re-renders the caller when the local day turns, while `active`. For text that reads the clock to name
 * a day ("resets Fri 6:40 PM" drops "Fri" on Friday) in a component that no longer redraws on every poll.
 */
export function useDayTurn(active: boolean): void {
  const [day, turn] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!active) return;
    // A second past midnight, so the redraw reads the new day.
    const timer = setTimeout(turn, untilMidnight() + 1_000);
    // Timers freeze while the device sleeps: a return checks the date itself.
    const armed = new Date().toDateString();
    const onReturn = () => {
      if (document.visibilityState === "visible" && new Date().toDateString() !== armed) turn();
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, [active, day]);
}
