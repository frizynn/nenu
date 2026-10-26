import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { ArrowUp, Check, ChevronDown, Folder, GitPullRequest, Lock, Sparkle, SquareTerminal, TriangleAlert } from "@/components/ui/icon";

import { AgentIcon } from "@/components/agent-icon";
import { AppHeader } from "@/components/app-header";
import { PageBody } from "@/components/column-page";
import { DiffStat } from "@/components/diff-stat";
import { Fold } from "@/components/fold";
import { isOpening, OpeningSpinner } from "@/components/home-panels";
import { liveDirsOf, openNewDialog, useSpawnInto } from "@/components/new-agent-sheet";
import { NeedsYouList } from "@/components/needs-you-list";
import { PaneMark } from "@/components/nav-rows";
import type { LockReason } from "@/components/question-card";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { DestinationMenu, ModelMenu, type StartAgent } from "@/components/start-pickers";
import { StatusDot } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { QuietMenu, quietMenuItem } from "@/components/ui/quiet-menu";
import { BottomSheet } from "@/components/ui/sheet";
import type { InteractionsState, Receipt } from "@/hooks/use-interactions";
import { listedModel, useStartModels } from "@/hooks/use-start-models";
import { fetchHomeDirs, type StartModels } from "@/lib/api";
import { projectName } from "@/lib/desk-projects";
import { tildePath } from "@/lib/dir-picker";
import { EnterScope, useEnter } from "@/lib/enter";
import { timeAgo, timeAgoShort } from "@/lib/format";
import {
  boardColumns, defaultFolder, folderOf, HOME_VIEWS, pickUp, useHomeView, viewAsked, withoutAsk,
  type BoardColumns, type HomeView, type SessionList, type StartFolder,
} from "@/lib/home-board";
import { needYou, type NeedsYouItem, type RecentChat } from "@/lib/home-stats";
import type { HomeData } from "@/lib/loaders";
import { panePath } from "@/lib/nav";
import { useHoldReload } from "@/lib/reload-guard";
import { agentLabel, DEFAULT_MODEL, loadAgent, loadDirs, loadModel, loadPermission, PERMISSIONS, suggestDirs } from "@/lib/spawn";
import { BY_FOLDER, destinationFolder, destinationTarget, liveDestination, takesFolder, type StartDestination } from "@/lib/start-destination";
import { canCreate, isReadOnly, type AgentStatus, type Interaction } from "@/lib/types";
import { cn } from "@/lib/utils";

// Only someone choosing another folder needs the picker; it stays out of the bundle Home loads.
const DirPicker = lazy(() => import("@/components/dir-picker").then((m) => ({ default: m.DirPicker })));

/** What a desk's Home is handed by the route: the herd as Home reads it, and the lists it shares with a phone. */
export interface DeskHomeProps {
  data: HomeData;
  /** The herd on screen is not live: its lists are greyed. */
  stale: boolean;
  now: number;
  opening: string | null;
  needs: NeedsYouItem<Interaction>[];
  receipts: Receipt[];
  interactions: InteractionsState;
  lock: LockReason | undefined;
  /** Every session but the ones Needs you shows, last moved first. */
  recent: RecentChat[];
  /** The open PRs GitHub lists (none hides the PRs view), and those this device's filter keeps (the header's count). */
  prs: { listed: number; kept: number };
  /** Recents, Workspaces or PRs, as a phone's Home draws them under its tabs. */
  list: (list: SessionList) => ReactNode;
  /** Other machines and workflows running in the background, under Start. */
  extras: ReactNode;
}

/**
 * What Start's composer holds. DeskHome keeps it, so a look at another view loses none of it and a
 * start still in flight lands, clears the message, and is never sent twice.
 */
interface StartState {
  draft: string;
  /** Fixed once shown: the herd moving never moves where a chat being written starts. */
  folder: StartFolder | null;
  agent: StartAgent;
  permissions: Record<StartAgent, string>;
  /** The model each agent starts on; one the bridge no longer lists starts on the default. */
  models: Record<StartAgent, string>;
  /** Where it opens (lib/start-destination); one closed since it was chosen opens by folder. */
  destination: StartDestination;
  busy: boolean;
  error: string | null;
}

