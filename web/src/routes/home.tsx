import { useContext, useRef, useState } from "react";
import { Link, useRouteLoaderData } from "react-router";
import { ArrowUp, Check, ChevronDown, Loader2, MessagesSquare, Wifi } from "lucide-react";

import { ColumnPage } from "@/components/column-page";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { BusySendSheet, HomeHeading, HomeStarters, RecentChats, Reveal, RunningWorkCard, SendNotice, useOpeningPath } from "@/components/home-panels";
import { openNewDialog } from "@/components/new-agent-sheet";
import { NeedsYouList } from "@/components/needs-you-list";
import { lockReasonOf, type LockReason } from "@/components/question-card";
import { ReadyToReviewList, useHomeActivity } from "@/components/ready-to-review-list";
import { looseWorkspaces } from "@/components/workbench-sidebar";
import { useAutosize } from "@/hooks/use-autosize";
import { useConnectionLost } from "@/hooks/use-connection-lost";
import { busyChoiceFor } from "@/hooks/use-message-queue";
import { useInteractions } from "@/hooks/use-interactions";
import { changeMessageQueue, fetchMessageQueue, isDefiniteRefusal } from "@/lib/api";
import { isConnecting } from "@/lib/connection";
import { greeting, homeHeadline, needsYouItems, recentChats, reviewQueue, runningWorkflows } from "@/lib/home-stats";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { panePath } from "@/lib/nav";
import { openNewAgent } from "@/lib/spawn";
import { turnRunning } from "@/lib/turn";
import { isReadOnly, type AgentView, type DeliveryMode, type ProjectView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { WorkbenchNavigationContext } from "@/lib/workbench-navigation";

// Home answers "what needs me now", top to bottom: one sentence, a composer that reaches a
// coordinator or starts a thread, what needs you (answered in place), the chats that moved last, what
// is ready to review and the workflows still running. Projects and workspaces live in the sidebar
// (Browse on a phone), so Home never repeats them. Figures come from the snapshot, the bridge's
// detected dialogs and the Claude sessions' background work; nothing here is stored history.
//
// When the link fails, the connection banner (root.tsx) is the one place that names the problem and
// dates the herd. Home keeps saying what the work is: a brief failure changes nothing on screen (the
// quiet retry), a sustained one or a refusal greys the lists out so nothing reads live, and a composer
// that cannot send says what it waits for. A first load that never reached Nenu has no herd to show,
// so the body only says what will be here.
export function HomeRoute() {
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  const navigation = useContext(WorkbenchNavigationContext);
  const now = Date.now();
  const live = !data.error && data.bridge === "connected";
  // Why answering and sending are paused, if they are: one reading for the cards and the composer.
  const lock = lockReasonOf({ ...data, readOnly: isReadOnly(data.device) });
  const interactions = useInteractions(data.session, live);
  const activity = useHomeActivity(live ? data.agents : [], data.session);
  const lost = useConnectionLost(isConnecting(data));
  const opening = useOpeningPath();
  // The herd on screen is not live: a refusal at once, an outage once it is sustained.
  const stale = data.authError || lost;
  // The composer says a failed read is why it waits only once the outage is sustained (a brief one is
  // the quiet retry); Herdr down, a refusal and a read-only device are said at once.
  const composerLock = lock === "offline" && !lost ? undefined : lock;
  // `bridge` is only unknown when no snapshot was ever read: there is no herd to grey out.
  if (data.bridge === undefined) {
    return <ColumnPage data={data} title="Home">
      <h1 className="sr-only">Home</h1>
      <HomeWithoutHerd refused={data.authError} lost={lost} />
    </ColumnPage>;
  }

  const byPane = new Map(data.agents.map((agent) => [agent.paneId, agent]));
  const needs = needsYouItems(data.agents, interactions.interactions);
  const receipts = interactions.receipts.filter((receipt) => byPane.has(receipt.paneId));
  // A pane Needs you holds (asking, or just answered) stays out of Recent.
  const recent = recentChats(data.agents, data.projects, new Set([...needs, ...receipts].map((item) => item.paneId)));
  // "Nothing needs you" only from a live herd whose dialogs were read; anything older cannot vouch for it.
  const calm = live && interactions.loaded && !interactions.stale && data.agents.length > 0 && !needs.length && !receipts.length;
  const reviews = reviewQueue(data.projects, data.pullRequests);
  const running = runningWorkflows(activity);
  const counts = { needs: needs.length, review: reviews.length, working: data.agents.filter((a) => a.status === "working").length };
  const { title, detail } = homeHeadline(counts, data.agents.length);

  // On a phone the date sits right under the header, so the first screen holds more of the list.
  return <ColumnPage data={data} title="Home" bodyClassName="max-sm:pt-2">
    <div className="flex flex-col gap-6 lg:gap-7">
      <div className="flex flex-col gap-1">
        <p className="text-footnote text-muted-foreground">
          {new Date(now).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" })}
          <span className="max-sm:hidden"> · {greeting(now).toLowerCase()}</span>
        </p>
        <h1 className={cn("text-large-title text-balance", stale && "text-muted-foreground")}>{title}</h1>
        {detail && <p className="text-subhead text-muted-foreground tabular-nums">{detail}</p>}
      </div>
      <div className="flex flex-col">
        <HomeComposer data={data} projects={data.projects ?? []} disabled={!navigation?.onNewChat} lock={composerLock} />
        <Reveal>{live && !data.agents.length && (
          <div className="pt-6 lg:pt-7">
            <HomeStarters disabled={!navigation?.onNewChat} onFolder={() => openNewAgent({ kind: "workspace" })} onMore={() => openNewDialog()} />
          </div>
        )}</Reveal>
      </div>
      {/* The herd as last seen: greyed so nothing reads live, text kept at full contrast. */}
      <div className={cn("flex flex-col gap-6 lg:gap-7", stale && "text-muted-foreground grayscale")}>
        {calm
          ? <p className="flex items-center gap-2 text-footnote text-muted-foreground"><Check aria-hidden className="size-3.5 text-status-done" />Nothing needs you right now</p>
          : <NeedsYouList agents={data.agents} projects={data.projects} session={data.session} items={needs} receipts={receipts}
            interactions={interactions} lockReason={lock} opening={opening} />}
        <RecentChats chats={recent} session={data.session} now={now} opening={opening} />
        <ReadyToReviewList entries={reviews} session={data.session} opening={opening} />
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
    <EmptyState icon={MessagesSquare} title="Nothing to show yet">
      Your threads, questions and reviews show up here once {refused ? "you sign in again." : "Nenu answers. Check this device's network or VPN."}
    </EmptyState>
  );
}

/**
 * What unlocks the composer, said as what to do: "<verb> to start an agent". A read-only device has
 * nothing to do here, so it reads as the thread's composer does. Kept to one line at 375 px: Safari
 * sizes the box by its value, not its placeholder, so a wrapped placeholder is cut in half.
 */
const LOCKED_VERB: Record<Exclude<LockReason, "read-only">, string> = { refused: "Sign in again", offline: "Reconnect", herdr: "Reconnect" };
const lockedPlaceholder = (lock: LockReason, action: string) =>
  lock === "read-only" ? "Read-only — device not authorised" : `${LOCKED_VERB[lock]} to ${action}`;

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

/** What became of the last send: a quiet line when it went, a card naming the cause and the way on when it did not. */
type Sent = { tone: "ok"; text: string; paneId: string } | { tone: "error"; title: string; detail: string; paneId: string };

/** A reason from the bridge as a sentence: capitalised and ending in a stop. */
const sentence = (text: string) => {
  const trimmed = text.trim();
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}${/[.!?]$/.test(trimmed) ? "" : "."}`;
};

/** A queue add whose answer never came: the same text to the same pane goes again under its id. */
type Unsure = { paneId: string; text: string; id: string };

/** A send the bridge refused before anything was queued: the coordinator's queue is not reachable from here. */
class Unavailable extends Error {}

/**
 * Type here and pick where it goes. A project sends to its live coordinator through the shared
 * queue; while the coordinator is mid-turn an action sheet asks, at every send, whether it reads the
 * message now or after this turn, when its CLI has both measured (ADR 0056; the bridge maps each to
 * the CLI's own key). It asks only once the queue is known to take the message: a coordinator that
 * can't goes straight to the card that opens it. A send that
 * fails keeps the draft and says why, with the coordinator one tap away. A workspace or "New
 * workspace" opens the new-chat sheet with the message filled in, to pick agent and folder.
 */
function HomeComposer({ data, projects, disabled, lock }: { data: HomeData; projects: readonly ProjectView[]; disabled: boolean; lock: LockReason | undefined }) {
  const [message, setMessage] = useState("");
  const [choice, setChoice] = useState<string | null>(readTarget);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<Sent | null>(null);
  const unsure = useRef<Unsure | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  useAutosize(box, message);

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
  // The Send to chip names the project, so the box says only what to do.
  const action = target.kind === "project" ? "ask the coordinator" : "start an agent";
  const busyChoice = target.kind === "project" ? busyChoiceFor(target.coordinator.agent) : null;
  // A locked box says what it waits for, from the moment it locks; the banner says what went wrong.
  const reason = disabled && lock ? lockedPlaceholder(lock, action) : null;
  const placeholder = reason ?? (target.kind === "project" ? "Ask the coordinator…" : "Describe a task…");

  /** Send in `mode`, or with "ask" only check that the queue takes it and then ask when it is read. */
  async function send(mode: DeliveryMode | "ask") {
    if (target.kind !== "project") return;
    const text = message.trim();
    const paneId = target.coordinator.paneId;
    const name = `${target.project.name}'s coordinator`;
    setAsking(false);
    setBusy(true);
    setSent(null);
    // Set once the add is on the wire: from then on a lost answer may hide a row already queued.
    let attempt: Unsure | null = null;
    try {
      const page = await fetchMessageQueue(paneId, data.session);
      if (!page.available) throw new Unavailable();
      if (mode === "ask") return setAsking(true);
      const previous = unsure.current;
      attempt = previous?.paneId === paneId && previous.text === text ? previous : { paneId, text, id: crypto.randomUUID() };
      unsure.current = attempt;
      const next = await changeMessageQueue(paneId, { scope: page.scope, action: "add", id: attempt.id, text, deliveryMode: mode }, data.session);
      unsure.current = null;
      const row = next.available ? next.messages.find((m) => m.id === attempt?.id) : undefined;
      setMessage("");
      setSent(row?.state === "paused"
        ? { tone: "error", title: `Held for ${name}`, detail: `${sentence(row.error ?? "It could not take the message yet")} It waits in the coordinator's queue.`, paneId }
        : { tone: "ok", text: row ? `Queued for ${name}.` : `Sent to ${name}.`, paneId });
    } catch (err) {
      // A network error, a timeout or a 5xx after the add went out leaves its fate unknown (ADR 0025):
      // say so, and keep its id so sending the same text again is that same row to the bridge.
      const lost = attempt !== null && !isDefiniteRefusal(err);
      if (attempt && !lost) unsure.current = null;
      setSent(err instanceof Unavailable
        ? { tone: "error", title: `${name} can't take messages from Home`, detail: "Your message is still in the box. Open the coordinator to send it from its chat.", paneId }
        : lost
          ? { tone: "error", title: `Not sure it reached ${name}`, detail: "Nenu didn't answer, so it may already be in the coordinator's queue. Open the coordinator to check.", paneId }
          : { tone: "error", title: `Couldn't send to ${name}`, detail: `${sentence(err instanceof Error && err.message ? err.message : "Check the connection and try again")} Your message is still in the box.`, paneId });
    } finally {
      setBusy(false);
    }
  }

  function submit() {
    const text = message.trim();
    if (target.kind === "new") openNewAgent(text ? { kind: "workspace", message: text } : { kind: "workspace" });
    else if (target.kind === "workspace") openNewAgent({ kind: "tab", workspaceId: target.workspaceId, ...(text ? { message: text } : {}) });
    else if (!text) return;
    // A turn running asks when to read it, if the CLI's two behaviours were measured (ADR 0056);
    // otherwise the row waits for the turn to end, as the queue always did.
    else if (turnRunning(target.coordinator, "")) return void send(busyChoice ? "ask" : "afterTurn");
    else return void send("asap");
    setMessage("");
  }

  const locked = disabled || busy;
  return (
    <div className="flex flex-col">
      <form className="flex flex-col rounded-xl border border-input bg-card focus-within:border-ring/70"
        onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <textarea ref={box} value={message} rows={1} disabled={locked} placeholder={placeholder} enterKeyHint={target.kind === "project" ? "send" : "go"}
          aria-label={target.kind === "project" ? `Message for ${target.project.name}'s coordinator` : "Task for a new agent"}
          onChange={(event) => { setMessage(event.target.value); setAsking(false); }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (!locked) submit();
            }
          }}
          // Before a banner shows, the reason is the only explanation on screen, so it stays readable;
          // the greyed picker and Send say the box is locked.
          className={cn("field-sizing-content max-h-48 min-h-12 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-body outline-none placeholder:text-muted-foreground",
            !reason && "disabled:placeholder:text-disabled-foreground")} />
        <div className="flex items-center gap-2 px-2.5 pt-1 pb-2.5">
          <label className={cn("relative inline-flex h-9 min-w-0 items-center gap-1 rounded-md bg-muted px-2.5 text-footnote focus-within:ring-2 focus-within:ring-ring coarse:h-11",
            locked && "text-disabled-foreground")}>
            <span className={cn("shrink-0", !locked && "text-muted-foreground")}>{target.kind === "project" ? "To:" : "In:"}</span>
            <span className="max-w-[16rem] truncate font-medium">{label}</span>
            <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
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
          {/* The thread's own Send (composer.tsx): ink once there is something to send; until then
              Start still opens the sheet, quietly. */}
          <Button type="submit" size="icon" variant={message.trim() ? "default" : "secondary"} disabled={locked || (target.kind === "project" && !message.trim())}
            aria-label={target.kind === "project" ? "Send" : "Start"} aria-busy={busy || undefined} className="composer-action composer-send hit-area">
            {busy ? <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : <ArrowUp aria-hidden className="size-4" strokeWidth={2.5} />}
          </Button>
        </div>
      </form>
      {target.kind === "project" && busyChoice && (
        <BusySendSheet open={asking} name={`${target.project.name}'s coordinator`} choice={busyChoice}
          onPick={(mode) => void send(mode)} onCancel={() => setAsking(false)} />
      )}
      <Reveal>{sent && (
        <div className="pt-2">
          {sent.tone === "ok" ? (
            <p role="status" className="flex items-center gap-2 text-footnote text-muted-foreground">
              <Check aria-hidden className="size-3.5 shrink-0 text-status-done" />
              {sent.text}
              <Link to={panePath(sent.paneId, data.session)} className="inline-flex items-center font-medium text-foreground underline-offset-2 hover:underline coarse:min-h-11">Open</Link>
            </p>
          ) : <SendNotice title={sent.title} detail={sent.detail} to={panePath(sent.paneId, data.session)} />}
        </div>
      )}</Reveal>
    </div>
  );
}
