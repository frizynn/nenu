import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AgentStates } from "./agent-state.ts";
import { ClaudeHooks } from "./claude-hooks.ts";
import { ClaudeTelemetry } from "./claude-telemetry.ts";
import { isLoopbackBindHost, type Config } from "./config.ts";
import { FileGrants } from "./file-open.ts";
import { ConversationService } from "./conversation-service.ts";
import { Interactions } from "./interactions.ts";
import { JournalWatch } from "./journal-watch.ts";
import { NO_MACHINES } from "./machines.ts";
import { describeAlert } from "./alert-detail.ts";
import { AwaitingReplies } from "./awaiting-replies.ts";
import { adapterFor, buildJournalRegistry } from "./journal/registry.ts";
import { TranscriptStore } from "./journal/store.ts";
import { createOperatorCommands } from "./operator-commands.ts";
import { createOperatorKeys } from "./operator-keys.ts";
import { createOperatorQuickReplies } from "./operator-quick-replies.ts";
import { defaultOrgRun } from "./org-cli.ts";
import { PaneWatcher } from "./pane-watcher.ts";
import { PaneWrites } from "./pane-writes.ts";
import { ProjectRegistry } from "./projects.ts";
import { PullRequestRegistry } from "./pull-requests.ts";
import { freshAgentView, QueueService } from "./queue-service.ts";
import { isLoopbackPeer } from "./routes/access.ts";
import type { RequestTimeouts, ServerDeps, Services } from "./routes/context.ts";
import { WEB_DIR, text } from "./routes/http.ts";
import { dispatch } from "./routes/index.ts";
import { interactionHints } from "./routes/interactions.ts";
import { claudeLog, replyPane } from "./routes/reply.ts";
import { Subagents } from "./subagents.ts";
import type { ActionResponse } from "./types.ts";
import { MAX_UPLOAD_BYTES } from "./uploads.ts";
import { WebAssetArchive } from "./web-assets.ts";

// The bridge's composition root: build the process-wide services once, then hand every request to
// the route table (bridge/routes/index.ts). Routes, gates and handlers live under bridge/routes/.

// Seconds a request may stay silent before Bun closes it; above the slowest org CLI budget (90 s).
export const SERVER_IDLE_TIMEOUT_S = 120;

// Hard cap the runtime enforces on ANY request body (Bun.serve maxRequestBodySize). Bigger than the
// upload cap + overhead so the handler's own 413 fires first for honest clients; this cuts off a
// chunked or lying client that never sends an accurate Content-Length.
export const MAX_REQUEST_BODY_BYTES = MAX_UPLOAD_BYTES + 1024 * 1024; // 26 MB

/** Enough of a journal's tail to reach the row that started its last turn. */
const ALERT_JOURNAL_ENTRIES = 40;