function freshStart(): StartState {
  const last = loadAgent();
  return {
    draft: "", folder: null, agent: last === "shell" ? "claude" : last,
    permissions: { claude: loadPermission("claude"), codex: loadPermission("codex") },
    models: { claude: loadModel("claude"), codex: loadModel("codex") },
    destination: BY_FOLDER, busy: false, error: null,
  };
}

/** How many asks Start shows before leaving the rest to the Board. */
const START_ASKS = 3;

/**
 * Home on a desk: a header whose views are Start, the Board and the three lists a phone keeps under
 * tabs, with the herd's counts at its end; Start asks what to start and holds a new chat's composer,
 * then what needs you and the chats to pick up. The view is remembered on this device, and a link
 * that names a list (the bar's Pull requests) opens on it (ADR 0131).
 */
export function DeskHome(props: DeskHomeProps) {
  const { data, stale, needs, receipts, recent, prs, list } = props;
  const [stored, setStored] = useHomeView();
  const location = useLocation();
  const navigate = useNavigate();
  const asked = viewAsked(location.state);
  useLayoutEffect(() => {
    if (!asked) return;
    setStored(asked);
    void navigate(location.pathname + location.search, { replace: true, state: withoutAsk(location.state) });
  }, [asked, location, navigate, setStored]);
  const views = HOME_VIEWS.filter(([key]) => key !== "prs" || prs.listed > 0);
  const chosen = asked ?? stored;
  const view = views.some(([key]) => key === chosen) ? chosen : "start";

  // Each view opens at its top: the page keeps one scroller, so the offset is reset on a switch.
  const body = useRef<HTMLElement>(null);
  const shownView = useRef(view);
  useLayoutEffect(() => {
    if (shownView.current === view) return;
    shownView.current = view;
    if (body.current) body.current.scrollTop = 0;
  }, [view]);

  const [start, setStart] = useState(freshStart);
  useHoldReload("home-start", start.draft.trim() !== "");
  if (!start.folder) {
    const folder = defaultFolder(loadDirs(), data.agents, data.shellPanes);
    if (folder) setStart({ ...start, folder });
  }
  const spawnInto = useSpawnInto(() => undefined);
  const models = useStartModels(data.session, canCreate(data));
  const begin = async () => {
    if (start.busy || !canCreate(data)) return;
    const { target, cwd, name } = destinationTarget(liveDestination(start.destination, data), start.folder?.cwd ?? "", data);
    const permission = start.permissions[start.agent];
    const model = listedModel(models, start.agent, start.models[start.agent]);
    setStart((s) => ({ ...s, busy: true, error: null }));
    const failure = await spawnInto(target, { agent: start.agent, cwd, name, message: start.draft, permission, model });
    setStart((s) => ({ ...s, busy: false, error: failure, draft: failure === null ? "" : s.draft }));
  };

  const columns = boardColumns(recent);
  const counts: Array<{ key: string; n: number; noun: string; status?: AgentStatus; to: HomeView }> = [
    { key: "needs", n: needs.length, noun: needYou(needs.length).replace(/^\d+ /, ""), status: "blocked", to: "board" },
    { key: "working", n: columns.working.length, noun: "working", status: "working", to: "board" },
    { key: "review", n: columns.review.length, noun: "to review", status: "done", to: "board" },
    { key: "prs", n: prs.kept, noun: prs.kept === 1 ? "PR" : "PRs", to: "prs" },
  ];

  return (
    <div className="workbench-home flex min-h-0 min-w-0 flex-1 flex-col">
      <AppHeader bridge={data.bridge} error={data.error}
        rightLead={<div className="flex items-center gap-0.5">
          {counts.filter((count) => count.n > 0).map((count) => (
            <button key={count.key} type="button" onClick={() => setStored(count.to)} className="quiet-action tabular-nums">
              {count.status ? <StatusDot status={count.status} /> : <GitPullRequest aria-hidden className="size-3.5" />}
              {/* A narrow desk keeps the mark and the number; the words stay for a screen reader. */}
              <span>{count.n}{" "}<span className="max-xl:sr-only">{count.noun}</span></span>
            </button>
          ))}
        </div>}>
        <h1 className="text-subhead font-semibold">Home</h1>
        <span aria-hidden className="mx-5 h-4 w-px shrink-0 bg-border" />
        <div role="tablist" aria-label="Home" className="home-views flex shrink-0 gap-5 self-stretch">
          {views.map(([key, label]) => (
            <button key={key} id={`home-view-${key}`} type="button" role="tab" aria-selected={view === key} aria-controls="home-view"
              onClick={() => setStored(key)} className="desk-tab">{label}</button>
          ))}
        </div>
      </AppHeader>
      <ReadOnlyBanner device={data.device} />
      <PageBody ref={body} className={cn(view === "board" && "pt-6 sm:pt-6")}
        columnClassName={cn(view === "board" ? "flex min-h-full max-w-none flex-col" : view === "start" && "max-w-180")}>
        <div id="home-view" role="tabpanel" aria-labelledby={`home-view-${view}`} className={cn("flex flex-col", view === "board" && "flex-1", stale && "text-muted-foreground grayscale")}>
          {view === "start" && (
            <StartView {...props} start={start} models={models} onStart={(next) => setStart((s) => ({ ...s, ...next }))} onBegin={() => void begin()}
              onView={setStored} moreAsks={Math.max(0, needs.length + receipts.length - START_ASKS)} />
          )}
          {view === "board" && <BoardView {...props} columns={columns} />}
          {(view === "recents" || view === "workspaces" || view === "prs") && list(view)}
        </div>
      </PageBody>
    </div>
  );
}

