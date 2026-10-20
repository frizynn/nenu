import { useContext } from "react";
import { useRouteLoaderData } from "react-router";
import { ChatsCircle, Wifi } from "@/components/ui/icon";

import { ColumnPage } from "@/components/column-page";
import { EmptyState } from "@/components/ui/empty-state";
import { MachinesSlot } from "@/components/machines-slot";
import { HomeProjects } from "@/components/home-projects";
import { HomeHeading, HomeSessions, HomeStarters, RunningWorkCard, useOpeningPath } from "@/components/home-panels";
import { openNewDialog } from "@/components/new-agent-sheet";
import { NeedsYouList } from "@/components/needs-you-list";
import { lockReasonOf } from "@/components/question-card";
import { PullRequestList, useHomeActivity } from "@/components/ready-to-review-list";
import { useConnectionLost } from "@/hooks/use-connection-lost";
import { useInteractions } from "@/hooks/use-interactions";
import { isConnecting } from "@/lib/connection";
import { greeting, homeHeadline, idleAgents, needsYouItems, recentChats, reviewQueue, runningWorkflows, workspaceChats } from "@/lib/home-stats";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { openNewAgent } from "@/lib/spawn";
import { isReadOnly } from "@/lib/types";
import { cn } from "@/lib/utils";
import { WorkbenchNavigationContext } from "@/lib/workbench-navigation";

// Home answers "what needs me now", top to bottom: one sentence saying what needs you, those asks
// (answered in place), then one list of every session that reads as Recents or by Workspace, each row
// carrying its pull request, with every pull request (ready to merge first) as that list's PRs tab,
// and the workflows still running. Above that list, every project with what waits on you there, what
// works, what is ready to review and when it last moved. Starting something is New's; writing to a
// coordinator is its own chat's. Figures come from the snapshot, the bridge's
// detected dialogs and the Claude sessions' background work; nothing here is stored history.
//
// When the link fails, the connection banner (root.tsx) is the one place that names the problem and
// dates the herd. Home keeps saying what the work is: a brief failure changes nothing on screen (the
// quiet retry), and a sustained one or a refusal greys the lists out so nothing reads live. A first
// load that never reached Nenu has no herd to show, so the body only says what will be here.
export function HomeRoute() {
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  const navigation = useContext(WorkbenchNavigationContext);
  const now = Date.now();
  const live = !data.error && data.bridge === "connected";
  // Why answering is paused, if it is.
  const lock = lockReasonOf({ ...data, readOnly: isReadOnly(data.device) });
  const interactions = useInteractions(data.session, live);
  const activity = useHomeActivity(live ? data.agents : [], data.session);
  const lost = useConnectionLost(isConnecting(data));
  const opening = useOpeningPath();
  // The herd on screen is not live: a refusal at once, an outage once it is sustained.
  const stale = data.authError || lost;
  // `bridge` is only unknown when no snapshot was ever read: there is no herd to grey out.
  if (data.bridge === undefined) {
    return <ColumnPage data={data} title="Home">
      <h1 className="sr-only">Home</h1>
      <HomeWithoutHerd refused={data.authError} lost={lost} />
    </ColumnPage>;
  }

  const byPane = new Map(data.agents.map((agent) => [agent.paneId, agent]));
  const panes = [...data.agents, ...data.shellPanes];
  const receipts = interactions.receipts.filter((receipt) => byPane.has(receipt.paneId));
  // A pane just answered may still read blocked until the next snapshot: its receipt is its row meanwhile.
  const answered = new Set(receipts.map((receipt) => receipt.paneId));
  const needs = needsYouItems(data.agents, interactions.interactions, data.projects).filter((item) => item.interaction || !answered.has(item.paneId));
  // "Nothing needs you" only from a live herd whose dialogs were read; anything older cannot vouch for it.
  const calm = live && interactions.loaded && !interactions.stale && data.agents.length > 0 && !needs.length && !receipts.length;
  const reviews = reviewQueue(data.projects, data.pullRequests);
  // A pane Needs you holds (asking, or just answered) stays out of Recents.
  const recent = recentChats(panes, data.projects, new Set([...needs, ...receipts].map((item) => item.paneId)), reviews);
  const running = runningWorkflows(activity);
  const counts = { needs: needs.length, review: reviews.length, working: data.agents.filter((a) => a.status === "working").length, idle: idleAgents(data.agents, needs, reviews) };
  const { title, detail } = homeHeadline(counts, data.agents.length, calm);

  // On a phone the date sits right under the header, so the first screen holds more of the list.
  return <ColumnPage data={data} title="Home" bodyClassName="max-sm:pt-2">
    <div className="flex flex-col gap-6 lg:gap-7">
      <div className="flex flex-col gap-1">
        <p className="text-footnote text-muted-foreground">
          {new Date(now).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" })}
          <span className="max-sm:hidden"> · {greeting(now).toLowerCase()}</span>
        </p>
        <h1 className={cn("text-large-title text-balance lg:text-title", stale && "text-muted-foreground")}>{title}</h1>
        {detail && <p className="text-subhead text-muted-foreground tabular-nums">{detail}</p>}
      </div>
      {live && !data.agents.length && <HomeStarters disabled={!navigation?.onNewChat} onFolder={() => openNewAgent({ kind: "workspace" })} onMore={() => openNewDialog()} />}
      {/* The herd as last seen: greyed so nothing reads live, text kept at full contrast. */}
      <div className={cn("flex flex-col gap-6 lg:gap-7", stale && "text-muted-foreground grayscale")}>
        <NeedsYouList agents={data.agents} projects={data.projects} session={data.session} items={needs} receipts={receipts}
          interactions={interactions} lockReason={lock} opening={opening} />
        <HomeProjects projects={data.projects ?? []} agents={data.agents} session={data.session} now={now} />
        <HomeSessions recent={recent} workspaces={workspaceChats(data, data.projects, reviews)} reviews={reviews}
          pullRequests={(entries) => <PullRequestList entries={entries} session={data.session} opening={opening} />}
          projects={data.projects ?? []} session={data.session} now={now} opening={opening} />
        <MachinesSlot data={data} place="home" />
        {running.length > 0 && (
          <section aria-labelledby="home-running" className="flex flex-col gap-2.5">
            <HomeHeading id="home-running" label="Running in background" count={running.length} />
            <div className="grid gap-3 sm:grid-cols-2">
              {running.map(({ paneId, workflow }) => <RunningWorkCard key={`${paneId}:${workflow.runId}`} paneId={paneId} workflow={workflow} agent={byPane.get(paneId)} session={data.session} now={now} opening={opening} />)}
            </div>
          </section>
        )}
      </div>
    </div>
  </ColumnPage>;
}

/**
 * Home before any herd was read. While the first reads retry quietly it says it is connecting; once
 * the banner names an outage or a refusal, and holds its Retry or Sign in, the body says what will be
 * here and, for an outage, what to check, so the problem and its one way out are never stated twice.
 */
function HomeWithoutHerd({ refused, lost }: { refused: boolean; lost: boolean }) {
  if (!refused && !lost) return <EmptyState icon={Wifi} title="Connecting to Nenu…">Looking for Nenu at {window.location.host}.</EmptyState>;
  return (
    <EmptyState icon={ChatsCircle} title="Nothing to show yet">
      Your threads, questions and reviews show up here once {refused ? "you sign in again." : "Nenu answers. Check this device's network or VPN."}
    </EmptyState>
  );
}
