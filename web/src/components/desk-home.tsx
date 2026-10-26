import { lazy, Suspense, useEffect, useLayoutEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { ArrowUp, Check, ChevronDown, Folder, GitPullRequest, Lock, Sparkle, SquareTerminal, TriangleAlert, type IconComponent } from "@/components/ui/icon";

import { AgentIcon } from "@/components/agent-icon";
import { AppHeader } from "@/components/app-header";
import { PageBody } from "@/components/column-page";
import { DiffStat } from "@/components/diff-stat";
import { Fold } from "@/components/fold";
import { isOpening, OpeningSpinner, type SessionList } from "@/components/home-panels";
import { liveDirsOf, openNewDialog, useSpawnInto } from "@/components/new-agent-sheet";
import { NeedsYouList } from "@/components/needs-you-list";
import { PaneMark } from "@/components/nav-rows";
import type { LockReason } from "@/components/question-card";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { StatusDot } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { QuietMenu, quietMenuItem } from "@/components/ui/quiet-menu";
import { BottomSheet } from "@/components/ui/sheet";
import type { InteractionsState, Receipt } from "@/hooks/use-interactions";
import { fetchHomeDirs } from "@/lib/api";
import { projectName } from "@/lib/desk-projects";
import { baseName, tildePath } from "@/lib/dir-picker";
import { EnterScope, useEnter } from "@/lib/enter";
import { timeAgo, timeAgoShort } from "@/lib/format";
import { boardColumns, HOME_VIEWS, lastFolder, pickUp, startTarget, useHomeView, viewAsked, type HomeView, type StartFolder } from "@/lib/home-board";
import { needYou, type NeedsYouItem, type RecentChat } from "@/lib/home-stats";
import type { HomeData } from "@/lib/loaders";
import { panePath } from "@/lib/nav";
import { useHoldReload } from "@/lib/reload-guard";
import { agentLabel, loadAgent, loadDirs, loadPermission, PERMISSIONS, SPAWN_AGENTS, suggestDirs, type SpawnAgent } from "@/lib/spawn";
import { canCreate, isReadOnly, type AgentStatus, type AgentView, type Interaction } from "@/lib/types";
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
  /** Recents, Workspaces and PRs, as a phone's Home draws them under its tabs. */
  list: (list: SessionList) => ReactNode;
  /** Other machines and workflows running in the background, under Start. */
  more: ReactNode;
}

/**
 * Home on a desk: a header whose views are Start, the Board and the three lists a phone keeps under
 * tabs, with the herd's counts at its end; Start asks what to start and holds a new chat's composer,
 * then what needs you and the chats to pick up. The view is remembered on this device, and a link
 * that names a list (the bar's Pull requests) opens on it (ADR 0131).
 */
