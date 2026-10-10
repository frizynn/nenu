import type { NotifyPrefs } from "../notify-prefs.ts";
import type { PushSubscription } from "../push.ts";
import { herdTagFor } from "../sessions.ts";
import type { BridgeConfig } from "../types.ts";
import type { Route } from "./context.ts";
import { buildId, json, secure, text } from "./http.ts";

// ── Misc API: bridge config, push, notification preferences, update checks ──
export const settingsRoutes: Route[] = [
  {
    method: "*",
    path: "/api/config",
    // Read-level, like the other non-terminal endpoints. Nothing Nenu puts here is a
    // credential — the VAPID public key is handed to every browser by design — but the payload
    // is no longer entirely Nenu's: operatorCommands is operator-authored text, and any read
    // client sees it verbatim (`.env.example` says so where it is set).
    // It was also the one route that skipped checkAccess entirely, so COLLIE_PUBLIC_HOSTS
    // didn't cover it and a rebound DNS name could read it. The client only ever calls this
    // same-origin, and a refusal can't be mistaken for an outage: ConnectionBanner
    // short-circuits to AuthErrorBanner before its red-state probe runs. Noted in #32.
    access: "read",
    session: false,
    async handle({ push, operatorCommands, operatorKeys, operatorQuickReplies }, { req }) {
      // Re-read per request behind an mtime check, like buildId() — editing commands.toml is live,
      // with no restart. The path is cfg's, never the request's.
      const mine = await operatorCommands();
      const myKeys = await operatorKeys();
      const myReplies = await operatorQuickReplies();
      return json({
        push: push.enabled,
        vapidPublicKey: push.publicKey,
        build: await buildId(),
        // Omitted entirely when there are none, so an operator who never wrote a commands.toml
        // ships the same payload as before.
        ...(mine.length > 0 ? { operatorCommands: mine } : {}),
        // Same omit-when-empty rule: an operator with no keys.toml ships the payload they had.
        ...(myKeys.length > 0 ? { operatorKeys: myKeys } : {}),
        // And once more for quick-replies.toml.
        ...(myReplies.length > 0 ? { operatorQuickReplies: myReplies } : {}),
      } satisfies BridgeConfig, req.headers.get("accept-encoding"));
    },
  },
  {
    method: "POST",
    path: "/api/subscribe",
    // Read-level: registering for push isn't terminal-driving, so a read-only device may still
    // subscribe to notifications.
    access: "read",
    session: false,
    async handle({ push }, { req }) {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return text("bad subscription", 400);
      }
      if (!isPushSubscription(body)) return text("bad subscription", 400);
      await push.addSubscription(body, {
        replaces: supersededEndpoint(body),
        userAgent: req.headers.get("user-agent") ?? undefined,
      });
      return secure(new Response(null, { status: 204 }));
    },
  },
  {
    method: "POST",
    path: "/api/notifications/snooze",
    // Managing your own notification quiet-hours isn't terminal-driving — read-level, like subscribe.
    access: "read",
    session: false,
    async handle({ push, registry, snooze }, { req }) {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return text("bad request", 400);
      }
      const until = (body as { snoozedUntil?: unknown }).snoozedUntil;
      if (until !== null && typeof until !== "number") return text("bad snoozedUntil", 400);
      await snooze.set(until);
      // Snoozing should also clear whatever's already on the lock screen — across every session,
      // since snooze is bridge-wide. Each session owns its own notification slot (tag).
      if (snooze.isMuted()) {
        for (const rt of registry.all()) {
          void push.send({ type: "clear", tag: herdTagFor(rt.isPrimary, rt.name) });
        }
      }
      return json({ snoozedUntil: snooze.until() }, req.headers.get("accept-encoding"));
    },
  },
  // Which agent statuses push (bridge-wide). Read-level like snooze — managing your own
  // notification preferences isn't terminal-driving.
  {
    method: "GET",
    path: "/api/notifications/prefs",
    access: "read",
    session: false,
    handle: ({ notifyPrefs }, { req }) => json(notifyPrefs.current(), req.headers.get("accept-encoding")),
  },
  {
    method: "POST",
    path: "/api/notifications/prefs",
    access: "read",
    session: false,
    async handle({ notifyPrefs, registry }, { req }) {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return text("bad request", 400);
      }
      const patch = parseNotifyPrefsPatch(body);
      if (!patch) return text("bad prefs", 400);
      const updated = await notifyPrefs.set(patch);
      // Prefs may have just disabled a kind — retract any pending/outstanding alerts of it, in
      // every live session (prefs are bridge-wide; each session has its own coordinator).
      for (const rt of registry.all()) rt.notifications.applyPrefs();
      return json(updated, req.headers.get("accept-encoding"));
    },
  },
  { method: "*", path: "/api/notifications/prefs", access: "none", session: false, handle: () => text("method not allowed", 405) },
  {
    method: "POST",
    path: "/api/update/check",
    // Force an immediate upstream check (the "check for updates" button), instead of waiting for
    // the periodic timer. Read-level — checking a version isn't terminal-driving — and idempotent
    // (the monitor de-dupes concurrent checks). Returns the fresh status the client revalidates on.
    access: "read",
    session: false,
    async handle({ updateMonitor }, { req }) {
      await updateMonitor.checkRelease();
      return json(updateMonitor.status(), req.headers.get("accept-encoding"));
    },
  },
];

/**
 * Validate an untrusted /api/notifications/prefs body into a partial patch. Only the known keys are
 * considered and each, if present, must be a boolean — a non-boolean value is rejected (null return
 * → 400). Unknown keys are ignored. An empty patch is valid (a no-op that echoes current prefs).
 * Pure + exported so the validation is unit-testable without Bun.serve.
 */
export function parseNotifyPrefsPatch(v: unknown): Partial<NotifyPrefs> | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const patch: Partial<NotifyPrefs> = {};
  for (const key of ["blocked", "done", "updates"] as const) {
    if (!(key in o)) continue;
    if (typeof o[key] !== "boolean") return null;
    patch[key] = o[key] as boolean;
  }
  return patch;
}

// Shape-check an untrusted /api/subscribe body before persisting it (a malformed sub would be
// stored keyed on `undefined` and silently never fire).
function isPushSubscription(v: unknown): v is PushSubscription {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  const keys = o.keys as Record<string, unknown> | undefined;
  return (
    typeof o.endpoint === "string" &&
    typeof keys === "object" &&
    keys !== null &&
    typeof keys.p256dh === "string" &&
    typeof keys.auth === "string"
  );
}

/**
 * The endpoint a subscribe body says it supersedes (`replaces`) — the row the same device last
 * registered, which nothing else can identify (bridge/push.ts, SubscriptionMeta).
 *
 * A bad value is IGNORED rather than rejected: the subscription itself is well-formed and must be
 * stored, and a client that got this field wrong would otherwise lose push entirely over a
 * housekeeping hint. The cap is only there so a junk field can't be persisted at length.
 */
function supersededEndpoint(body: unknown): string | undefined {
  const replaces = (body as { replaces?: unknown }).replaces;
  if (typeof replaces !== "string" || replaces === "" || replaces.length > 2048) return undefined;
  return replaces;
}
