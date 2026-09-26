import type { BridgeStatus } from "./types";

export interface ConnState {
  /** Herdr link reported by the snapshot; undefined before the first successful poll. */
  bridge: BridgeStatus | undefined;
  /** The most recent snapshot fetch failed, including a request timeout. */
  error: boolean;
}

// Pending refreshes do not mean the connection failed. On a slow link they occur on every poll;
// treating them as outages repeatedly blocked Send and flashed Reconnecting/Connected.
// usePollBusy owns loading feedback. Failed/timed-out reads and Herdr's status own connectivity.
// navigator.onLine is intentionally excluded: phones can report offline while requests succeed.
export function isConnecting({ bridge, error }: ConnState): boolean {
  return error || bridge === undefined || bridge === "disconnected";
}