export function startServer(opts: ServerDeps) {
  const { cfg, registry, audit, live } = opts;
  const assets = new WebAssetArchive(join(cfg.stateDir, "web-assets"));
  void assets.retain(WEB_DIR).catch((error: unknown) => console.warn("[assets] could not retain current build:", error instanceof Error ? error.message : "unknown error"));
  // One journal registry + store for the process. The store's cache is keyed by absolute path, so
  // sharing it across herdr sessions AND across harnesses is correct — two sessions can front panes
  // whose agents write into the same root. Which harnesses have journals at all is decided in
  // journal/registry.ts, never here.
  const journals = cfg.transcript ? buildJournalRegistry(cfg.journalRoots) : null;
  const transcripts = cfg.transcript ? new TranscriptStore() : null;
  const conversations = new ConversationService(undefined, undefined, join(cfg.stateDir, "conversation-bindings.json"));
  const input = new PaneWrites();
  // Each Claude and Codex pane's turn from the CLI's own files (ADR 0067): followed on every herd
  // change, attached to the snapshot, and read fresh by Stop.
  const agentStates = new AgentStates({
    claudeRoots: cfg.journalRoots.claude,
    codexRoots: cfg.journalRoots.codex,
    live,
    claudeTranscript: async (sessionId) => (journals ? await adapterFor(journals, "claude")?.source.resolve({ kind: "id", value: sessionId }) ?? null : null),
    codexTranscript: async (ref) => (journals ? await adapterFor(journals, "codex")?.source.resolve(ref) ?? null : null),
  });
  const queue = new QueueService(cfg.stateDir, async (session, paneId, fresh) => {
    const rt = registry.get(session);
    if (!rt) return null;
    const snapshot = rt.engine.current();
    let original = snapshot.agents.find(pane => pane.paneId === paneId);
    if (!original) return null;
    if (fresh) {
      const live = await freshAgentView(rt.herdr, original);
      if (!live) return null;
      original = live;
    }
    return { pane: agentStates.attach(session, await conversations.resolve(original, rt.herdr, session)), herdr: rt.herdr, connected: snapshot.bridge === "connected" };
  }, async (row, text, submit, requestId, paste) => {
    const rt = registry.get(row.session);
    if (!rt) return { ok: false, error: "Session unavailable." };
    const response = await replyPane(rt.herdr, cfg, row.paneId, new Request("http://localhost/queue-delivery", { method: "POST", body: JSON.stringify({ text, submit, request_id: requestId, paste }) }), audit, row.device, row.session);
    return await response.json() as ActionResponse;
  }, input, (row) => {
    live.publish({ session: row.session, topic: "queue", paneId: row.paneId });
    if (row.state === "sent") {
      live.publish({ session: row.session, topic: "pane", paneId: row.paneId });
      live.publish({ session: row.session, topic: "journal", paneId: row.paneId });
    }
  }, {
    audit,
    // A queued row is checked against Claude's log after Enter, as a phone send is (ADR 0076).
    log: (session, paneId) => claudeLog(agentStates, journals, session, paneId),
    // The queue shares the routes' store, so its journal reads hit the same cache.
    facts: journals && transcripts
      ? async (pane) => {
          const adapter = pane.agentSession ? adapterFor(journals, pane.agent) : undefined;
          return adapter && pane.agentSession ? await transcripts.facts(adapter, pane.agentSession) : null;
        }
      : null,
  });
  // A herd change can make a waiting pane ready; deliver now instead of on the fallback tick.
  live.subscribe((event) => {
    if (event.topic === "snapshot") {
      const rt = registry.get(event.session);
      if (rt) agentStates.sync(rt.name, rt.herdr, rt.engine.current().agents);
    }
    if (event.topic === "snapshot" || event.topic === "journal") queue.kick();
  });
  // Per-session background notifications live in each session's runtime (built by the factory in
  // index.ts, wired to its StateEngine transitions). The routes only fan preference changes and
  // snooze-clears across every live session's coordinator.
  const services: Services = {
    awaiting: new AwaitingReplies(),
    ...opts,
    assets,
    // One reader per process; it owns the mtime cache that keeps commands.toml off the hot path.
    operatorCommands: createOperatorCommands(cfg.commandsFile),
    // Its sibling, on the same contract: one reader, one mtime cache, keys.toml off the hot path.
    operatorKeys: createOperatorKeys(cfg.keysFile),
    // The third on that contract: the Quick dock's groups, quick-replies.toml off the hot path.
    operatorQuickReplies: createOperatorQuickReplies(cfg.quickRepliesFile),
    journals,
    transcripts,
    claudeTelemetry: new ClaudeTelemetry(cfg.stateDir),
    subagents: new Subagents(cfg.journalRoots, cfg.stateDir),
    conversations,
    input,
    queue,
    projects: new ProjectRegistry({ live }),
    pullRequests: new PullRequestRegistry({ live }),
    orgRun: defaultOrgRun(),
    hasJournal: (agent) => adapterFor(journals ?? {}, agent) !== undefined,
    interactions: new Interactions(live, { waiting: (session, paneId) => agentStates.get(session, paneId)?.waiting !== undefined }),
    paneWatcher: new PaneWatcher(live),
    journalWatch: new JournalWatch(live),
    claudeHooks: new ClaudeHooks(live, (session, paneId) => agentStates.poke(session, paneId)),
    agentStates,
    fileGrants: new FileGrants(),
    machines: opts.machines ?? NO_MACHINES,
  };
  // Cards follow herd and screen changes, so Home and the chat hear `interaction` without polling.
  services.interactions.follow(registry, live, (rt) => interactionHints(services, rt));
  // An agent alert names who it is from the session's projects, and a finished turn reads the pane's
  // journal for what started it and what it answered (alert-detail.ts).
  opts.alerts.use(async (session, agent, status) => {
    const rt = registry.get(session);
    const snap = rt?.engine.current();
    const projects = rt && snap ? services.projects.list(rt.name, rt.isPrimary, [...snap.agents, ...snap.shellPanes]) : [];
    const adapter = status === "done" && agent.agentSession && journals ? adapterFor(journals, agent.agent) : undefined;
    const page = adapter && transcripts && agent.agentSession
      ? await transcripts.page(adapter, agent.agentSession, { limit: ALERT_JOURNAL_ENTRIES }).catch(() => null)
      : null;
    const requested = status === "done" && services.awaiting.take(session, agent.paneId);
    return describeAlert(agent, status, projects, page?.entries ?? null, requested);
  });
  // An agent alert carries the pane's dialog. The alert usually fires before anything read the
  // pane, so the lookup reads it first.
  opts.push.useInteractions(async (session, paneId) => {
    const rt = registry.get(session);
    if (!rt) return null;
    await services.interactions.refresh(rt.name, rt.herdr, rt.engine.current().agents, interactionHints(services, rt), paneId);
    return services.interactions.current(rt.name, paneId);
  });

  const server = Bun.serve({
    hostname: cfg.host,
    port: cfg.port,
    // Runtime cap on any request body — a chunked/lying client is cut off here even if its
    // Content-Length is absent or false. The upload handler still does its own precise check.
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    // Bun's 10 s default would cut `thread merge` (90 s), project create (30 s) and thread set
    // (15 s) while the CLI keeps running, so the phone reports a failure that actually happened.
    // The SSE route still opts out per request with server.timeout(req, 0).
    idleTimeout: SERVER_IDLE_TIMEOUT_S,

    fetch(req): Response | Promise<Response> {
      const peer = server.requestIP(req)?.address;
      if (!cfg.allowNonLoopbackBind && !isLoopbackPeer(peer)) {
        return text("non-loopback peer rejected", 403);
      }
      return dispatch(services, req, server, peer);
    },
  });

  console.log(`[bridge] listening on http://${cfg.host}:${cfg.port}  (poll ${cfg.pollMs}ms)`);
  if (cfg.deviceHeader) {
    console.log(
      `[bridge] per-device auth ON: trusting '${cfg.deviceHeader}', ${cfg.deviceAllowlist.length} device(s) allowlisted`,
    );
  }
  for (const w of startupWarnings(cfg)) console.warn(w);

  // The other machines' door: a Nenu on another machine reaches this one through SSH to this socket
  // (machines.ts) and is answered as the operator, because only this user (or root) can open it, and
  // either can already drive Herdr's own socket. The TCP port's gates are untouched.
  const peer = servePeer(join(cfg.stateDir, "peer.sock"), (req, srv) => dispatch(services, req, srv, undefined, "peer"));
  const stop = server.stop.bind(server);
  Object.defineProperty(server, "stop", { value: (force?: boolean) => { peer?.stop(force); return stop(force); } });

  return server;
}