/** Start: what to start, in which folder, then what needs you and the chats to pick up. */
function StartView({ data, now, opening, needs, receipts, interactions, lock, recent, extras, start, models, onStart, onBegin, onView, moreAsks }: DeskHomeProps & {
  start: StartState;
  models: StartModels;
  onStart: (next: Partial<StartState>) => void;
  onBegin: () => void;
  onView: (view: HomeView) => void;
  /** How many asks Start leaves to the Board. */
  moreAsks: number;
}) {
  const rows = pickUp(recent);
  const project = takesFolder(start.destination) ? start.folder?.project : undefined;
  return (
    <div className="flex flex-col pt-[clamp(0px,calc(18vh-36px),132px)]">
      <h2 className="text-center text-large-title font-normal text-balance text-muted-foreground">
        {project ? <>What should we start in <span className="font-semibold text-foreground">{project}</span>?</> : "What should we start?"}
      </h2>
      <StartComposer data={data} start={start} models={models} onStart={onStart} onBegin={onBegin} />
      <div className="mt-12 flex flex-col gap-2">
        <NeedsYouList agents={data.agents} session={data.session} items={needs.slice(0, START_ASKS)} receipts={receipts.slice(0, Math.max(0, START_ASKS - needs.length))}
          interactions={interactions} lockReason={lock} opening={opening} />
        {moreAsks > 0 && <button type="button" onClick={() => onView("board")} className="quiet-action self-start">{moreAsks} more on the Board</button>}
        {rows.length > 0 && (
          <section aria-label="Pick up" className="flex flex-col">
            <EnterScope><ul className="flex flex-col">{rows.map((chat) => <PickUpRow key={chat.agent.paneId} chat={chat} session={data.session} now={now} opening={opening} />)}</ul></EnterScope>
            {recent.length > rows.length && (
              <button type="button" onClick={() => onView("recents")} className="quiet-action mt-1 self-start">All {recent.length} in Recents</button>
            )}
          </section>
        )}
      </div>
      {extras && <div className="mt-10 flex flex-col gap-6">{extras}</div>}
    </div>
  );
}

/** The mark a finished turn not yet opened wears beside its name, as Recents' rows do. */
const NEW_MARK = <span className="shrink-0 self-center rounded-sm border border-status-done/50 px-1 text-micro text-status-done">New</span>;

