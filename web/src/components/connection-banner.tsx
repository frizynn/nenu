import { useEffect, useState } from "react";
import { useRevalidator } from "react-router";
import {
  Loader2,
  LogIn,
  RefreshCw,
  RotateCw,
  TriangleAlert,
  WifiOff,
} from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PROXY_AUTH_PATH } from "@/lib/sw-routes";
import { useConnectionLost } from "@/hooks/use-connection-lost";
import { isConnecting } from "@/lib/connection";
import { clockTime } from "@/lib/format";
import type { BridgeStatus } from "@/lib/types";

interface ConnectionBannerProps {
  /** Herdr link from the last snapshot (undefined before the first successful poll). */
  bridge: BridgeStatus | undefined;
  /** The last snapshot fetch failed (stale data on screen). */
  error: boolean;
  /** The failed snapshot request was rejected with HTTP 401 or 403. */
  authError: boolean;
  /**
   * When the data on screen was last actually fetched, if it can be dated (lib/last-seen.ts). Shown in
   * the RED copy only, where it is the fact the operator most needs: a cold boot with no network
   * re-renders the herd from cache, and an undated old screen is indistinguishable from a live one.
   */
  lastSeenAt?: number;
}

// Brief failures retry silently. A sustained outage gets one stable notice; recovery never
// flashes a success banner or invites a reload over an unstable connection.
export const RECOVERY_QUIET_MS = 5_000;

export function ConnectionBanner({ bridge, error, authError, lastSeenAt }: ConnectionBannerProps) {
  if (authError) return <AuthErrorBanner />;
  return <ConnectionStateBanner bridge={bridge} error={error} lastSeenAt={lastSeenAt} />;
}

// A refusal is not an outage, so it gets its own surface ahead of the connection state machine: no
// probe, no reconnect spinner, no escalation clock. The copy stays deliberately non-specific about
// the cause. The flag covers 401 and 403 alike, and a 403 can equally mean "this device is not
// allowlisted", "host not allowed" or "cross-origin rejected", so naming any one of them would be
// wrong more often than right. What the operator needs here is the one fact the old behaviour hid:
// this is not the network.
//
// Reload alone is NOT enough to reach a fronting proxy, which is what this banner used to claim. In
// an installed PWA the service worker answers every navigation it owns — a reload included — from
// the precached app shell, so a reload re-renders the same refused UI and never touches the proxy.
// "Sign in" is the escape: a real navigation to the one path the SW always passes to the network
// (lib/sw-routes). An <a>, not a button, so it is an ordinary navigation the SW sees as such — and
// so it still works if React is wedged. Reload stays alongside it, since a merely stale session on
// an already-signed-in device recovers without leaving the app.
function AuthErrorBanner() {
  return (
    <div className="grid shrink-0 grid-rows-[1fr] overflow-hidden opacity-100">
      <div className="min-h-0 overflow-hidden">
        <div
          role="alert"
          aria-live="polite"
          className={cn(
            "flex items-center gap-2 border-b px-4 py-1 text-xs",
            "border-status-blocked/40 bg-status-blocked/15",
          )}
        >
          <TriangleAlert className={cn("size-3.5 shrink-0", "text-status-blocked")} />
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">
            Access refused. This is not a connection problem.
          </span>
          <a
            href={PROXY_AUTH_PATH}
            className={cn(
              buttonVariants({ size: "sm" }),
              "h-6 gap-1 px-2 text-xs no-underline",
            )}
          >
            <LogIn className="size-3.5" />
            Sign in
          </a>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Reload"
            className="size-6 text-muted-foreground"
            onClick={() => window.location.reload()}
          >
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function ConnectionStateBanner({ bridge, error, lastSeenAt }: Omit<ConnectionBannerProps, "authError">) {
  const connecting = isConnecting({ bridge, error });
  const lost = useConnectionLost(connecting);
  const [visible, setVisible] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const revalidator = useRevalidator();

  useEffect(() => {
    if (lost) { setVisible(true); return; }
    if (connecting) return;
    // One good response between failures is not stable recovery. Keep the notice until a quiet
    // interval has elapsed so weak signal cannot repeatedly open and close the row.
    const timer = setTimeout(() => setVisible(false), RECOVERY_QUIET_MS);
    return () => clearTimeout(timer);
  }, [lost, connecting]);

  if (!visible) return null;
  const copy = bridge === "disconnected" ? "Herdr is unavailable. Retrying…" : "Connection is unstable. Retrying…";
  async function retry() {
    setRetrying(true);
    try { await revalidator.revalidate(); } finally { setRetrying(false); }
  }
  return (
    <div role="status" aria-live="polite" className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-muted px-3 text-xs text-muted-foreground">
      <WifiOff aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{copy}{lastSeenAt === undefined ? "" : ` Last synced ${clockTime(lastSeenAt)}.`}</span>
      <Button variant="ghost" size="sm" className="min-h-11 shrink-0 gap-1 px-2" onClick={() => void retry()} disabled={retrying}>
        {retrying ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCw className="size-3.5" />}
        Retry
      </Button>
    </div>
  );
}
