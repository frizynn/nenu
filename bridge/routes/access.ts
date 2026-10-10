import type { Config } from "../config.ts";
import type { DeviceAuth } from "../types.ts";
import { text } from "./http.ts";

// The API's access gates. Every route reaches them through the dispatcher in routes/index.ts, which
// applies each route's declared level before its handler runs.

// Loopback Host/Origin forms (with an optional port). Loopback is always trusted — only tailscaled
// (or a co-located proxy) can reach the bridge's port, so a loopback caller is the on-host operator.
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * Whether a TCP peer address is loopback. Unlike the `Host` header — which the client writes —
 * this comes from the kernel and cannot be forged.
 *
 * Bun gives IPv4 peers as `127.0.0.1` and IPv6 peers as `::1`; a dual-stack listener can also report
 * an IPv4 peer in v4-mapped form (`::ffff:127.0.0.1`). A null/absent address is treated as loopback
 * (the bind gate in config.ts is the primary control).
 */
export function isLoopbackPeer(address: string | null | undefined): boolean {
  if (!address) return true;
  const a = address.trim().toLowerCase();
  if (a === "::1" || a === "0:0:0:0:0:0:0:1") return true;
  const v4 = a.startsWith("::ffff:") ? a.slice(7) : a;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/**
 * Access gate for the API:
 *  - Host allowlist (fail-closed): the request's Host header must be a loopback form, an explicit
 *    COLLIE_PUBLIC_HOSTS entry, a ctl-discovered Tailscale host (COLLIE_TAILSCALE_HOSTS), or the
 *    host of an allowed origin — otherwise rejected, BEFORE any Origin logic. This defeats DNS
 *    rebinding (Host==Origin==evil.example). COLLIE_ALLOW_ANY_HOST=1 is the explicit opt-out.
 *  - Same-origin only (Origin host must equal Host) — defeats cross-site requests/CSRF. Browsers
 *    omit Origin on same-origin GETs (so the snapshot poll passes); they send it on POSTs.
 *    localhost and explicitly-configured origins are also allowed.
 *  - Origin required for writes: a state-changing (`level === "write"`) request with no Origin is
 *    trusted only from loopback (curl on the host). Browsers always send Origin on fetch/SW POSTs,
 *    so a missing Origin on a remote write is a non-browser or Origin-stripped request — reject it.
 *  - Tailscale identity: when a trusted user is configured under `tailscale serve`, the request
 *    must carry a matching `Tailscale-User-Login`. A missing header is rejected too — serve injects
 *    none for tagged nodes. Under COLLIE_SKIP_SERVE=1 or COLLIE_TRUSTED_USER_OPTIONAL=1, only a
 *    mismatch is rejected.
 */
export function checkAccess(
  req: Request,
  cfg: Config,
  level: "read" | "write" = "read",
): { ok: true } | { ok: false; reason: string } {
  const host = req.headers.get("host") ?? "";

  // Host-header allowlist — ALWAYS ON, before the Origin logic, so a rebinding request
  // (Host==Origin==evil) never reaches it. COLLIE_ALLOW_ANY_HOST=1 is the operator's explicit opt-out.
  if (!cfg.allowAnyHost && !isHostAllowed(host, cfg)) {
    return { ok: false, reason: "host not allowed" };
  }

  const origin = req.headers.get("origin");
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {
      return { ok: false, reason: "bad origin" };
    }
    const allowed =
      originHost === host ||
      LOOPBACK_HOST.test(originHost) ||
      cfg.allowedOrigins.includes(origin);
    if (!allowed) return { ok: false, reason: "cross-origin rejected" };
  } else if (level === "write" && !LOOPBACK_HOST.test(host)) {
    // A write with no Origin header from a non-loopback Host isn't a real browser request — refuse.
    return { ok: false, reason: "origin required" };
  }

  if (cfg.trustedUser) {
    const login = req.headers.get("tailscale-user-login");
    if (login) {
      if (login !== cfg.trustedUser) return { ok: false, reason: "identity not trusted" };
    } else if (!cfg.skipServe && !cfg.trustedUserOptional) {
      // Fail closed: `tailscale serve` injects no Tailscale-User-* for TAGGED nodes, so an absent
      // header is not "a loopback caller" — it is any tagged node on the tailnet.
      return { ok: false, reason: "identity required" };
    }
  }
  return { ok: true };
}

