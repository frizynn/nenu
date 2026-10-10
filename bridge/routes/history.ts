import type { Config } from "../config.ts";
import type { ConversationService } from "../conversation-service.ts";
import type { HerdrClient } from "../herdr-client.ts";
import { historyResponse } from "../history-response.ts";
import { computeEtag, notModified } from "../http-cache.ts";
import { adapterFor } from "../journal/registry.ts";
import type { TranscriptStore } from "../journal/store.ts";
import type { AgentSessionRef, JournalAdapter } from "../journal/types.ts";
import type { StateEngine } from "../state-engine.ts";
import type { PaneHistoryResponse } from "../types.ts";
import { imageExtFromBytes } from "../uploads.ts";
import type { PaneAction, Services } from "./context.ts";
import { json, secure, text } from "./http.ts";

// Turns per history page. "Show entire history" means the WHOLE conversation, so the client asks for
// everything and this ceiling is a safety net against a pathological log, not the normal path — a
// 1400-turn session is ~1.4 MB raw / ~400 KB gzipped, which a tailnet link serves fine. The default
// only applies when a caller omits `limit` entirely.
const DEFAULT_HISTORY_LIMIT = 200;
const MAX_HISTORY_LIMIT = 5000;

/** Largest decoded journal image served, the same ceiling as a project file preview. */
export const MAX_JOURNAL_IMAGE_BYTES = 20 * 1024 * 1024;

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
  "journal-image": {
    level: "read",
    marksSeen: false,
    async handle(ctx, { req, url, rt, paneId }) {
      const params = journalImageParams(url);
      const journal = await paneJournal(ctx, rt.engine, paneId, rt.herdr, rt.name);
      if (!params || !journal || !ctx.transcripts) return imageError("Image unavailable.", 404);
      const image = await ctx.transcripts.image(journal.adapter, journal.ref, params.entry, params.n);
      if (!image) return imageError("Image unavailable.", 404);
      const etag = computeEtag(`${JSON.stringify(journal.ref)}\0${image.key}`);
      if (notModified(req.headers.get("if-none-match"), etag)) {
        return secure(new Response(null, { status: 304, headers: { etag, "cache-control": "private, no-cache" } }));
      }
      return journalImageResponse(await image.load(), etag);
    },
  },
};

/**
 * `?entry=<uuid>&n=<index>` — the only inputs journal-image takes. Both only ever reach in-memory
 * lookups (the store's image index), never the filesystem; null when either is malformed.
 */
export function journalImageParams(url: URL): { entry: string; n: number } | null {
  const entry = url.searchParams.get("entry");
  const raw = url.searchParams.get("n") ?? "";
  if (!entry || entry.length > 200 || !/^\d{1,4}$/.test(raw)) return null;
  return { entry, n: Number(raw) };
}

function imageError(message: string, status: number): Response {
  return secure(new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } }));
}

/**
 * Serve one decoded journal image. The bytes are base64 an agent wrote, so the type is sniffed rather
 * than believed, the size is capped before decoding, and the response is no document: the same
 * `default-src 'none'; sandbox` file responses carry. Pure so the policy is unit-tested.
 */
export function journalImageResponse(image: { data: string } | null, etag: string): Response {
  if (!image) return imageError("Image unavailable.", 404);
  if (image.data.length > Math.ceil(MAX_JOURNAL_IMAGE_BYTES / 3) * 4) return imageError("Image too large.", 413);
  const bytes = Buffer.from(image.data, "base64");
  const ext = imageExtFromBytes(bytes.subarray(0, 16));
  if (!ext) return imageError("Not a supported image.", 415);
  return secure(new Response(bytes, {
    headers: {
      "content-type": ext === "jpg" ? "image/jpeg" : `image/${ext}`,
      "content-length": String(bytes.length),
      "cache-control": "private, no-cache",
      etag,
      "content-security-policy": "default-src 'none'; sandbox",
    },
  }));
}

/**
 * The journal a live pane names: its adapter and session ref, resolved from the snapshot by pane id
 * (the client never sends a ref). Null for every reason there is nothing to read.
 */
async function paneJournal(
  { cfg, journals, transcripts, conversations }: Services,
  engine: StateEngine,
  paneId: string,
  herdr: HerdrClient,
  session: string,
): Promise<{ adapter: JournalAdapter; ref: AgentSessionRef } | null> {
  if (!cfg.transcript || transcripts === null || journals === null) return null;
  const { agents, shellPanes } = engine.current();
  const original = [...agents, ...shellPanes].find((a) => a.paneId === paneId);
  const pane = original ? await conversations.resolve(original, herdr, session) : undefined;
  const adapter = pane?.agentSession ? adapterFor(journals, pane.agent) : undefined;
  return pane?.agentSession && adapter ? { adapter, ref: pane.agentSession } : null;
}

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
