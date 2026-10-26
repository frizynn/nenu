import { launchAgent, startPaneAgent } from "../agent-start.ts";
import type { Config } from "../config.ts";
import type { HerdrClient, PaneRead } from "../herdr-client.ts";
import { JsonBody, notModified, notModifiedResponse, SharedLoads } from "../http-cache.ts";
import { discoverPaneModels, startCatalog } from "../models.ts";
import { discoverPaneSkills } from "../skills.ts";
import { object as record } from "../subagent-files.ts";
import { withWeekly } from "../claude-telemetry.ts";
import type { PaneReadResponse } from "../types.ts";
import type { PaneAction, PaneRouteRequest, Services } from "./context.ts";
import { buildId, json, jsonError, secure, text, withBuildHeader } from "./http.ts";

// Upper bound on the pane-read `lines` param — don't trust the client (or Herdr) to cap it.
export const MAX_READ_LINES = 10_000;

// Concurrent mirror reads of one pane share a single Herdr read (several phones, or a poll racing a
// live event). Only this route: the guarded reply and prompt-select reads go to Herdr directly
// because they need a truly fresh screen.
const mirrorReads = new SharedLoads<JsonBody>();

// The pane's own reads and lifecycle. The `""` action is the bare `/api/pane/:id` mirror read.
export const panePaneActions: Record<string, PaneAction> = {
  "": {
    level: "read",
    marksSeen: false,
    handle({ cfg, conversations, claudeTelemetry, usage }, { req, url, rt, paneId }) {
      const native = async () => {
        const original = cfg.transcript ? rt.engine.current().agents.find(entry => entry.paneId === paneId && entry.agent === "claude") : undefined;
        if (!original) return undefined;
        const pane = await conversations.resolve(original, rt.herdr, rt.name).catch(() => undefined);
        const found = await claudeTelemetry.read(pane).catch(() => undefined);
        if (!found || pane?.agentSession?.kind !== "id") return found;
        // Claude's status line often leaves the weekly window out; the account's last reading fills it,
        // and nothing about that reading may cost the session's own telemetry.
        let weekly;
        try { weekly = usage.claudeWeekly(pane.agentSession.value); } catch { weekly = undefined; }
        return { ...found, telemetry: withWeekly(found.telemetry, weekly) };
      };
      // A shell's start block waits for its prompt: `agent.start` launches nowhere else.
      const shell = rt.engine.current().shellPanes.some(entry => entry.paneId === paneId);
      const prompt = async () => shell ? rt.herdr.processInfo(paneId).then(atShellPrompt, () => undefined) : undefined;
      return readPane(rt.herdr, cfg, paneId, url, req, native, prompt, rt.name);
    },
  },
  start: {
    level: "write",
    marksSeen: true,
    async handle({ cfg, audit }, { req, rt, paneId, device }) {
      const models = await startCatalog(cfg.journalRoots);
      const launch = launchAgent(await req.json().catch(() => null), models);
      if (!launch) return jsonError("Choose Codex or Claude Code, a listed permission level and a listed model.", 400, null);
      try {
        // A pane created a moment ago is not in the cached snapshot yet; refresh once before refusing it.
        const isPane = (p: { paneId: string }) => p.paneId === paneId;
        const shell = rt.engine.current().shellPanes.find(isPane) ?? (await rt.engine.refresh()).shellPanes.find(isPane);
        await startPaneAgent(shell, launch, models, rt.herdr);
        audit.record({ action: "agent.start", paneId, session: rt.name, device, detail: { agent: launch.kind, permission: launch.permission, model: launch.model } });
        return json({ ok: true }, null);
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "Agent startup failed.", 409, null);
      } finally {
        rt.engine.pokeNow();
      }
    },
  },
  conversations: {
    level: "read",
    marksSeen: true,
    async handle({ cfg, conversations }, { rt, paneId }) {
      if (!cfg.transcript) return jsonError("Conversation history is disabled on this bridge.", 409, null);
      const pane = rt.engine.current().agents.find((entry) => entry.paneId === paneId);
      if (!pane) return jsonError("Agent no longer exists.", 409, null);
      try {
        return json({ conversations: await conversations.choices(pane) }, null);
      } catch (err) { return jsonError(err instanceof Error ? err.message : "Could not connect conversation.", 409, null); }
    },
  },
  connect: {
    level: "write",
    marksSeen: true,
    async handle({ cfg, audit, conversations }, { req, rt, paneId, device }) {
      if (!cfg.transcript) return jsonError("Conversation history is disabled on this bridge.", 409, null);
      const pane = rt.engine.current().agents.find((entry) => entry.paneId === paneId);
      if (!pane) return jsonError("Agent no longer exists.", 409, null);
      try {
        const body: unknown = await req.json();
        if (typeof body !== "object" || body === null || !("id" in body) || typeof body.id !== "string")
          return jsonError("Choose a conversation.", 400, null);
        await conversations.attach(pane, body.id, rt.herdr, rt.name);
        rt.engine.pokeNow();
        audit.record({ action: "conversation.connect", paneId, session: rt.name, device });
        return json({ ok: true }, null);
      } catch (err) { return jsonError(err instanceof Error ? err.message : "Could not connect conversation.", 409, null); }
    },
  },
  subagents: {
    level: "read",
    marksSeen: false,
    handle: (ctx, r) => subagentRead(ctx, r, "subagents"),
  },
  "subagent-history": {
    level: "read",
    marksSeen: false,
    handle: (ctx, r) => subagentRead(ctx, r, "subagent-history"),
  },
  models: {
    level: "read",
    marksSeen: false,
    async handle({ cfg, conversations }, { req, rt, paneId }) {
      const snapshot = rt.engine.current();
      const original = snapshot.agents.find((candidate) => candidate.paneId === paneId);
      const pane = original ? await conversations.resolve(original, rt.herdr, rt.name) : undefined;
      return json(pane ? await discoverPaneModels(pane, cfg.journalRoots) : { available: false, models: [] }, req.headers.get("accept-encoding"));
    },
  },
  skills: {
    level: "read",
    marksSeen: false,
    async handle(_ctx, { req, rt, paneId }) {
      const current = rt.engine.current();
      const pane = [...current.agents, ...current.shellPanes].find((entry) => entry.paneId === paneId);
      if (!pane) return json({ paneId, available: false, trigger: null, skills: [], total: 0, truncated: false, reason: "no-pane" }, req.headers.get("accept-encoding"));
      return json(await discoverPaneSkills(pane), req.headers.get("accept-encoding"));
    },
  },
};

