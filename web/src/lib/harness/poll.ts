/** Test seam for the verification polls' pacing. */
export type Sleep = (ms: number) => Promise<void>;
export const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Bounded verification polling between choreography steps (the TUI re-renders well under a
// second; ~3s total before we give up and refresh).
export const POLL_ATTEMPTS = 8;
export const POLL_DELAY_MS = 350;

/**
 * The send paths' verification reads: the wait before each read, the first one immediate. A TUI
 * usually repaints within tens of milliseconds, so a fixed 350ms step charged most sends a whole
 * step for nothing. The steps start short and grow to the old pace, and the total window stays at
 * least POLL_ATTEMPTS × POLL_DELAY_MS, so a slow terminal gets as long as it always did. Only when
 * a read happens changes; what a read must show before the next key goes out does not.
 */
export const VERIFY_DELAYS_MS: readonly number[] = [0, 40, 80, 120, 200, 300, 350, 350, 350, 350, 350];