/** A chat to pick up, on one line: its mark, name and project, then its size and when it last moved. */
function PickUpRow({ chat, session, now, opening }: { chat: RecentChat; session?: string; now: number; opening: string | null }) {
  const to = panePath(chat.agent.paneId, session);
  const busy = isOpening(opening, to);
  return (
    <li className={useEnter()}>
      <Link to={to} aria-busy={busy || undefined}
        className={cn("grid min-h-10 min-w-0 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg px-2.5 hover:bg-[var(--workbench-row-hover)]", busy && "bg-[var(--workbench-row-hover)]")}>
        <span className="flex justify-center text-muted-foreground"><PaneMark pane={chat.agent} /></span>
        <span className="flex min-w-0 items-baseline gap-2">
          <span className={cn("truncate text-subhead", chat.unseen && "font-semibold")}>{chat.title}</span>
          {chat.unseen && <><span className="sr-only">, </span>{NEW_MARK}</>}
          <span className="sr-only">, </span>
          <span className="shrink-[2] truncate text-footnote text-muted-foreground">{projectName(chat.agent)}</span>
        </span>
        <span className="flex items-center gap-3 text-footnote text-muted-foreground">
          {chat.diff && <DiffStat diff={chat.diff} className="text-caption" />}
          {busy ? <OpeningSpinner /> : chat.at > 0 && <Ago at={chat.at} now={now} />}
        </span>
      </Link>
    </li>
  );
}

/** When a chat last moved; `since` says how long it has been working instead ("for 12m"). */
function Ago({ at, now, since = false }: { at: number; now: number; since?: boolean }) {
  const short = timeAgoShort(at, now);
  const shown = !since ? short : short === "now" ? "just started" : `for ${short}`;
  return <span className="min-w-8 text-right tabular-nums"><span aria-hidden>{shown}</span><span className="sr-only">, {timeAgo(at, now)}</span></span>;
}

/**
 * A new chat's composer: the first message, the agent and model, how much it may do, Start, and under
 * the box where it opens and the folder it starts in. Start goes through the New flow's own create
 * (DeskHome's `begin`): by folder, a tab of the workspace already working there, else a workspace of
 * its own; or the destination chosen. Then the agent and the first message once it is ready.
 */
