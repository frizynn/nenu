import type { Config } from "../config.ts";
import type { ConversationService } from "../conversation-service.ts";
import type { HerdrClient } from "../herdr-client.ts";
import { historyResponse } from "../history-response.ts";
import { computeEtag } from "../http-cache.ts";
import { adapterFor } from "../journal/registry.ts";
import type { TranscriptStore } from "../journal/store.ts";
import type { JournalAdapter } from "../journal/types.ts";
import type { StateEngine } from "../state-engine.ts";
import type { PaneHistoryResponse } from "../types.ts";
import type { PaneAction } from "./context.ts";
import { json, secure, text } from "./http.ts";

// Turns per history page. "Show entire history" means the WHOLE conversation, so the client asks for
// everything and this ceiling is a safety net against a pathological log, not the normal path — a
// 1400-turn session is ~1.4 MB raw / ~400 KB gzipped, which a tailnet link serves fine. The default
// only applies when a caller omits `limit` entirely.
const DEFAULT_HISTORY_LIMIT = 200;
const MAX_HISTORY_LIMIT = 5000;

export const historyPaneActions: Record<string, PaneAction> = {
  history: {
    level: "read",
    marksSeen: false,
    async handle({ cfg, journals, transcripts, conversations, journalWatch }, { req, url, rt, paneId }) {
      const response = await paneHistory(cfg, journals, transcripts, rt.engine, paneId, url, req, conversations, rt.herdr, rt.name);
      journalWatch.noteRead(rt.name, paneId);
      return response;
    },
  },
};

/**
 * Parse the history page params. Pure + exported so the clamping is unit-tested without Bun.serve.
 * `before` is an opaque cursor (a turn's uuid) that only ever reaches an in-memory `findIndex`, so it
 * needs no validation beyond length — it never touches the filesystem.
 */
export function historyParams(url: URL): { limit: number; before?: string } {
  const raw = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit =
    Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_HISTORY_LIMIT) : DEFAULT_HISTORY_LIMIT;
  const before = url.searchParams.get("before");
  return { limit, ...(before && before.length <= 100 ? { before } : {}) };
}

/**
 * GET /api/pane/:id/history — the conversation history the pane's terminal cannot provide.
 *
 * The session ref is resolved HERE, from the live snapshot, keyed by pane id — the client never sends
 * one. That is the whole safety story for a route that reads files: the only client-controlled inputs
 * are a pane id (a Map lookup) and an opaque cursor (an array lookup). Which harness knows how to
 * read the log is the registry's decision, so this route stays agent-agnostic.
 */
async function paneHistory(
  cfg: Config,
  journals: Record<string, JournalAdapter> | null,
  transcripts: TranscriptStore | null,
  engine: StateEngine,
  paneId: string,
  url: URL,
  req: Request,
  conversations: ConversationService,
  herdr: HerdrClient,
  session: string,
): Promise<Response> {
  const accept = req.headers.get("accept-encoding");
  const unavailable = (reason: "disabled" | "no-session" | "no-log") =>
    json({ paneId, available: false, reason } satisfies PaneHistoryResponse, accept);

  if (!cfg.transcript || transcripts === null || journals === null) return unavailable("disabled");

  const { agents, shellPanes } = engine.current();
  const original = [...agents, ...shellPanes].find((a) => a.paneId === paneId);
  const pane = original ? await conversations.resolve(original, herdr, session) : undefined;
  // No pane, or an agent that named no session (a shell, or a harness whose integration isn't
  // installed): nothing to read, and that's an ordinary answer rather than an error.
  if (!pane?.agentSession) return unavailable("no-session");
  // An agent with no adapter has no journal. Same answer — the UI shouldn't distinguish "this
  // harness isn't supported" from "this pane never started one"; both mean there's nothing to show.
  const adapter = adapterFor(journals, pane.agent);
  if (adapter === undefined) return unavailable("no-session");

  try {
    const page = await transcripts.page(adapter, pane.agentSession, historyParams(url))
      ?? await conversations.page(pane, historyParams(url));
    if (page === null) return unavailable("no-log");
    return secure(historyResponse(page, paneId, req.headers.get("if-none-match"), accept, computeEtag(JSON.stringify(pane.agentSession))));
  } catch (err) {
    return text(`transcript read failed: ${(err as Error).message}`, 502);
  }
}
