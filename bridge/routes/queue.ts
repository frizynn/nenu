import type { PaneAction } from "./context.ts";
import { secure } from "./http.ts";

export const queuePaneActions: Record<string, PaneAction> = {
  // Reading the queue is a read; changing it (add/edit/remove/send) is a write.
  queue: {
    level: (method) => (method === "GET" ? "read" : "write"),
    marksSeen: false,
    handle: async ({ queue }, { req, rt, paneId, device }) => secure(await queue.handle(req, rt.name, paneId, device)),
  },
};