/**
 * Whether a Host header is one the bridge will answer to under the fail-closed host allowlist: a
 * loopback form, an explicit COLLIE_PUBLIC_HOSTS entry, a discovered Tailscale host (bare or with
 * port), or the host of a configured allowed origin. Pure + exported for tests.
 */
export function isHostAllowed(host: string, cfg: Config): boolean {
  if (!host) return false;
  if (LOOPBACK_HOST.test(host)) return true;
  if (cfg.publicHosts.includes(host)) return true;
  const bare = host.replace(/:\d+$/, "");
  if (cfg.tailscaleHosts.some((h) => h === host || h === bare)) return true;
  return cfg.allowedOrigins.some((o) => {
    try {
      return new URL(o).host === host;
    } catch {
      return false;
    }
  });
}

/**
 * Combined API gate used by every handler. A request must always pass {@link checkAccess}
 * (same-origin / CSRF + optional Tailscale identity). A `"write"` request — one that types into a
 * terminal or creates panes — must additionally come from an authorised device (see
 * {@link deviceAuth}). Returns a 403 Response to short-circuit on denial, or null to proceed.
 *
 * Exported for tests: {@link deviceAuth} being correct in isolation proves nothing if this wiring
 * regresses, and the write/read asymmetry below is exactly what a device gate stands or falls on.
 */
export function guard(req: Request, cfg: Config, level: "read" | "write"): Response | null {
  const gate = checkAccess(req, cfg, level);
  if (!gate.ok) return text(gate.reason, 403);
  if (level === "write" && !deviceAuth(req, cfg).authorized) {
    return text("device not authorised", 403);
  }
  return null;
}

/**
 * Optional per-device authorisation, layered on top of {@link checkAccess}. Off by default; enabled
 * by setting COLLIE_DEVICE_HEADER to the header a trusted upstream proxy injects, carrying an opaque
 * device identifier. The header is trusted only because the bridge binds loopback behind the proxy,
 * so a direct client can't forge it (the same trust basis as the Tailscale identity header). Matrix:
 *
 *   - feature off (no header configured) → not enforced, fully authorised (today's behaviour).
 *   - header absent                      → read-only, same as an unlisted device. Configuring the
 *                                          header is the operator asserting that the proxy sets it
 *                                          on every request, so a request without one did not come
 *                                          through that proxy and must not drive a terminal.
 *   - header present, value allowlisted  → authorised; the session is attributed to that device.
 *   - header present, value not listed   → read-only. The "unknown" sentinel is never authorised,
 *                                          and an empty allowlist makes every device read-only — a
 *                                          fail-closed default for a security toggle you turned on.
 *
 * "Read-only" is the whole scope of this gate, deliberately: {@link guard} consults it only for
 * `"write"`, so a header-less caller still reads panes. That is the existing design (a read-only
 * device is meant to watch), and this function does not change it. What changes is that a missing
 * header no longer counts as the operator.
 *
 * The absent-header case deliberately has no loopback exemption. It looks like the natural place for
 * one, but every supported front door is a proxy co-located with the bridge (tailscale serve and the
 * documented reverse proxies all connect to 127.0.0.1), so a loopback peer says nothing about
 * whether the caller is the operator on the host or a remote client whose proxy failed to inject the
 * header. Driving a pane from the host is still one flag away: send an allowlisted id yourself.
 */
export function deviceAuth(req: Request, cfg: Config): DeviceAuth {
  if (!cfg.deviceHeader) return { enforced: false, device: null, authorized: true };
  const raw = req.headers.get(cfg.deviceHeader);
  const device = raw?.trim() ? raw.trim() : null;
  if (!device) return { enforced: true, device: null, authorized: false };
  const authorized = device !== "unknown" && cfg.deviceAllowlist.includes(device);
  return { enforced: true, device, authorized };
}
