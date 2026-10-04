import type { AgentView } from "./types.ts";
import type { HerdrClient } from "./herdr-client.ts";

export async function queueReadiness(
  pane: Pick<AgentView, "paneId" | "agent" | "status">,
  _herdr: Pick<HerdrClient, "readPane">,
): Promise<"ready" | "working" | "unavailable"> {
  return pane.status === "working" ? "working" : ["idle", "done"].includes(pane.status) ? "ready" : "unavailable";
}