export function DeskHome(props: DeskHomeProps) {
  const { data, stale, needs, receipts, prs, list } = props;
  const [stored, setStored] = useHomeView();
  const location = useLocation();
  const navigate = useNavigate();
  const asked = viewAsked(location.state);
  // The ask is taken out of the entry's state once kept, so a Back or a reload opens on the view last chosen.
  useLayoutEffect(() => {
    if (!asked) return;
    setStored(asked);
    const rest = Object.fromEntries(Object.entries(location.state as object).filter(([key]) => key !== "list"));
    void navigate(location.pathname + location.search, { replace: true, state: rest });
  }, [asked, location, navigate, setStored]);
  const views = HOME_VIEWS.filter(([key]) => key !== "prs" || prs.listed > 0);
  const chosen = asked ?? stored;
  const view = views.some(([key]) => key === chosen) ? chosen : "start";
  const show = (next: HomeView) => setStored(next);
  // The first message outlives a look at another view, and a self-update reload waits for it.
  const [draft, setDraft] = useState("");
  useHoldReload("home-start", draft.trim() !== "");

  const working = data.agents.filter((agent) => agent.status === "working").length;
  const review = data.agents.filter((agent) => agent.status === "done").length;
  const asking = needs.length + receipts.length;
  const counts: Array<{ key: string; n: number; words: string; status?: AgentStatus; to: HomeView }> = [
    { key: "needs", n: needs.length, words: needYou(needs.length), status: "blocked", to: "board" },
    { key: "working", n: working, words: `${working} working`, status: "working", to: "board" },
    { key: "review", n: review, words: `${review} to review`, status: "done", to: "board" },
    { key: "prs", n: prs.kept, words: `${prs.kept} ${prs.kept === 1 ? "PR" : "PRs"}`, to: "prs" },
  ];

  return (
    <div className="workbench-home flex min-h-0 min-w-0 flex-1 flex-col">
      <AppHeader bridge={data.bridge} error={data.error}
        rightLead={<div className="flex items-center gap-0.5">
          {counts.filter((count) => count.n > 0).map((count) => (
            <button key={count.key} type="button" onClick={() => show(count.to)} className="quiet-action tabular-nums">
              {count.status ? <StatusDot status={count.status} /> : <GitPullRequest aria-hidden className="size-3.5" />}
              {count.words}
            </button>
          ))}
        </div>}>
        <h1 className="mr-6 text-subhead font-semibold">Home</h1>
        <div role="tablist" aria-label="Home" className="home-views flex gap-5 self-stretch">
          {views.map(([key, label]) => (
            <button key={key} id={`home-view-${key}`} type="button" role="tab" aria-selected={view === key} aria-controls="home-view"
              onClick={() => show(key)} className="desk-tab">{label}</button>
          ))}
        </div>
      </AppHeader>
      <ReadOnlyBanner device={data.device} />
      <PageBody key={view} className={cn(view === "board" && "pt-6 sm:pt-6")} columnClassName={cn(view === "board" ? "flex min-h-full max-w-none flex-col" : view === "start" && "max-w-180")}>
        <div id="home-view" role="tabpanel" aria-labelledby={`home-view-${view}`} className={cn("flex flex-col", view === "board" && "flex-1", stale && "text-muted-foreground grayscale")}>
          {view === "start" && <StartView {...props} onView={show} more={asking > 3 ? asking - 3 : 0} extras={props.more} draft={draft} onDraft={setDraft} />}
          {view === "board" && <BoardView {...props} />}
          {(view === "recents" || view === "workspaces" || view === "prs") && list(view)}
        </div>
      </PageBody>
    </div>
  );
}

/** The first message being written in Start's composer, kept by DeskHome. */
interface Draft {
  draft: string;
  onDraft: (draft: string) => void;
}

