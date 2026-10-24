import { useMemo, useRef, useState } from "react";
import { isRouteErrorResponse, Outlet, useLoaderData, useLocation, useParams, useRouteError, useRouteLoaderData } from "react-router";
import { Check, Copy, RotateCw, WifiOff } from "@/components/ui/icon";

import { usePolling } from "@/hooks/use-polling";
import { useLiveEvents } from "@/hooks/use-live-events";
import { useAppViewport } from "@/hooks/use-app-viewport";
import { usePollBusy } from "@/hooks/use-poll-busy";
import { useAgentTransitions } from "@/hooks/use-transitions";
import { usePushSetup } from "@/hooks/use-push";
import { useCloseStaleNotifications } from "@/hooks/use-close-stale-notifications";
import { useConnectionLost } from "@/hooks/use-connection-lost";
import { useMotionSettle } from "@/lib/motion";
import { useSelfUpdate } from "@/lib/self-update";
import { isConnecting, linkPhrase } from "@/lib/connection";
import { lastLiveAt } from "@/lib/connection-health";
import { BottomTabBar } from "@/components/bottom-tab-bar";
import { PageBody } from "@/components/column-page";
import { ConnectionBanner } from "@/components/connection-banner";
import { UpdateBanner } from "@/components/update-banner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { NewAgentHost } from "@/components/new-agent-sheet";
import { StatusArea } from "@/components/status-area";
import { WorkbenchShell } from "@/components/workbench-shell";
import { FilePreviewProvider } from "@/components/file-preview-provider";
import { homePath } from "@/lib/nav";
import { SESSION_PARAM, normalizeSession, useSession } from "@/lib/session";
import { PANE_ROUTE_ID, type HomeData, type PaneData } from "@/lib/loaders";
import { paneRootsOf } from "@/lib/file-links";
import { buildLabel } from "@/lib/build";
import { cn } from "@/lib/utils";
import { NotFound } from "@/routes/not-found";

/**
 * The "last seen" stamp the ONE connection surface should show — the stamp of the data actually on
 * screen, which is not always the snapshot's.
 *
 * A cold boot straight into a pane re-renders that pane's mirror from the write-through cache, and
 * the two stamps can be hours apart: the operator last opened the pane at 12:05 and left the
 * dashboard polling until 14:32. Dating that 12:05 terminal text "last seen 14:32" is the same
 * dishonesty this whole change removes, one level down — so while a stale mirror is the thing being
 * read, the mirror's own stamp wins, undated included (an undatable mirror says nothing rather than
 * borrowing a number that isn't about it).
 *
 * A stale pane with NO text is not a case: nothing old is on screen, so the herd's stamp is the
 * honest one. Live pane data likewise falls through — the pane is current, and the banner is then
 * describing whatever the snapshot is doing.
 *
 * A herd with no stamp of its own while the link is down came from this page's own reads (Herdr down
 * still answers with the last herd the bridge saw), so it is dated by `liveAt`, the last read on this
 * page that came back live. That stamp is page-wide (any session, snapshot or pane read), so it is an
 * approximation: a session switched to mid-outage, or a page left hidden while the bridge kept polling,
 * can be dated off by that gap. A page that never had a live read dates nothing.
 */
export function shownLastSeenAt(home: HomeData, pane: PaneData | undefined, liveAt?: number): number | undefined {
  if (pane?.error && pane.text) return pane.lastSeenAt;
  return home.lastSeenAt ?? (isConnecting(home) ? liveAt : undefined);
}