function StartComposer({ data, start, models, onStart, onBegin }: { data: HomeData; start: StartState; models: StartModels; onStart: (next: Partial<StartState>) => void; onBegin: () => void }) {
  const [home, setHome] = useState("");
  const [picking, setPicking] = useState(false);
  const allowed = canCreate(data);
  const { agent, draft, busy, error } = start;

  // The host's home, so the folder reads as ~/… before the picker is ever opened.
  useEffect(() => {
    if (home || !allowed) return;
    const abort = new AbortController();
    fetchHomeDirs("~", false, abort.signal, data.session).then((dirs) => setHome(dirs.home), () => undefined);
    return () => abort.abort();
  }, [home, allowed, data.session]);

  const permission = PERMISSIONS[agent].find((p) => p.id === start.permissions[agent]) ?? PERMISSIONS[agent][0]!;
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    // A stray Enter in an empty box starts nothing; Start itself still opens an agent with no first message.
    if (draft.trim()) onBegin();
  };
  const destination = liveDestination(start.destination, data);
  const folder = takesFolder(destination);
  const cwd = folder ? start.folder?.cwd ?? "" : "";
  const where = cwd ? tildePath(cwd, home) : "~";
  const model = listedModel(models, agent, start.models[agent]) ?? DEFAULT_MODEL;
  // A workspace or tab brings its own folder along; another can still be picked after it.
  const toDestination = (next: StartDestination) => {
    const there = destinationFolder(next, data);
    onStart({ destination: next, ...(there ? { folder: folderOf(there, [...data.agents, ...data.shellPanes]) } : {}) });
  };

  return (
    <form className="mt-8 flex flex-col" onSubmit={(event) => { event.preventDefault(); onBegin(); }}>
      <div className="composer-box relative z-10">
        <textarea aria-label="First message" value={draft} onChange={(event) => onStart({ draft: event.target.value })} onKeyDown={onKey}
          rows={2} disabled={!allowed} placeholder={`Ask ${agentLabel(agent)} anything, or describe the task`}
          className="composer-input min-h-16 w-full resize-none bg-transparent px-4 pt-3.5 text-body outline-none disabled:cursor-not-allowed" />
        <div className="flex items-center gap-1 px-2 pb-2">
          <ModelMenu models={models} agent={agent} model={model} disabled={!allowed}
            onPick={(a, m) => onStart({ agent: a, models: { ...start.models, [a]: m } })} />
          <QuietMenu icon={permission.danger ? TriangleAlert : Lock} label={permission.label} ariaLabel={`Permissions: ${permission.label}`}
            menuLabel="Permissions" menuClassName="w-80" className={cn(permission.danger && "text-status-working")}>
            {(close) => PERMISSIONS[agent].map((p) => (
              <button key={p.id} type="button" role="menuitemradio" aria-checked={p.id === permission.id}
                onClick={() => { onStart({ permissions: { ...start.permissions, [agent]: p.id } }); close(); }} className={cn(quietMenuItem, "items-start py-2")}>
                <Check aria-hidden className={cn("mt-0.5 size-4 shrink-0", p.id !== permission.id && "invisible")} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className={cn(p.danger && "text-status-working")}>{p.label}</span>
                  <span className="text-footnote text-muted-foreground">{p.hint}</span>
                </span>
              </button>
            ))}
          </QuietMenu>
          <Button type="submit" size="icon" className="composer-action composer-send ml-auto" disabled={!allowed || busy}
            aria-busy={busy || undefined} aria-label={`Start ${agentLabel(agent)}`} title={`Start ${agentLabel(agent)} in ${where}`}>
            {busy ? <OpeningSpinner className="text-current" /> : <ArrowUp aria-hidden className="size-4" />}
          </Button>
        </div>
      </div>
      {/* Where it opens and the folder it starts in, on a lip under the box. */}
      <div className="mx-3 flex min-h-10 min-w-0 items-center gap-1 rounded-b-xl border border-t-0 border-border bg-muted px-1.5">
        <DestinationMenu places={data} destination={destination} onPick={toDestination} disabled={!allowed} />
        {folder && (
          <button type="button" onClick={() => setPicking(true)} disabled={!allowed} aria-label={`Folder: ${where}`}
            className="quiet-action min-w-0 disabled:pointer-events-none">
            <Folder aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">{where}</span>
            <ChevronDown aria-hidden className="-ml-0.5 size-3 shrink-0" />
          </button>
        )}
        <button type="button" onClick={() => openNewDialog()} disabled={!allowed} className="quiet-action ml-auto shrink-0 disabled:pointer-events-none">
          <Sparkle aria-hidden className="size-3.5" />More ways to start
        </button>
      </div>
      {!allowed && <p className="mt-3 text-center text-footnote text-muted-foreground">{isReadOnly(data.device) ? "Read-only: this device is not authorised to start chats." : "Starting a chat waits for Nenu to reach Herdr."}</p>}
      {error && <p role="alert" className="mt-3 text-center text-footnote text-destructive">{error}</p>}
      <BottomSheet open={picking} onClose={() => setPicking(false)} title="Choose a folder" desktop="dialog" className="sm:h-[min(40rem,85dvh)]">
        {picking && (
          <Suspense fallback={<p className="px-2 py-3 text-subhead text-muted-foreground">Loading…</p>}>
            <DirPicker home={home} shortcuts={suggestDirs([cwd], liveDirsOf(data), loadDirs())} onHome={setHome} session={data.session}
              onPick={(path) => { onStart({ folder: folderOf(path, [...data.agents, ...data.shellPanes]) }); setPicking(false); }} />
          </Suspense>
        )}
      </BottomSheet>
    </form>
  );
}

/**
 * The Board: Needs you, Working and Ready to review side by side, each chat a card with what the
 * snapshot says of it, and the chats at rest folded at its foot. Nothing here reads a pane's screen:
 * a working card's line is the terminal title its process sets (ADR 0058).
 */
function BoardView({ data, now, opening, needs, receipts, interactions, lock, columns }: DeskHomeProps & { columns: BoardColumns }) {
  const { working, review, resting } = columns;
  const card = (chat: RecentChat) => <BoardCard key={chat.agent.paneId} chat={chat} session={data.session} now={now} opening={opening} />;
  return (
    <>
      <div className="grid flex-1 grid-cols-3 items-start gap-5">
        <BoardColumn id="needs" label="Needs you" status="blocked" count={needs.length + receipts.length} empty="Nothing needs you.">
          {needs.length + receipts.length > 0 && <NeedsYouList agents={data.agents} session={data.session} items={needs} receipts={receipts}
            interactions={interactions} lockReason={lock} opening={opening} />}
        </BoardColumn>
        <BoardColumn id="working" label="Working" status="working" count={working.length} empty="Nothing is working.">
          {working.length > 0 && <ul className="flex flex-col gap-2">{working.map(card)}</ul>}
        </BoardColumn>
        <BoardColumn id="review" label="Ready to review" status="done" count={review.length} empty="No finished turn to look at.">
          {review.length > 0 && <ul className="flex flex-col gap-2">{review.map(card)}</ul>}
        </BoardColumn>
      </div>
      <Resting chats={resting} session={data.session} now={now} opening={opening} />
    </>
  );
}

