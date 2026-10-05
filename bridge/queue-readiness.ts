import { hasCodexInterruptCue } from "../web/src/lib/harness/codex/interrupt.ts";
import type { AgentView } from "./types.ts";
import type { HerdrClient } from "./herdr-client.ts";
import { adapterFor } from "../web/src/lib/harness/index.ts";
import { parseAnsi } from "../web/src/lib/ansi.ts";
import { splitLines } from "../web/src/lib/blocks.ts";

export async function queueReadiness(
  pane: Pick<AgentView, "paneId" | "agent" | "status">,
  herdr: Pick<HerdrClient, "readPane">,
): Promise<"ready" | "working" | "unavailable"> {
  if (pane.status === "working") return "working";
  if (pane.status === "idle" || pane.status === "done") return "ready";
  if (pane.status !== "blocked") return "unavailable";
  const adapter = adapterFor(pane.agent);
  if (!adapter?.composerReady) return "unavailable";
  const { text } = await herdr.readPane(pane.paneId, "visible", 100, "ansi");
  if (pane.agent === "codex" && hasCodexInterruptCue(text)) return "working";
  const lines = splitLines(parseAnsi(text));
  return adapter.composerReady(lines) && !adapter.extractInputDraft(lines)?.trim()
    ? "ready" : "unavailable";
}