// The data root: owns the snapshot loader, drives polling, and fans the herd out to the child
// routes (home + pane detail) via the router's loader data. Mounted only while unlocked (the
// idle-lock in App swaps the whole RouterProvider out), so polling pauses when the app is locked.
export function RootLayout() {
  useAppViewport();
  useSelfUpdate();
  useMotionSettle();
  // SAFETY: this component IS the element of the route whose `loader` is rootLoader (router.tsx pairs
  // the two), and it renders only after that loader settles — so useLoaderData returns its HomeData.
  const data = useLoaderData() as HomeData;
  // useParams accumulates params from matched child routes, so `paneId` is set when the
  // `/pane/:paneId` child is active. useAgentTransitions uses it to suppress a notification for the
  // pane you're already looking at.
  const { paneId } = useParams();
  // The active pane's loader data, or undefined when a pane isn't the active route — the router
  // already carries both stamps, so dating the bar by what's on screen needs no store of its own.
  // SAFETY: PANE_ROUTE_ID names the route whose `loader` is paneLoader (router.tsx pairs the two),
  // so the only value that can appear under that id is the PaneData that loader returned.
  const pane = useRouteLoaderData(PANE_ROUTE_ID) as PaneData | undefined;
  const paneRoots = useMemo(() => paneRootsOf(data), [data.agents, data.shellPanes]);

  // One live-events stream per page: herd/queue/transcript changes arrive as they happen, and
  // polling relaxes to a fallback while it is open (lib/live-events.ts).
  useLiveEvents(data.session);
  usePolling(data, paneId);
  // Surface the busy bar when a navigation or a poll runs slow, each against its own threshold —
  // routine fast polls/navigations stay invisible. Mounted here so the whole app shares one
  // detector inside the router context.
  usePollBusy();
  useAgentTransitions(data.agents, paneId ?? null, data.session);
  usePushSetup();
  useCloseStaleNotifications(data.agents, paneId ?? null);

  // A viewport-height flex column: the top banners (when shown) are in-flow rows at the top and the
  // active route fills the rest (each route root is `min-h-0 flex-1`). This is what keeps a banner
  // from covering the route's sticky header — it reserves real space instead of overlaying.
  return (
    <div className="app-viewport flex flex-col">
      <ConnectionBanner
        bridge={data.bridge}
        error={data.error}
        authError={data.authError}
        lastSeenAt={shownLastSeenAt(data, pane, lastLiveAt())}
      />
      <UpdateBanner />
      <WorkbenchShell data={data}><FilePreviewProvider key={`${paneId}:${data.session}`} paneId={paneId} session={data.session} panes={paneRoots}><Outlet /></FilePreviewProvider></WorkbenchShell>
      <NewAgentHost />
      <StatusArea />
    </div>
  );
}

// Shown once, on the very first load, while the snapshot loader resolves (SPA hydration). This is the
// router's HydrateFallback, so it stays mounted until the FIRST loader run settles. It draws the app's
// own frame (sidebar, header, tab bar) with placeholder rows, so the app lands without a jump, and it
// names the host it is reaching rather than promising a herd it has not seen.
//
// Over a dead tailnet that initial fetch can hang well past its timeout (or forever on a WebView
// without AbortSignal.timeout). So once stuck here for CONNECTION_LOST_MS (the same wall-clock
// threshold as the in-app notice; `connecting` is trivially true while mounted) the body says it
// cannot reach the host and offers Retry, which reloads: a full reload clears most transient failures.
export function BootSplash() {
  const stuck = useConnectionLost(true);
  const { pathname } = useLocation();
  const session = useSession();
  return (
    <div className="app-viewport flex flex-col">
      <div className="workbench-shell">
        <aside className="workbench-sidebar" aria-hidden="true">
          <div className="workbench-brand-row">
            <span className="workbench-brand"><img src="/nenu-mark.png" alt="" width="22" height="22" className="nenu-mark" /><span>Nenu</span></span>
          </div>
          <div className="nav-top">{[64, 52, 72, 44].map((width) => <Bone key={width} className="my-2 ml-2.5 h-3.5" width={`${width}%`} />)}</div>
        </aside>
        <div className="workbench-main">
          <header className="workbench-app-header flex shrink-0 items-center border-b border-border/60" aria-hidden="true">
            <span className="grid size-11 shrink-0 place-items-center lg:hidden"><img src="/nenu-mark.png" alt="" className="nenu-mark size-6" /></span>
            <Bone className="h-4" width="120px" />
          </header>
          <PageBody>
            {stuck ? (
              <EmptyState icon={WifiOff} title={linkPhrase("nenu", window.location.host)} titleAs="h1"
                action={<Button size="lg" onClick={() => window.location.reload()}>Retry</Button>}>
                Nenu keeps trying. Check that this device can reach the host.
              </EmptyState>
            ) : (
              <>
                <p role="status" className="text-footnote text-muted-foreground">Connecting to {window.location.host}&hellip;</p>
                <div className="mt-4 flex flex-col gap-3" aria-hidden="true">
                  {[0, 1, 2].map((row) => <Bone key={row} className="h-14 rounded-lg" />)}
                </div>
              </>
            )}
          </PageBody>
          {/* The app's own tab bar, so it does not change on hand-off; inert until there is a herd to open. */}
          <div inert className="contents">
            <BottomTabBar active={pathname === "/" ? "home" : null} homeTo={homePath(session)} attention={0} onSearch={noop} />
          </div>
        </div>
      </div>
    </div>
  );
}

