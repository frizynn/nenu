/** Test seam for the verification polls' pacing. */
export type Sleep = (ms: number) => Promise<void>;
export const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Bounded verification polling between choreography steps (the TUI re-renders well under a
// second; ~3s total before we give up and refresh).
export const POLL_ATTEMPTS = 8;
export const POLL_DELAY_MS = 350;