/** A Board column: its state's mark while it holds something (colour only for what asks, ADR 0113), its name and count. */
function BoardColumn({ id, label, status, count, empty, children }: { id: string; label: string; status: AgentStatus; count: number; empty: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`board-${id}`} className="flex min-w-0 flex-col gap-3">
      <h2 id={`board-${id}`} className="flex items-center gap-2 px-1 text-footnote font-medium">
        <StatusDot status={count > 0 ? status : "idle"} />{label}
        {count > 0 && <><span className="sr-only">,</span>{" "}<span className="tabular-nums text-muted-foreground">{count}</span></>}
      </h2>
      {children || <p className="px-1 text-footnote text-muted-foreground">{empty}</p>}
    </section>
  );
}

/** A chat on the Board: its name and agent, where it lives, its PR's size and since when, then what its process says it is doing. */
function BoardCard({ chat, session, now, opening }: { chat: RecentChat; session?: string; now: number; opening: string | null }) {
  const { agent, title, diff, at, unseen } = chat;
  const to = panePath(agent.paneId, session);
  const busy = isOpening(opening, to);
  const working = agent.status === "working";
  // The title the process sets follows the work; it says nothing new when it is the chat's own name.
  const doing = working && agent.terminalTitle && agent.terminalTitle !== title ? agent.terminalTitle : null;
  const place = [projectName(agent), chat.tab ?? chat.detail].filter(Boolean).join(" · ");
  return (
    <li className={useEnter()}>
      <Link to={to} aria-busy={busy || undefined}
        className={cn("flex min-w-0 flex-col gap-1 rounded-xl border border-border bg-card px-3.5 py-3 transition-colors duration-120 hover:bg-hover", busy && "bg-hover")}>
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-subhead", unseen ? "font-semibold" : "font-medium")}>{title}</span>
          {unseen && <><span className="sr-only">, </span>{NEW_MARK}</>}
          {busy ? <OpeningSpinner /> : <AgentIcon agent={agent.agent} className="size-4 shrink-0" />}
        </span>
        <span className="flex min-w-0 items-baseline gap-2 text-footnote text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{place}</span>
          {diff && <DiffStat diff={diff} className="text-caption" />}
          {at > 0 && <Ago at={at} now={now} since={working} />}
        </span>
        {doing && (
          <span className="mt-1 flex min-w-0 items-center gap-1.5 text-footnote">
            <SquareTerminal aria-hidden className="size-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate">{doing}</span>
          </span>
        )}
      </Link>
    </li>
  );
}

/** The chats at rest, folded at the Board's foot into one line of their names; open, a list of them. */
function Resting({ chats, session, now, opening }: { chats: RecentChat[]; session?: string; now: number; opening: string | null }) {
  const [open, setOpen] = useState(false);
  if (!chats.length) return null;
  return (
    <section aria-label="Resting" className="sticky bottom-0 mt-6 rounded-xl border border-border bg-muted">
      <button type="button" aria-expanded={open} aria-controls="board-resting" onClick={() => setOpen(!open)}
        className="flex min-h-11 w-full min-w-0 items-center gap-3 px-4 text-left text-footnote">
        <span className="shrink-0 font-medium">Resting <span className="tabular-nums text-muted-foreground">{chats.length}</span></span>
        <span aria-hidden className="min-w-0 flex-1 truncate text-muted-foreground">
          {chats.slice(0, 6).map((chat) => `${chat.title} ${chat.at > 0 ? timeAgoShort(chat.at, now) : ""}`.trim()).join("  ·  ")}
        </span>
        <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-120 motion-reduce:transition-none", open && "rotate-180")} />
      </button>
      <Fold value={open}>
        {() => <ul id="board-resting" className="grid max-h-[40vh] grid-cols-2 gap-x-4 overflow-y-auto px-1.5 pb-2">
          {chats.map((chat) => <PickUpRow key={chat.agent.paneId} chat={chat} session={session} now={now} opening={opening} />)}
        </ul>}
      </Fold>
    </section>
  );
}
