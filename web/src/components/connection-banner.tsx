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
import { setOutageNoticeShown, useOutageNoticeShown } from "@/lib/connection-health";
import { isConnecting, linkPhrase, linkProblemOf } from "@/lib/connection";
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
   * the outage and the refusal copy, where it is the fact the operator most needs: a cold boot with no
   * network or a refused read re-renders the herd from cache, and an undated old screen is
   * indistinguishable from a live one.
   */
  lastSeenAt?: number;
}

// Brief failures retry silently. A sustained outage gets one stable notice; recovery never
// flashes a success banner or invites a reload over an unstable connection.
export const RECOVERY_QUIET_MS = 5_000;

export function ConnectionBanner({ bridge, error, authError, lastSeenAt }: ConnectionBannerProps) {
  if (authError) return <AuthErrorBanner lastSeenAt={lastSeenAt} />;
  return <ConnectionStateBanner bridge={bridge} error={error} lastSeenAt={lastSeenAt} />;
}

// A neutral row in the flow, never over content: up to two lines so the fact the operator needs (what
// is down, and since when) is never cut, and every control 44px on touch.
const BANNER = "flex min-h-11 shrink-0 items-center gap-2 border-b border-border bg-muted py-1 pl-4 pr-2";

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
// an already-signed-in device recovers without leaving the app. The sentence leaves "sign in" to the
// button, so the date still fits the banner's two lines on a phone.
function AuthErrorBanner({ lastSeenAt }: { lastSeenAt?: number }) {
  return (
    <div role="alert" aria-live="polite" className={BANNER}>
      <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-destructive" />
      <p className="min-w-0 flex-1 text-footnote text-muted-foreground text-pretty">
        <span className="font-medium text-foreground">{linkPhrase("refused")}.</span> Not a network problem.<LastSynced at={lastSeenAt} />
      </p>
      <a href={PROXY_AUTH_PATH} className={cn(buttonVariants({ size: "sm" }), "shrink-0 no-underline")}>
        <LogIn aria-hidden="true" className="size-4" />
        Sign in
      </a>
      <Button size="icon" variant="ghost" aria-label="Reload" className="-mr-2 shrink-0 text-muted-foreground"
        onClick={() => window.location.reload()}>
        <RefreshCw aria-hidden="true" className="size-4" />
      </Button>
    </div>
  );
}

function ConnectionStateBanner({ bridge, error, lastSeenAt }: Omit<ConnectionBannerProps, "authError">) {
  const connecting = isConnecting({ bridge, error });
  const lost = useConnectionLost(connecting);
  // Kept in the shared store, so the card and the composer defer to what is on screen.
  const visible = useOutageNoticeShown();
  const [retrying, setRetrying] = useState(false);
  const revalidator = useRevalidator();

  useEffect(() => {
    if (lost) { setOutageNoticeShown(true); return; }
    if (connecting) return;
    // One good response between failures is not stable recovery. Keep the notice until a quiet
    // interval has elapsed so weak signal cannot repeatedly open and close the row.
    const timer = setTimeout(() => setOutageNoticeShown(false), RECOVERY_QUIET_MS);
    return () => clearTimeout(timer);
  }, [lost, connecting]);
  // A notice that leaves the screen (a refusal takes its place, the layout unmounts) shows nothing.
  useEffect(() => () => setOutageNoticeShown(false), []);

  if (!visible) return null;
  // Herdr down is the bridge answering; no snapshot at all means the bridge never has on this page,
  // so there is nothing cached to promise and the host is the useful fact. Once reads answer again the
  // notice waits out the quiet interval saying only what is still true, never "Connected".
  const problem = linkProblemOf({ bridge, error, authError: false });
  const headline = problem ? `${linkPhrase(problem, bridge === undefined ? window.location.host : undefined)}.` : "Connection is unstable.";
  async function retry() {
    setRetrying(true);
    try { await revalidator.revalidate(); } finally { setRetrying(false); }
  }
  return (
    <div role="status" aria-live="polite" className={BANNER}>
      <WifiOff aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 text-footnote text-muted-foreground text-pretty">
        <span className="font-medium text-foreground">{headline}</span>{connecting && " Retrying…"}
        <LastSynced at={lastSeenAt} />
      </p>
      <Button variant="ghost" size="sm" className="shrink-0 gap-1.5" onClick={() => void retry()} disabled={retrying} aria-busy={retrying || undefined}>
        {retrying ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : <RotateCw aria-hidden="true" className="size-4" />}
        Retry
      </Button>
    </div>
  );
}

/** The date of the herd on screen, when it can be dated, after the problem the banner names. */
function LastSynced({ at }: { at: number | undefined }) {
  return at === undefined ? null : <> <span className="whitespace-nowrap">Last synced {clockTime(at)}.</span></>;
}
