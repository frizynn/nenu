import type { ThreadVerdict } from "./types";

/** How a report's verdict reads on a card. */
export const VERDICT_LABEL: Record<ThreadVerdict, string> = { done: "Done", "needs-decision": "Asks for your decision", blocked: "Blocked", failed: "Failed" };
