import { useContext } from "react";
import { useNavigate, useRouteLoaderData } from "react-router";
import { SquarePen } from "lucide-react";

import { AppHeader, SettingsGear } from "@/components/app-header";
import { ChatGroups } from "@/components/chat-groups";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { SpaceOverview } from "@/components/space-overview";
import { ProjectOverview } from "@/components/project-overview";
import { Button } from "@/components/ui/button";
import { openForCount, useDashPrefs } from "@/hooks/use-dash-prefs";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { panePath, projectPath, spacePath } from "@/lib/nav";
import { looseChats } from "@/lib/projects";
import { WorkbenchNavigationContext } from "@/lib/workbench-navigation";

// Home: start something, or pick up a project or a recent chat. On desktop the sidebar already
// lists chats, so Home keeps them for the phone, where it is the navigation.
export function HomeRoute() {
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  const navigate = useNavigate();
  const navigation = useContext(WorkbenchNavigationContext);
  const { prefs, setSpacesOpen } = useDashPrefs();
  const spacesOpen = openForCount(prefs.spacesOpen, data.workspaces.length);
  const chats = looseChats(data.agents, data.projects);

  return <div className="workbench-home flex min-h-0 min-w-0 flex-1 flex-col">
    <AppHeader bridge={data.bridge} error={data.error} rightTrail={<SettingsGear session={data.session} />}>
      <span className="truncate text-sm font-medium">Home</span>
    </AppHeader>
    <ReadOnlyBanner device={data.device} />
    <main className="min-h-0 flex-1 overflow-y-auto px-4 pt-8 pb-[calc(env(safe-area-inset-bottom)+2rem)] sm:px-8 sm:pt-14">
      <div className="mx-auto w-full max-w-2xl">
        <div className="mb-10">
          <h1 className="text-2xl font-medium tracking-tight">What should we work on?</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {data.error ? "Showing your last workspace snapshot. Reconnect to see current activity."
              : data.bridge !== "connected" ? "Waiting for your workspaces to connect."
              : data.projects?.length ? "Pick a project to talk to its coordinator and follow its tasks."
              : data.agents.length ? "Pick up a recent chat or start a new one."
              : "Start a chat to launch your first agent."}
          </p>
          <Button type="button" className="mt-5 min-h-11" disabled={!navigation?.onNewChat} onClick={navigation?.onNewChat}>
            <SquarePen aria-hidden />New chat
          </Button>
        </div>

        <ProjectOverview projects={data.projects ?? []} onOpen={(slug) => navigate(projectPath(slug, data.session))} />

        {chats.length > 0 && <section aria-label="Recent chats" className="home-chats mb-10 lg:hidden">
          <ChatGroups panes={chats} session={data.session} />
        </section>}

        <SpaceOverview
          workspaces={data.workspaces}
          tabs={data.tabs}
          agents={data.agents}
          shellPanes={data.shellPanes}
          onOpen={(workspaceId) => navigate(spacePath(workspaceId, data.session))}
          onOpenPane={(paneId) => navigate(panePath(paneId, data.session))}
          onNewSpace={() => navigation?.onNewChat?.()}
          open={spacesOpen}
          onOpenChange={setSpacesOpen}
        />
      </div>
    </main>
  </div>;
}
