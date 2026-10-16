import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useRouteLoaderData } from "react-router";

import { AppHeader } from "@/components/app-header";
import { PageBody } from "@/components/column-page";
import { AccountList, BreakdownCard, LimitsCard, Stats, WeeksCard } from "@/components/usage-cards";
import { ActivityCard } from "@/components/usage-map";
import { Button, buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Activity, ChevronRight, ChevronsUpDown, Info, Layers, Pending, RefreshCw, SearchX } from "@/components/ui/icon";
import { useMediaQuery } from "@/hooks/use-media-query";
import { getUsage } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { concerns, onLiveEvent } from "@/lib/live-events";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { settingsPath } from "@/lib/nav";
import type { UsageOn, UsageResponse } from "@/lib/types";
import { AGENT_DOT, buildMap, limitBlocks, monthName } from "@/lib/usage-view";
import { cn } from "@/lib/utils";
import "./usage.css";

/**
 * Settings → Usage: what Claude Code and Codex spent, in tokens and at API list price, from their own
 * logs (bridge/usage/, ADR 0085). Read once when the page opens, which lets the bridge catch up on new
 * log lines, and again only when the bridge's `usage` event says a scan moved on or ended, or on a
 * refresh: no poll, no timer. Off, empty and first-pass are states of the page, not errors.
 */
export function UsageRoute() {
  // SAFETY: this route is a child of the root route, whose loader returns HomeData (router.tsx).
  const root = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  const desk = useMediaQuery("(min-width: 1024px)");
  const [account, setAccount] = useState<string>();
  const [read, setRead] = useState<{ data?: UsageResponse; error?: boolean }>({});
  const load = useRef<(fresh?: boolean) => void>(() => {});

  useEffect(() => {
    let alive = true;
    let latest = 0;
    load.current = (fresh) => {
      const n = ++latest;
      getUsage(account, fresh).then(
        (data) => { if (alive && n === latest) setRead({ data }); },
        () => { if (alive && n === latest) setRead((r) => ({ ...r, error: true })); },
      );
    };
    load.current();
    const stop = onLiveEvent((event) => { if (concerns(event, "usage")) load.current(); });
    return () => {
      alive = false;
      stop();
    };
  }, [account]);

  const data = read.data;
  const scanning = data?.on && data.scan.state === "scanning";
  const refresh = (
    <button type="button" aria-label="Recalculate" disabled={Boolean(scanning)} onClick={() => load.current(true)}
      className={cn("grid place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60", desk ? "size-8" : "size-11")}>
      {scanning ? <Pending aria-hidden="true" className="size-4" /> : <RefreshCw aria-hidden="true" className={desk ? "size-4" : "size-5"} />}
    </button>
  );
  // A desk has no back control, so its title is the way up: Settings › Usage.
  const title = desk
    ? <span className="flex items-center gap-2.5"><Link to={settingsPath(root.session)} className="font-medium text-muted-foreground hover:text-foreground">Settings</Link><ChevronRight aria-hidden="true" className="size-3.5 text-subtle-foreground" />Usage</span>
    : "Usage";

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <AppHeader bridge={root.bridge} error={root.error} title={title} back={{ to: settingsPath(root.session), label: "Settings" }}
        rightTrail={!desk && data?.on && !data.scan.firstPass ? refresh : undefined} />
      <PageBody columnClassName="usage-column flex flex-col gap-4">
        {!data
          ? read.error && <EmptyState icon={SearchX} title="Couldn’t read usage" action={<Button size="lg" onClick={() => load.current()}>Try again</Button>} />
          : !data.on
            ? <Off session={root.session} />
            : data.scan.firstPass
              ? <FirstPass data={data} />
              : !data.days.length && !data.coverage.logsFrom
                ? <NoData />
                : <Usage data={data} desk={desk} account={account} onAccount={setAccount} refresh={refresh} />}
      </PageBody>
    </div>
  );
}

function Off({ session }: { session?: string }) {
  return (
    <div className="usage-narrow rounded-xl border bg-card">
      <EmptyState icon={Activity} title="Usage is off" className="py-8"
        action={<Link to={settingsPath(session)} className={buttonVariants({ size: "lg" })}>Turn on in Settings</Link>}>
        Turn it on to see tokens, API-equivalent cost and plan limits from this machine&rsquo;s Claude Code and Codex logs.
      </EmptyState>
    </div>
  );
}

function NoData() {
  return (
    <div className="usage-narrow rounded-xl border bg-card">
      <EmptyState icon={SearchX} title="No usage yet" className="py-8">
        No Claude Code transcripts or Codex sessions on this machine. Start an agent and it shows up here.
      </EmptyState>
    </div>
  );
}

const gb = (bytes: number) => `${Math.round(bytes / 1e8) / 10}`;

