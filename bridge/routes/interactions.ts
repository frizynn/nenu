import { computeEtag, notModified } from "../http-cache.ts";
import type { HintSource } from "../interactions.ts";
import { adapterFor } from "../journal/registry.ts";
import type { SessionRuntime } from "../sessions.ts";
import type { AgentView, AnswerRequest, InteractionHint } from "../types.ts";
import { deviceAuth } from "./access.ts";
import type { PaneAction, Route, Services } from "./context.ts";
import { json, jsonError, secure } from "./http.ts";

// GET every blocked pane's detected dialog and POST /api/interactions/:paneId/answer (ADR 0057). The
// answer is the whole guarded sequence on the bridge: re-read, compare signature, type, so a card
// costs one request instead of a pane read plus a bound key write.

const MAX_SIGNATURE = 64;
const MAX_TEXT = 2_000;

/**
 * Where a pane's dialog text can be enriched from: the latest Claude hook hint and the journal's
 * still-unanswered AskUserQuestion/ExitPlanMode. Neither ever chooses a key.
 */
export function interactionHints(ctx: Services, rt: Pick<SessionRuntime, "herdr">): HintSource {
  return async (session, pane) => {
    const hints: InteractionHint[] = [];
    const hook = ctx.claudeHooks.hintFor(session, pane.paneId);
    if (hook) hints.push(hook);
    const pending = await journalHint(ctx, rt, session, pane).catch(() => undefined);
    if (pending) hints.push(pending);
    return hints;
  };
}

async function journalHint({ cfg, journals, transcripts, conversations }: Services, rt: Pick<SessionRuntime, "herdr">, session: string, pane: AgentView): Promise<InteractionHint | undefined> {
  if (!cfg.transcript || !journals || !transcripts) return undefined;
  const resolved = await conversations.resolve(pane, rt.herdr, session);
  const adapter = resolved.agentSession ? adapterFor(journals, resolved.agent) : undefined;
  if (!adapter || !resolved.agentSession) return undefined;
  return (await transcripts.facts(adapter, resolved.agentSession))?.pendingQuestion;
}

/** The body, or null when it is not a well-formed answer. */
export function parseAnswer(raw: unknown): AnswerRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const { signature, optionIndex, text, confirm } = raw as Record<string, unknown>;
  if (typeof signature !== "string" || !signature || signature.length > MAX_SIGNATURE) return null;
  if (typeof optionIndex !== "number" || !Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex > 99) return null;
  if (text !== undefined && (typeof text !== "string" || text.length > MAX_TEXT)) return null;
  if (confirm !== undefined && typeof confirm !== "boolean") return null;
  return { signature, optionIndex, ...(text !== undefined ? { text } : {}), ...(confirm ? { confirm } : {}) };
}

export const interactionRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/interactions",
    access: "read",
    session: true,
    async handle(ctx, { req, rt }) {
      const interactions = await ctx.interactions.list(rt.name, rt.herdr, rt.engine.current().agents, interactionHints(ctx, rt));
      const body = { interactions };
      const etag = computeEtag(JSON.stringify(body));
      if (notModified(req.headers.get("if-none-match"), etag)) {
        return secure(new Response(null, { status: 304, headers: { etag, "cache-control": "private, no-cache" } }));
      }
      const response = json(body, req.headers.get("accept-encoding"));
      response.headers.set("etag", etag);
      response.headers.set("cache-control", "private, no-cache");
      return response;
    },
  },
  {
    method: "POST",
    path: /^\/api\/interactions\/([^/]+)\/answer$/,
    access: "write",
    session: true,
    async handle(ctx, { req, rt, match }) {
      const ae = req.headers.get("accept-encoding");
      const paneId = decodeURIComponent(match![1]!);
      const pane = rt.engine.current().agents.find((a) => a.paneId === paneId);
      if (!pane) return jsonError("unknown pane", 404, ae);
      const body = parseAnswer(await req.json().catch(() => null));
      if (!body) return jsonError("bad answer", 400, ae);
      const run = await ctx.input.run(rt.name, paneId, () => ctx.interactions.answer(rt.name, rt.herdr, pane, body));
      if (run.busy) return json({ ok: false, error: "A saved message is being delivered. Wait before answering." }, ae, 409);
      const { status, outcome, keys } = run.value;
      ctx.audit.record({
        action: "answer",
        paneId,
        session: rt.name,
        device: deviceAuth(req, ctx.cfg).device,
        detail: { optionIndex: body.optionIndex, ok: outcome.ok, ...(keys ? { keys } : {}), ...(outcome.ok ? {} : { code: outcome.code ?? "error" }) },
      });
      if (outcome.ok) ctx.activity.noteSeen(rt.name, paneId);
      return json(outcome, ae, status);
    },
  },
];

/** No `/api/pane/:id/<action>` of its own: answers live under /api/interactions. */
export const interactionPaneActions: Record<string, PaneAction> = {};