/** Start: what to start, in which folder, then what needs you and the chats to pick up. */
function StartView({ data, now, opening, needs, receipts, interactions, lock, recent, onView, more, extras, draft, onDraft }: DeskHomeProps & Draft & {
  onView: (view: HomeView) => void;
  /** How many asks Start leaves to the Board. */
  more: number;
  extras: ReactNode;
}) {
  const [picked, setPicked] = useState<StartFolder | null>(null);
  const herdFolder = lastFolder(data.agents, data.shellPanes);
  const folder = picked ?? herdFolder ?? { cwd: loadDirs()[0] ?? "", project: "" };
  const rows = pickUp(recent);
  const panes = [...data.agents, ...data.shellPanes];
  const choose = (cwd: string) => {
    const pane = panes.find((p) => p.cwd === cwd);
    setPicked({ cwd, project: pane ? projectName(pane) : baseName(cwd) });
  };
  return (
    <div className="flex flex-col pt-[clamp(0px,calc(18vh-36px),132px)]">
      <h2 className="text-center text-large-title font-normal text-balance text-muted-foreground">
        {folder.project
          ? <>What should we start in <span className="font-semibold text-foreground">{folder.project}</span>?</>
          : "What should we start?"}
      </h2>
      <StartComposer data={data} folder={folder} panes={panes} onFolder={choose} draft={draft} onDraft={onDraft} />
      <div className="mt-12 flex flex-col gap-2">
        <NeedsYouList agents={data.agents} session={data.session} items={needs.slice(0, 3)} receipts={receipts.slice(0, Math.max(0, 3 - needs.length))}
          interactions={interactions} lockReason={lock} opening={opening} />
        {more > 0 && <button type="button" onClick={() => onView("board")} className="quiet-action self-start">{more} more on the Board</button>}
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
  const shown = since && short !== "now" ? `for ${short}` : short;
  return <span className="min-w-8 text-right tabular-nums"><span aria-hidden>{shown}</span><span className="sr-only">, {timeAgo(at, now)}</span></span>;
}

// The agent menu's mark, one component per agent: a component made during a render would be a new type
// on every poll, and React would swap its DOM each time.
const AGENT_MARKS: Record<"claude" | "codex", IconComponent> = {
  claude: ({ className }) => <AgentIcon agent="claude" className={cn(className, "size-4")} />,
  codex: ({ className }) => <AgentIcon agent="codex" className={cn(className, "size-4")} />,
};

/**
 * A new chat's composer: the first message, the agent and how much it may do, Start, and under the
 * box the folder it starts in. It starts through the New flow's own create (useSpawnInto): a tab of
 * the workspace already working in that folder, else a workspace of its own, then the agent and the
 * first message once it is ready.
 */
function StartComposer({ data, folder, panes, onFolder, draft: message, onDraft: setMessage }: Draft & { data: HomeData; folder: StartFolder; panes: AgentView[]; onFolder: (cwd: string) => void }) {
  const [agent, setAgent] = useState<Exclude<SpawnAgent, "shell">>(() => {
    const last = loadAgent();
    return last === "shell" ? "claude" : last;
  });
  const [permissions, setPermissions] = useState(() => ({ claude: loadPermission("claude"), codex: loadPermission("codex") }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [home, setHome] = useState("");
  const [picking, setPicking] = useState(false);
  const spawnInto = useSpawnInto(() => setMessage(""));
  const allowed = canCreate(data);

  // The host's home, so the folder reads as ~/… before the picker is ever opened.
  useEffect(() => {
    if (home || !allowed) return;
    const abort = new AbortController();
    fetchHomeDirs("~", false, abort.signal, data.session).then((dirs) => setHome(dirs.home), () => undefined);
    return () => abort.abort();
  }, [home, allowed, data.session]);

  const permission = PERMISSIONS[agent].find((p) => p.id === permissions[agent]) ?? PERMISSIONS[agent][0]!;
  async function submit() {
    if (busy || !allowed) return;
    setBusy(true);
    setError(null);
    const failure = await spawnInto(startTarget(folder.cwd, panes), { agent, cwd: folder.cwd, name: "", message, permission: permission.id });
    setBusy(false);
    if (failure !== null) setError(failure);
  }
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    // A stray Enter in an empty box starts nothing; Start itself still opens an agent with no first message.
    if (!message.trim()) return;
    void submit();
  };
  const where = folder.cwd ? tildePath(folder.cwd, home) : "~";

  return (
    <form className="mt-8 flex flex-col" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <div className="composer-box relative z-10">
        <textarea aria-label="First message" value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={onKey}
          rows={2} disabled={!allowed} placeholder={`Ask ${agentLabel(agent)} anything, or describe the task`}
          className="composer-input min-h-16 w-full resize-none bg-transparent px-4 pt-3.5 text-body outline-none disabled:cursor-not-allowed" />
        <div className="flex items-center gap-1 px-2 pb-2">
          <QuietMenu icon={AGENT_MARKS[agent]} label={agentLabel(agent)} ariaLabel={`Agent: ${agentLabel(agent)}`} menuLabel="Agent">
            {(close) => SPAWN_AGENTS.filter((a) => a.id !== "shell").map((a) => (
              <button key={a.id} type="button" role="menuitemradio" aria-checked={a.id === agent}
                onClick={() => { setAgent(a.id as typeof agent); close(); }} className={quietMenuItem}>
                <Check aria-hidden className={cn("size-4 shrink-0", a.id !== agent && "invisible")} />
                <AgentIcon agent={a.id} className="size-4" />
                <span className="min-w-0 flex-1 truncate">{a.label}</span>
              </button>
            ))}
          </QuietMenu>
          <QuietMenu icon={permission.danger ? TriangleAlert : Lock} label={permission.label} ariaLabel={`Permissions: ${permission.label}`}
            menuLabel="Permissions" menuClassName="w-80" className={cn(permission.danger && "text-status-working")}>
            {(close) => PERMISSIONS[agent].map((p) => (
              <button key={p.id} type="button" role="menuitemradio" aria-checked={p.id === permission.id}
                onClick={() => { setPermissions((all) => ({ ...all, [agent]: p.id })); close(); }} className={cn(quietMenuItem, "items-start py-2")}>
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
      {/* The folder it starts in, on a lip under the box. */}
      <div className="mx-3 flex min-h-10 items-center gap-2 rounded-b-xl border border-t-0 border-border bg-muted px-1.5">
        <button type="button" onClick={() => setPicking(true)} disabled={!allowed} aria-label={`Folder: ${where}`}
          className="quiet-action min-w-0 disabled:pointer-events-none">
          <Folder aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">{where}</span>
          <ChevronDown aria-hidden className="-ml-0.5 size-3 shrink-0" />
        </button>
        <button type="button" onClick={() => openNewDialog()} disabled={!allowed} className="quiet-action ml-auto shrink-0 disabled:pointer-events-none">
          <Sparkle aria-hidden className="size-3.5" />More ways to start
        </button>
      </div>
      {!allowed && <p className="mt-3 text-center text-footnote text-muted-foreground">{isReadOnly(data.device) ? "Read-only: this device is not authorised to start chats." : "Starting a chat waits for Nenu to reach Herdr."}</p>}
      {error && <p role="alert" className="mt-3 text-center text-footnote text-destructive">{error}</p>}
      <BottomSheet open={picking} onClose={() => setPicking(false)} title="Choose a folder" desktop="dialog" className="sm:h-[min(40rem,85dvh)]">
        {picking && (
          <Suspense fallback={<p className="px-2 py-3 text-subhead text-muted-foreground">Loading…</p>}>
            <DirPicker home={home} shortcuts={suggestDirs([folder.cwd], liveDirsOf(data), loadDirs())} onHome={setHome} session={data.session}
              onPick={(path) => { onFolder(path); setPicking(false); }} />
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
function BoardView({ data, now, opening, needs, receipts, interactions, lock, recent }: DeskHomeProps) {
  const { working, review, resting } = boardColumns(recent);
  const card = (chat: RecentChat) => <BoardCard key={chat.agent.paneId} chat={chat} session={data.session} now={now} opening={opening} />;
  return (
    <>
      <div className="grid flex-1 grid-cols-3 items-start gap-5">
        <BoardColumn label="Needs you" status="blocked" count={needs.length} empty="Nothing needs you.">
          {needs.length + receipts.length > 0 && <NeedsYouList agents={data.agents} session={data.session} items={needs} receipts={receipts}
            interactions={interactions} lockReason={lock} opening={opening} />}
        </BoardColumn>
        <BoardColumn label="Working" status="working" count={working.length} empty="Nothing is working.">
          {working.length > 0 && <ul className="flex flex-col gap-2">{working.map(card)}</ul>}
        </BoardColumn>
        <BoardColumn label="Ready to review" status="done" count={review.length} empty="No finished turn to look at.">
          {review.length > 0 && <ul className="flex flex-col gap-2">{review.map(card)}</ul>}
        </BoardColumn>
      </div>
      <Resting chats={resting} session={data.session} now={now} opening={opening} />
    </>
  );
}

function BoardColumn({ label, status, count, empty, children }: { label: string; status: AgentStatus; count: number; empty: string; children: ReactNode }) {
  return (
    <section aria-label={count > 0 ? `${label}, ${count}` : label} className="flex min-w-0 flex-col gap-3">
      <h2 aria-hidden className="flex items-center gap-2 px-1 text-footnote font-medium">
        <StatusDot status={status} />{label}
        {count > 0 && <span className="tabular-nums text-muted-foreground">{count}</span>}
      </h2>
      {children || <p className="px-1 text-footnote text-muted-foreground">{empty}</p>}
    </section>
  );
}

/** A chat on the Board: its name and agent, where it lives and since when, then what it is doing or how big its PR is. */
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
          {unseen && <span className="shrink-0 rounded-sm border border-status-done/50 px-1 text-micro text-status-done">New</span>}
          {busy ? <OpeningSpinner /> : <AgentIcon agent={agent.agent} className="size-4 shrink-0" />}
        </span>
        <span className="flex min-w-0 items-baseline gap-2 text-footnote text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{place}</span>
          {at > 0 && <Ago at={at} now={now} since={working} />}
        </span>
        {(doing || diff) && (
          <span className="mt-1 flex min-w-0 items-center gap-1.5 text-footnote">
            {doing && <><SquareTerminal aria-hidden className="size-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate">{doing}</span></>}
            {diff && <DiffStat diff={diff} className={cn("text-caption", !doing && "ml-auto")} />}
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