async function subagentRead(
  { cfg, conversations, subagents }: Services,
  { req, url, rt, paneId }: PaneRouteRequest,
  action: "subagents" | "subagent-history",
): Promise<Response> {
  if (!cfg.transcript) return action === "subagents" ? json({ available: false, reason: "disabled" }, null) : jsonError("Conversation history is disabled.", 409, null);
  const original = rt.engine.current().agents.find((entry) => entry.paneId === paneId);
  if (!original) return action === "subagents" ? json({ available: false, reason: "no-session" }, null) : jsonError("Session is unavailable.", 404, null);
  try {
    const pane = await conversations.resolve(original, rt.herdr, rt.name);
    const result = action === "subagents" ? await subagents.list(pane) : await subagents.history(pane, url.searchParams.get("id") ?? "");
    return json(result, req.headers.get("accept-encoding"));
  } catch { return jsonError("Could not read subagents for this session.", 503, null); }
}

async function readPane(
  herdr: HerdrClient,
  cfg: Config,
  paneId: string,
  url: URL,
  req: Request,
  native: () => Promise<PaneReadResponse["nativeTelemetry"]>,
  prompt: () => Promise<boolean | undefined>,
  session: string,
): Promise<Response> {
  const linesParam = Number.parseInt(url.searchParams.get("lines") ?? "", 10);
  // Clamp to a sane ceiling — don't trust the client (or Herdr) to bound an enormous read.
  const lines =
    Number.isFinite(linesParam) && linesParam > 0
      ? Math.min(linesParam, MAX_READ_LINES)
      : cfg.readLines;
  try {
    const body = await mirrorReads.get(`${session}\u0000${paneId}\u0000${lines}`, async () => {
      // "ansi" so the client can render a faithful, colored terminal mirror. It is also, as far as we
      // have probed, why this read leaves the operator's terminal alone: a `recent` read only harvests
      // an alt-screen pane — scrolling it up and back — in `text` format. `lines` here is whatever the
      // web app asked for (600 for the history view), well past any pane's height, so switching this
      // to "text" would move someone's screen on every revalidate. See HERDR_API.md → `pane.read`.
      const [read, nativeTelemetry, atPrompt] = await Promise.all([herdr.readPane(paneId, "recent", lines, "ansi"), native(), prompt()]);
      const data = paneReadResponse(paneId, read, atPrompt);
      if (nativeTelemetry) data.nativeTelemetry = nativeTelemetry;
      return new JsonBody(data);
    });
    // ETag is derived from the serialised body — if content hasn't changed the client gets a 304
    // and skips the whole transfer (the big win on a cellular link).
    const etag = body.etag;
    // Tag pane polls too (both the 304 and the full body), so a client that only has a pane open —
    // not the home snapshot — still observes a live rebuild between polls.
    const build = await buildId();
    if (notModified(req.headers.get("if-none-match"), etag)) return withBuildHeader(secure(notModifiedResponse(etag)), build);
    return withBuildHeader(
      secure(body.response(req.headers.get("accept-encoding"), { etag })),
      build,
    );
  } catch (err) {
    return text(`herdr read failed: ${(err as Error).message}`, 502);
  }
}

/**
 * Map a Herdr pane read to the REST response body. Pure + exported so the `revision` passthrough
 * (the client's prompt-select race guard depends on it) is covered by the bridge unit tests without
 * standing up Bun.serve / the socket client.
 */
export function paneReadResponse(paneId: string, read: PaneRead, atPrompt?: boolean): PaneReadResponse {
  return { paneId, text: read.text, truncated: read.truncated, revision: read.revision, ...(atPrompt === undefined ? {} : { atPrompt }) };
}

/**
 * Whether a shell waits at its prompt, from Herdr's `pane.process_info`: the shell's own process group
 * holds the terminal only then (measured on Herdr 0.9.3; a running command's group takes it). Undefined
 * when Herdr names neither, so an older server leaves the start block as it was.
 */
export function atShellPrompt(info: unknown): boolean | undefined {
  const { shell_pid: shell, foreground_process_group_id: group } = record(info);
  const pid = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  return pid(shell) && pid(group) ? shell === group : undefined;
}
