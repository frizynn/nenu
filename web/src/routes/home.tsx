import { useContext, useState } from "react";
import { useNavigate, useRouteLoaderData } from "react-router";
import { ArrowUp, Search } from "lucide-react";

import { AppHeader, SettingsGear } from "@/components/app-header";
import { ActivityCard, HerdCard } from "@/components/home-charts";
import { LiveCard, QuickJump } from "@/components/home-panels";
import { ProjectOverview } from "@/components/project-overview";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { ChatBrowser } from "@/components/workbench-sidebar";
import { activityByHour, greeting, herdCounts, herdHeadline } from "@/lib/home-stats";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { projectPath } from "@/lib/nav";
import { openNewAgent } from "@/lib/spawn";
import { WorkbenchNavigationContext } from "@/lib/workbench-navigation";

// Home is the command center: the one fact that matters most, a prompt to start something, then the
// herd at a glance and every live agent, project and chat one tap away. Every figure is read from
// the current snapshot; nothing here is stored history.
export function HomeRoute() {
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  const navigate = useNavigate();
  const navigation = useContext(WorkbenchNavigationContext);
  const [query, setQuery] = useState("");
  const now = Date.now();
  const counts = herdCounts(data.agents);
  const live = !data.error && data.bridge === "connected";
  const notice = data.error ? "Showing your last workspace snapshot. Reconnect to see current activity."
    : data.bridge !== "connected" ? "Waiting for your workspaces to connect."
    : data.agents.length ? null : "Describe a task to start your first agent. You pick the agent and folder next.";

  return <div className="workbench-home flex min-h-0 min-w-0 flex-1 flex-col">
    <AppHeader bridge={data.bridge} error={data.error} rightTrail={<SettingsGear session={data.session} />}>
      <span className="truncate text-sm font-medium">Home</span>
    </AppHeader>
    <ReadOnlyBanner device={data.device} />
    <main className="min-h-0 flex-1 overflow-y-auto px-4 pt-6 pb-[calc(env(safe-area-inset-bottom)+2rem)] sm:px-8 sm:pt-12">
      <div className="mx-auto w-full max-w-5xl">
        <div className="mb-6 max-w-2xl sm:mb-8">
          <p className="text-sm text-muted-foreground">{greeting(now)} · {new Date(now).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-[28px]">{live ? herdHeadline(counts) : "What should we work on?"}</h1>
          {notice && <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{notice}</p>}
          <PromptBox disabled={!navigation?.onNewChat} />
        </div>

        {/* The herd as Herdr holds it, switchable to projects or recency like the navigation. */}
        {data.workspaces.length > 0 && <section aria-labelledby="home-chats" className="home-browser">
          <div className="home-browser-head">
            <h2 id="home-chats">Chats</h2>
            <label className="home-search">
              <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <input type="search" value={query} placeholder="Filter" aria-label="Filter chats"
                onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }} />
            </label>
          </div>
          <ChatBrowser data={data} query={query} />
        </section>}

        {/* An empty herd gets the prompt, not a dashboard of zeros. */}
        {(counts.total > 0 || Boolean(data.projects?.length)) && <div className="home-grid">
          <HerdCard counts={counts} workspaces={data.workspaces.length} />
          <ActivityCard buckets={activityByHour(data.agents, now)} />
          <LiveCard agents={data.agents} session={data.session} now={now} />
          <div className="flex min-w-0 flex-col gap-3">
            <ProjectOverview projects={data.projects ?? []} onOpen={(slug) => navigate(projectPath(slug, data.session))} />
            <QuickJump agents={data.agents} projects={data.projects} session={data.session} now={now} />
          </div>
        </div>}
      </div>
    </main>
  </div>;
}

/** Type the first message here; the new-chat sheet opens with it filled in, to pick agent and folder. */
function PromptBox({ disabled }: { disabled: boolean }) {
  const [message, setMessage] = useState("");
  return (
    <form className="home-prompt" onSubmit={(event) => {
      event.preventDefault();
      const text = message.trim();
      openNewAgent(text ? { kind: "workspace", message: text } : { kind: "workspace" });
      setMessage("");
    }}>
      <input value={message} onChange={(event) => setMessage(event.target.value)} disabled={disabled}
        aria-label="First message for a new chat" placeholder="Start a chat…" enterKeyHint="go" />
      <button type="submit" disabled={disabled} aria-label="New chat" className="home-prompt-send">
        <ArrowUp aria-hidden className="size-4" />
      </button>
    </form>
  );
}
