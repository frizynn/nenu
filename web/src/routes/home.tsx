import { useContext, useState } from "react";
import { Link, useRouteLoaderData } from "react-router";
import { ArrowUp, ChevronDown, Folder, LayoutGrid, Plus } from "lucide-react";

import { AppHeader, SettingsGear } from "@/components/app-header";
import { QuickJump, RunningWorkCard, WorkspaceSummary } from "@/components/home-panels";
import { NeedsYouList } from "@/components/needs-you-list";
import { ProjectSummaryCard } from "@/components/project-summary-card";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { ReadyToReviewList, useHomeActivity } from "@/components/ready-to-review-list";
import { looseWorkspaces } from "@/components/workbench-sidebar";
import { useInteractions } from "@/hooks/use-interactions";
import { changeMessageQueue, fetchMessageQueue } from "@/lib/api";
import { finishedNotices, greeting, homeHeadline, needsYouItems, reviewItems, runningWorkflows } from "@/lib/home-stats";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { panePath } from "@/lib/nav";
import { openNewAgent } from "@/lib/spawn";
import { isReadOnly, type AgentView, type DeliveryMode, type ProjectView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { WorkbenchNavigationContext } from "@/lib/workbench-navigation";

// Home is the command center: one sentence of what matters, a composer that reaches a coordinator or
// starts a thread, then what needs you (answered in place), what is ready to review, and the
// projects and loose workspaces. Figures come from the snapshot, the bridge's detected dialogs and
// the Claude sessions' background work; nothing here is stored history.
export function HomeRoute() {
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  const navigation = useContext(WorkbenchNavigationContext);
  const now = Date.now();
  const live = !data.error && data.bridge === "connected";
  const readOnly = isReadOnly(data.device);
  const interactions = useInteractions(data.session, live);
  const activity = useHomeActivity(live ? data.agents : [], data.session);

  const byPane = new Map(data.agents.map((agent) => [agent.paneId, agent]));
  const needs = needsYouItems(data.agents, interactions.interactions);
  const reviews = reviewItems(data.projects);
  const notices = finishedNotices(activity, data.agents, now);
  const running = runningWorkflows(activity);
  const counts = { needs: needs.length, review: reviews.length + notices.length, working: data.agents.filter((a) => a.status === "working").length };
  const long = homeHeadline(counts, data.agents.length);
  const short = homeHeadline(counts, data.agents.length, true);
  const loose = looseWorkspaces(data);
  const projects = data.projects ?? [];
  const notice = data.error ? "Showing your last workspace snapshot. Reconnect to see current activity."
    : data.bridge !== "connected" ? "Waiting for your workspaces to connect."
    : data.agents.length ? null : "Describe a task to start your first agent. You pick the agent and folder next.";
  const sideHead = "flex items-center gap-2 text-[12.5px] font-medium text-muted-foreground";

  return <div className="workbench-home flex min-h-0 min-w-0 flex-1 flex-col">
    <AppHeader bridge={data.bridge} error={data.error} rightTrail={<SettingsGear session={data.session} />}>
      <span className="truncate text-sm font-medium">Home</span>
    </AppHeader>
    <ReadOnlyBanner device={data.device} />
    <main className="min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-[calc(env(safe-area-inset-bottom)+2rem)] sm:px-8 sm:pt-9 xl:px-12">
      <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-7 lg:flex-row lg:gap-10">
        <div className="flex min-w-0 flex-1 flex-col gap-6 lg:max-w-[680px] lg:gap-7">
          <div className="flex flex-col gap-1.5">
            <p className="text-sm text-muted-foreground sm:text-[13px]">
              {new Date(now).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" })}
              <span className="max-sm:hidden"> · {greeting(now).toLowerCase()}</span>
            </p>
            <h1 className="text-[27px] leading-tight font-semibold tracking-tight sm:text-[30px]">
              {!live ? "What should we work on?" : short === long ? long : <>
                <span className="sm:hidden">{short}</span>
                <span className="max-sm:hidden">{long}</span>
              </>}
            </h1>
            {notice && <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{notice}</p>}
          </div>
          <div className="order-2 lg:order-1">
            <HomeComposer data={data} projects={projects} disabled={!navigation?.onNewChat} />
          </div>
          <div className="order-1 empty:hidden lg:order-2">
            <NeedsYouList agents={data.agents} projects={data.projects} session={data.session} interactions={interactions} readOnly={readOnly || !live} />
          </div>
          <div className="order-3 empty:hidden">
            <ReadyToReviewList reviews={reviews} notices={notices} agents={data.agents} session={data.session} now={now} />
          </div>
        </div>

        <aside aria-label="Projects and workspaces" className="flex min-w-0 flex-col gap-6 lg:w-[340px] lg:flex-none lg:pt-1">
          <QuickJump agents={data.agents} projects={data.projects} session={data.session} now={now} />
          {running.length > 0 && (
            <section aria-labelledby="home-running" className="flex flex-col gap-2.5">
              <h2 id="home-running" className={sideHead}><span className="text-foreground/85">Running in background</span><span className="tabular-nums">{running.length}</span></h2>
              {running.map(({ paneId, workflow }) => <RunningWorkCard key={`${paneId}:${workflow.runId}`} paneId={paneId} workflow={workflow} agent={byPane.get(paneId)} session={data.session} now={now} />)}
            </section>
          )}
          {projects.length > 0 && (
            <section aria-labelledby="home-projects" className="flex flex-col gap-2.5">
              <h2 id="home-projects" className={sideHead}><span className="text-foreground/85">Projects</span><span className="tabular-nums">{projects.length}</span></h2>
              {projects.map((project) => <ProjectSummaryCard key={project.slug} project={project} session={data.session} />)}
            </section>
          )}
          {loose.workspaces.length > 0 && (
            <section aria-labelledby="home-workspaces" className="flex flex-col gap-1">
              <h2 id="home-workspaces" className={sideHead}>
                <span className="text-foreground/85">Workspaces</span><span className="tabular-nums">{loose.workspaces.length}</span>
                {projects.length > 0 && <span className="ml-auto font-normal">not in a project</span>}
              </h2>
              <ul className="flex flex-col max-sm:divide-y max-sm:divide-border">
                {loose.workspaces.map((workspace) => (
                  <WorkspaceSummary key={workspace.workspaceId} workspace={workspace} session={data.session}
                    agents={loose.agents.filter((agent) => agent.workspaceId === workspace.workspaceId)} />
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </main>
  </div>;
}

/** Where the composer sends: a project's coordinator, a new thread in a workspace, or a new workspace. */
type Target = { kind: "new" } | { kind: "workspace"; workspaceId: string; label: string } | { kind: "project"; project: ProjectView; coordinator: AgentView };

const TARGET_KEY = "nenu:home-target:v1";
const valueOf = (target: Target) => target.kind === "new" ? "new" : target.kind === "workspace" ? `workspace:${target.workspaceId}` : `project:${target.project.slug}`;

function readTarget(): string | null {
  try {
    return localStorage.getItem(TARGET_KEY);
  } catch {
    return null;
  }
}
function rememberTarget(value: string): void {
  try {
    localStorage.setItem(TARGET_KEY, value);
  } catch {
    /* Private mode or a full quota: the choice just isn't remembered. */
  }
}

type Sent = { tone: "ok" | "error"; text: string; paneId?: string };

/**
 * Type here and pick where it goes. A project sends to its live coordinator through the shared
 * queue; while the coordinator is mid-turn you choose to steer it now or queue for after the turn
 * (the bridge maps each to the CLI's own key). A workspace or "New workspace" opens the new-chat
 * sheet with the message filled in, to pick agent and folder.
 */
function HomeComposer({ data, projects, disabled }: { data: HomeData; projects: readonly ProjectView[]; disabled: boolean }) {
  const [message, setMessage] = useState("");
  const [choice, setChoice] = useState<string | null>(readTarget);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<Sent | null>(null);

  const byPane = new Map(data.agents.map((agent) => [agent.paneId, agent]));
  const targets: Target[] = [
    ...projects.flatMap((project): Target[] => {
      const coordinator = project.coordinator && byPane.get(project.coordinator.paneId);
      return coordinator ? [{ kind: "project", project, coordinator }] : [];
    }),
    { kind: "new" },
    ...looseWorkspaces(data).workspaces.map((workspace): Target => ({ kind: "workspace", workspaceId: workspace.workspaceId, label: workspace.label })),
  ];
  const target = targets.find((candidate) => valueOf(candidate) === choice) ?? targets[0]!;
  const label = target.kind === "project" ? target.project.name : target.kind === "workspace" ? target.label : "New workspace";
  const Icon = target.kind === "project" ? Folder : target.kind === "workspace" ? LayoutGrid : Plus;
  const placeholder = target.kind === "project" ? `Ask ${target.project.name}'s coordinator…` : "Start a thread…";

  async function send(mode: DeliveryMode) {
    if (target.kind !== "project") return;
    const text = message.trim();
    const paneId = target.coordinator.paneId;
    setAsking(false);
    setBusy(true);
    setSent(null);
    try {
      const page = await fetchMessageQueue(paneId, data.session);
      if (!page.available) throw new Error("This coordinator can't take messages from here. Open it to reply.");
      const id = crypto.randomUUID();
      const next = await changeMessageQueue(paneId, { scope: page.scope, action: "add", id, text, deliveryMode: mode }, data.session);
      const row = next.available ? next.messages.find((m) => m.id === id) : undefined;
      setMessage("");
      setSent(row?.state === "paused"
        ? { tone: "error", text: `Held: ${row.error ?? "the coordinator could not take it yet"}.`, paneId }
        : { tone: "ok", text: row ? `Queued for ${target.project.name}'s coordinator.` : `Sent to ${target.project.name}'s coordinator.`, paneId });
    } catch (err) {
      setSent({ tone: "error", text: err instanceof Error && err.message ? err.message : "Could not send. Try again.", paneId });
    } finally {
      setBusy(false);
    }
  }

  function submit() {
    const text = message.trim();
    if (target.kind === "new") openNewAgent(text ? { kind: "workspace", message: text } : { kind: "workspace" });
    else if (target.kind === "workspace") openNewAgent({ kind: "tab", workspaceId: target.workspaceId, ...(text ? { message: text } : {}) });
    else if (!text) return;
    else if (target.coordinator.status === "working") return setAsking(true);
    else return void send("asap");
    setMessage("");
  }

  const locked = disabled || busy;
  return (
    <div className="flex flex-col gap-2">
      <form className="flex flex-col rounded-[18px] border border-input bg-card shadow-[0_8px_24px_rgb(0_0_0/0.25)] focus-within:border-ring/70 sm:rounded-[14px]"
        onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <textarea value={message} rows={1} disabled={locked} placeholder={placeholder} enterKeyHint="send"
          aria-label={target.kind === "project" ? `Message for ${target.project.name}'s coordinator` : "First message for a new chat"}
          onChange={(event) => { setMessage(event.target.value); setAsking(false); }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (!locked) submit();
            }
          }}
          className="field-sizing-content max-h-48 min-h-12 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-base outline-none placeholder:text-muted-foreground sm:text-sm" />
        <div className="flex items-center gap-2 px-2.5 pt-1 pb-2.5">
          <label className="relative inline-flex h-8 min-w-0 items-center gap-1.5 rounded-lg bg-muted px-2.5 text-[12.5px] text-foreground/85 focus-within:ring-2 focus-within:ring-ring max-sm:h-9 max-sm:text-[13px]">
            <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="max-w-[16rem] truncate">{label}</span>
            <ChevronDown aria-hidden className="size-3 shrink-0 text-muted-foreground" />
            <select aria-label="Send to" value={valueOf(target)} disabled={locked}
              onChange={(event) => { setChoice(event.target.value); rememberTarget(event.target.value); setAsking(false); setSent(null); }}
              className="absolute inset-0 cursor-pointer opacity-0">
              {targets.some((t) => t.kind === "project") && <optgroup label="Project coordinators">
                {targets.filter((t) => t.kind === "project").map((t) => <option key={valueOf(t)} value={valueOf(t)}>{t.project.name}</option>)}
              </optgroup>}
              <option value="new">New workspace</option>
              {targets.some((t) => t.kind === "workspace") && <optgroup label="New thread in">
                {targets.filter((t) => t.kind === "workspace").map((t) => <option key={valueOf(t)} value={valueOf(t)}>{t.label}</option>)}
              </optgroup>}
            </select>
          </label>
          <span className="flex-1" />
          <button type="submit" disabled={locked || (target.kind === "project" && !message.trim())} aria-label={target.kind === "project" ? "Send" : "New chat"}
            className={cn("inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] transition-colors disabled:opacity-40 max-sm:size-10",
              message.trim() ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
            <ArrowUp aria-hidden className="size-4" />
          </button>
        </div>
      </form>
      {asking && target.kind === "project" && (
        <div role="group" aria-label="The coordinator is working" className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="text-muted-foreground">The coordinator is working.</span>
          <button type="button" onClick={() => void send("asap")} className="inline-flex min-h-9 items-center rounded-lg bg-foreground px-3 font-medium text-background max-sm:min-h-10">Send now</button>
          <button type="button" onClick={() => void send("afterTurn")} className="inline-flex min-h-9 items-center rounded-lg border border-border bg-secondary px-3 font-medium max-sm:min-h-10">Queue for later</button>
          <button type="button" onClick={() => setAsking(false)} className="inline-flex min-h-9 items-center px-2 text-muted-foreground max-sm:min-h-10">Cancel</button>
        </div>
      )}
      {sent && (
        <p role="status" className={cn("flex flex-wrap items-center gap-x-2 text-[13px]", sent.tone === "error" ? "text-destructive" : "text-muted-foreground")}>
          {sent.text}
          {sent.paneId && <Link to={panePath(sent.paneId, data.session)} className="font-medium text-foreground underline-offset-2 hover:underline">Open</Link>}
        </p>
      )}
    </div>
  );
}
