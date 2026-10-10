import { ClaudeActivity } from "../claude-activity.ts";
import type { PaneAction, PaneRouteRequest, Services } from "./context.ts";
import { json, jsonError } from "./http.ts";

// `/api/pane/:id/activity` — the Claude session bound to this pane: its workflows, background
// commands and artifacts. `?run=<runId>` adds each agent's return value, `?task=<taskId>` tails a
// command's output. Ids are validated by the reader; the session comes from the pane, never the client.

// One reader per server, so its tails, caches and watchers outlive a request.
const readers = new WeakMap<Services, ClaudeActivity>();
function readerFor(ctx: Services): ClaudeActivity {
  let reader = readers.get(ctx);
  if (!reader) readers.set(ctx, reader = new ClaudeActivity(ctx.cfg.journalRoots.claude));
  return reader;
}

async function activityRead(ctx: Services, { req, url, rt, paneId }: PaneRouteRequest): Promise<Response> {
  const encoding = req.headers.get("accept-encoding");
  if (!ctx.cfg.transcript) return json({ available: false, reason: "disabled" }, encoding);
  const original = rt.engine.current().agents.find((entry) => entry.paneId === paneId);
  if (!original) return json({ available: false, reason: "no-session" }, encoding);
  try {
    const pane = await ctx.conversations.resolve(original, rt.herdr, rt.name);
    if (pane.agent !== "claude") return json({ available: false, reason: "unsupported" }, encoding);
    if (pane.agentSession?.kind !== "id") return json({ available: false, reason: "no-session" }, encoding);
    const sessionId = pane.agentSession.value;
    const reader = readerFor(ctx);
    const run = url.searchParams.get("run");
    const task = url.searchParams.get("task");
    if (run !== null || task !== null) {
      const found = run !== null ? await reader.workflow(sessionId, run) : await reader.taskOutput(sessionId, task!);
      return found ? json(found, encoding) : jsonError("Not found in this session.", 404, null);
    }
    const listed = await reader.list(sessionId);
    if (listed.available) {
      void reader.observe(sessionId, `${rt.name}\0${paneId}`, () => ctx.live.publish({ session: rt.name, topic: "activity", paneId }))
        .catch(() => { /* Watching is an optimisation; the page's fallback poll still runs. */ });
    }
    return json(listed, encoding);
  } catch {
    return jsonError("Could not read activity for this session.", 503, null);
  }
}

export const activityPaneActions: Record<string, PaneAction> = {
  activity: { level: "read", marksSeen: false, handle: activityRead },
};