const noop = () => {};

/** A placeholder bar. Still under reduced motion; the caption beside it is the live signal. */
function Bone({ className, width }: { className?: string; width?: string }) {
  return <span className={cn("block rounded-md bg-muted", className)} style={width ? { width } : undefined} />;
}

// Last-resort recovery screen for a render-phase error or a loader throw. A 404 is not a crash: it
// gets the not-found screen. Anything else says plainly that Nenu, not the operator, hit a problem,
// keeps the raw exception behind a disclosure (it means nothing to the operator and everything to a
// bug report), and reloads Home, which re-runs the loaders from scratch and clears most failures.
export function RootError() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) {
    return <main className="flex min-h-[100dvh] flex-col justify-center"><NotFound titleAs="h1" /></main>;
  }
  return <Crash error={error} />;
}

function Crash({ error }: { error: unknown }) {
  const [copied, setCopied] = useState(false);
  const disclosure = useRef<HTMLDetailsElement>(null);
  const message = error instanceof Error ? error.message
    : isRouteErrorResponse(error) ? `${error.status} ${error.statusText}`.trim() : String(error ?? "Unknown error");
  // A V8 stack already starts with the message; print it once.
  const stack = error instanceof Error ? error.stack : undefined;
  const trace = stack?.includes(message) ? stack : [message, stack].filter(Boolean).join("\n\n");
  const details = [trace, `Build ${buildLabel()}`, `Path ${window.location.pathname}`].join("\n\n");
  async function copy() {
    try {
      await navigator.clipboard.writeText(details);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Blocked (plain HTTP, permission denied): show the trace so it can be selected by hand.
      if (disclosure.current) disclosure.current.open = true;
    }
  }
  return (
    <main className="flex min-h-[100dvh] flex-col justify-center">
      {/* The one screen without the app's chrome, so the mark says whose it is. */}
      <EmptyState icon={<img src="/nenu-mark.png" alt="" className="nenu-mark size-12" />} title="Nenu hit a problem" titleAs="h1" className="pb-0"
        action={<div className="flex flex-wrap justify-center gap-3">
          <Button size="lg" onClick={() => {
            // Reload home, but stay in the session you were in (read from the live URL, since the
            // router context may be the throwing one). Primary → plain "/".
            const session = normalizeSession(new URLSearchParams(window.location.search).get(SESSION_PARAM));
            window.location.assign(homePath(session));
          }}>
            <RotateCw aria-hidden="true" />Reload
          </Button>
          <Button size="lg" variant="outline" onClick={() => void copy()}>
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{copied ? "Copied" : "Copy details"}
          </Button>
        </div>}>
        Reply drafts stay saved on this device. Reload to try again.
      </EmptyState>
      <details ref={disclosure} className="mx-auto mt-8 mb-12 w-full max-w-md px-6 text-left">
        <summary className="mx-auto w-fit cursor-pointer rounded-md px-2 py-1 text-footnote text-muted-foreground coarse:min-h-11 coarse:content-center">Technical details</summary>
        <pre className="mt-3 max-h-60 overflow-auto rounded-lg border border-border bg-muted p-3 font-mono text-footnote whitespace-pre-wrap break-words text-muted-foreground">{details}</pre>
      </details>
    </main>
  );
}