/**
 * Listen on `path` for other machines' Nenus. The state dir belongs to this install, so a socket left
 * there by a killed bridge is this install's own and is replaced. It is bound 0600, not chmodded after:
 * a socket takes the process umask, connect() needs write on it (Linux, and macOS, measured), and under
 * umask 0 it would be anyone's until the chmod.
 */
export function servePeer(path: string, handle: (req: Request, server: RequestTimeouts) => Response | Promise<Response>): ReturnType<typeof Bun.serve> | null {
  try {
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    rmSync(path, { force: true });
    const options = {
      unix: path,
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      // No idle cut. On a socket listener Bun 1.4 ignores server.timeout(req, 0), so the 10 s default
      // closed every quiet event stream (measured); only this option holds. The one client here is
      // another Nenu, whose connections end with its tunnel.
      idleTimeout: 0,
      fetch: (req: Request): Response | Promise<Response> => handle(req, server),
    };
    const umask = process.umask(0o177);
    let server: ReturnType<typeof Bun.serve>;
    try {
      // Bun's types leave idleTimeout out of a socket listener's options; the runtime honours it.
      server = Bun.serve(options as unknown as Parameters<typeof Bun.serve>[0]);
    } finally {
      process.umask(umask);
    }
    return server;
  } catch (err) {
    console.warn(`[bridge] WARNING: other machines cannot reach this one: ${path}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * The security-posture warnings emitted once at startup, as plain strings (each already prefixed
 * `[bridge] WARNING:`). Pure + exported so the exact set that fires for a given {@link Config} is
 * unit-testable without standing up Bun.serve; the bootstrap in {@link startServer} just logs each
 * via `console.warn`. The identity-gate advice forks on {@link Config.skipServe}: behind a reverse
 * proxy the `Tailscale-User-Login` header is never injected, so trustedUser is inert (nag toward
 * COLLIE_DEVICE_HEADER instead), whereas under `tailscale serve` an empty trustedUser is the open
 * door Variant A closes.
 */
export function startupWarnings(cfg: Config): string[] {
  const warnings: string[] = [];
  if (!isLoopbackBindHost(cfg.host)) {
    warnings.push(
      `[bridge] WARNING: bound to ${cfg.host} via COLLIE_ALLOW_NON_LOOPBACK_BIND — the identity, device and same-origin gates are all client-settable on a wide bind, and the peer-address check is off. Whatever fronts this port is now the only control.`,
    );
  }
  if (cfg.deviceHeader && cfg.deviceAllowlist.length === 0) {
    warnings.push(
      `[bridge] WARNING: COLLIE_DEVICE_HEADER set but COLLIE_DEVICE_ALLOWLIST is empty — every device is read-only`,
    );
  }
  if (cfg.skipServe) {
    // Reverse-proxy mode: no tailscale serve injects Tailscale-User-Login, so checkAccess never has
    // an identity to enforce — trustedUser is dead config. Only nag when it's set (a likely mistake).
    if (cfg.trustedUser) {
      warnings.push(
        `[bridge] WARNING: COLLIE_TRUSTED_USER has no effect under COLLIE_SKIP_SERVE=1 — without tailscale serve in front, the Tailscale-User-Login header is never injected. Use COLLIE_DEVICE_HEADER for per-device auth (see DEPLOYMENT.md → Variant C).`,
      );
    }
  } else if (!cfg.trustedUser) {
    warnings.push(
      `[bridge] WARNING: COLLIE_TRUSTED_USER is empty — any tailnet device/user that reaches the bridge gets full write access. Set it to your tailnet login (see README → Variant A).`,
    );
  } else if (cfg.trustedUserOptional) {
    warnings.push(
      `[bridge] WARNING: COLLIE_TRUSTED_USER_OPTIONAL=1 — a request with no Tailscale-User-Login is accepted, so any TAGGED tailnet node (which serve injects no identity for) gets full write access. Unset it outside host-local development.`,
    );
  }
  if (cfg.allowAnyHost) {
    warnings.push(
      `[bridge] WARNING: COLLIE_ALLOW_ANY_HOST=1 — Host-header validation is OFF, so a DNS-rebound page can reach this bridge as if it were same-origin. Unset it and set COLLIE_PUBLIC_HOSTS to the host(s) you serve on.`,
    );
  } else if (
    cfg.publicHosts.length === 0 &&
    cfg.tailscaleHosts.length === 0 &&
    cfg.allowedOrigins.length === 0
  ) {
    warnings.push(
      `[bridge] WARNING: no non-loopback Host is allowed — every request except one addressed to localhost/127.0.0.1 will be rejected with "host not allowed". Set COLLIE_PUBLIC_HOSTS to the exact host(s) you serve on (required behind your own reverse proxy).`,
    );
  }
  return warnings;
}