function FirstPass({ data }: { data: UsageOn }) {
  const { files = 0, totalFiles = 0, bytes = 0, totalBytes = 0, error } = data.scan;
  const pct = totalBytes ? Math.round((bytes / totalBytes) * 100) : 0;
  return (
    <section aria-label="First pass" className="usage-narrow flex flex-col gap-3 rounded-xl border bg-card p-5">
      <h2 className="flex items-center gap-2.5 text-subhead font-semibold">
        <Pending aria-hidden="true" className="size-5 text-primary" />Reading logs for the first time
      </h2>
      <div role="progressbar" aria-label="Logs read" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex justify-between text-footnote text-muted-foreground tabular-nums">
        <span>{totalFiles ? `${files.toLocaleString("en-US")} of ${totalFiles.toLocaleString("en-US")} files` : "Finding logs…"}</span>
        {totalBytes > 0 && <span>{gb(bytes)} of {gb(totalBytes)} GB</span>}
      </div>
      <p className={cn("text-footnote", error ? "text-destructive" : "text-subtle-foreground")}>
        {error ? `The scan stopped: ${error}` : "After this, Nenu reads only new lines."}
      </p>
    </section>
  );
}

function Usage({ data, desk, account, onAccount, refresh }: {
  data: UsageOn;
  desk: boolean;
  account: string | undefined;
  onAccount: (id: string | undefined) => void;
  refresh: ReactNode;
}) {
  const model = useMemo(() => buildMap(data), [data]);
  const [picking, setPicking] = useState(false);
  const limits = limitBlocks(data, account, Date.now());
  const month = data.periods.find((p) => p.key === "month");
  const chosen = account ? data.accounts.find((a) => a.id === account) : undefined;
  // A desk lists the accounts beside the numbers once one is asked for; a phone opens the list in
  // place, under the button. (A sheet would cost the app's first load 140 B: Rolldown splits the
  // chunk presence.ts shares once a lazy page reaches it, measured 2026-10-16.)
  const listed = desk && data.splitByAccount && (picking || account !== undefined);
  const pick = (id: string | undefined) => {
    onAccount(id);
    setPicking(desk && id !== undefined);
  };

  const scope = (
    <div className="flex items-center gap-2">
      {data.splitByAccount && (
        <button type="button" onClick={() => setPicking(desk ? !listed : !picking)} aria-expanded={desk ? listed : picking}
          className={cn("flex items-center gap-1.5 rounded-lg border bg-card pr-2.5 pl-3 text-footnote font-medium", desk ? "h-8" : "h-9")}>
          {chosen ? <span aria-hidden="true" className={cn("size-2 rounded-full", AGENT_DOT[chosen.agent])} /> : <Layers aria-hidden="true" className="size-4 text-muted-foreground" />}
          {chosen?.label ?? "All accounts"}
          <ChevronsUpDown aria-hidden="true" className="size-3.5 text-subtle-foreground" />
        </button>
      )}
      <span className="flex-1" />
      <span className="text-footnote text-subtle-foreground">{data.scan.state === "scanning" ? "Updating…" : data.scan.scannedAt ? `Updated ${timeAgo(data.scan.scannedAt)}` : ""}</span>
      {desk && refresh}
    </div>
  );
  const stats = <Stats periods={data.periods} desk={desk} />;
  const limitsCard = <LimitsCard blocks={limits.blocks} more={limits.more} onMore={() => setPicking(true)} />;
  const activity = <ActivityCard model={model} accounts={data.accounts} title={chosen ? `Activity · ${chosen.label}` : "Activity"} />;
  const note = (
    <p className="flex items-start gap-2 text-footnote text-muted-foreground">
      <Info aria-hidden="true" className="mt-px size-4 shrink-0 text-subtle-foreground" />
      Cost is what these tokens would cost on the API at list price. Claude and ChatGPT plans are flat-rate, so it is not what you pay.
    </p>
  );
  const source = <p className="text-footnote text-muted-foreground">Claude Code accounts follow each recorded switch; Codex sessions record their own account.</p>;
  const accounts = (
    <AccountList accounts={data.accounts} selected={account} check={desk} onSelect={(id) => {
      pick(id);
      if (!desk) setPicking(false);
    }} />
  );

  if (listed) {
    return (
      <div className="usage-accounts">
        <section aria-label="Accounts" className="flex flex-col gap-1.5">
          <h2 className="px-4 text-footnote font-medium text-muted-foreground">{month ? `${monthName(month.from)} by account` : "By account"}</h2>
          {accounts}
          <div className="px-4 pt-1.5">{source}</div>
        </section>
        <div className="flex min-w-0 flex-col gap-4">{scope}{stats}{limitsCard}{activity}</div>
      </div>
    );
  }

  return (
    <>
      {/* One column on a phone, in the order a phone reads it; two on a desk, the numbers on the left (usage.css). */}
      <div className="usage-page">
        <div className="usage-col">
          <div className="usage-at-1 flex flex-col gap-3">
            {scope}
            {picking && <>{accounts}{source}</>}
          </div>
          <div className="usage-at-2">{stats}</div>
          <div className="usage-at-4">{activity}</div>
          <div className="usage-at-5"><WeeksCard weeks={data.weeks} /></div>
        </div>
        <div className="usage-col usage-side">
          <div className="usage-at-3">{limitsCard}</div>
          {month && <div className="usage-at-6"><BreakdownCard month={month} /></div>}
          <div className="usage-at-7">{note}</div>
        </div>
      </div>
    </>
  );
}
