import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { ChevronRight, House, Laptop, LayoutGrid, ListChecks, Plus, Search, Settings2, SquarePen, Workflow } from "@/components/ui/icon";

import { DeskLists } from "@/components/desk-nav";
import { openNewDialog } from "@/components/new-agent-sheet";
import { NodeDot } from "@/components/node-row";
import { ProjectGlyph } from "@/components/project-glyph";
import { SessionSwitcher } from "@/components/session-switcher";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusDot } from "@/components/status-badge";
import { ChatRow, Highlight, OpeningMark, PaneMark, PlaceText, RowBody } from "@/components/nav-rows";
import { WorkspaceTree } from "@/components/workspace-tree";
import { MachinesSlot } from "@/components/machines-slot";
import { cn } from "@/lib/utils";
import { isAttention } from "@/lib/triage";
import { workspaceTree } from "@/lib/workspace-tree";
import { displayName } from "@/lib/display-name";
import { navSearch, type SearchGroup, type SearchHit } from "@/lib/nav-search";
import { currentMachine, machineSearch, type MachineSearchGroup } from "@/lib/machines";
import { asksAvailable } from "@/hooks/use-asks";
import { useSidebarPrefs } from "@/hooks/use-sidebar-prefs";
import { drawerSections, type DrawerChat } from "@/lib/nav-drawer";
import { needsYouCount, needYou } from "@/lib/home-stats";
import type { HomeData } from "@/lib/loaders";
import { asksPath, homePath, nodePath, panePath, projectPath, projectsPath, settingsPath, workspacePath } from "@/lib/nav";
import type { Herd } from "@/lib/spaces";
import { ASK, STATE_LABEL, awaits, historyCount, holds, orgTree, type NodeState, type OrgNode } from "@/lib/org-tree";
import { isOpenThread, projectForPane } from "@/lib/projects";
import { STATUS_LABEL, type AgentView, type ProjectView, type WorkspaceView } from "@/lib/types";

export interface SidebarRequest {
  target: "search";
  seq: number;
}

/**
 * Where the navigation is drawn. The desk's sidebar is Cursor's: New chat, Search, Home (which counts
 * what needs you) and Projects (ADR 0102), then its projects as flat rows and its chats by when they last moved;
 * the tree of projects and workspaces is its Search's, under the box until something is typed
 * (ADR 0080). A phone's Search sheet (the tab bar's) is also its browsing: under its box, until
 * something is typed, every project and workspace folded, the sessions and the host. Its drawer
 * (Home's or a chat's Nenu mark) leaves New and Search to its header and leads with what needs you
 * and the chats that moved last.
 */
export type SidebarVariant = "sidebar" | "sheet" | "drawer";

/**
 * The workbench navigation: its variant's lead, then projects (coordinators and their threads) and
 * the workspaces no project holds, and the host it all runs on.
 */
export function WorkbenchSidebar({ data, onNewChat, request, variant = "sidebar" }: {
  data: HomeData;
  variant?: SidebarVariant;
  onNewChat?: () => void;
  /** Each new `seq` opens search (⌘K, the rail, the tab bar). */
  request?: SidebarRequest;
}) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  // The pick is a row, not a place in the list: a poll that adds or drops a row leaves it where it was.
  const [picked, setPicked] = useState<string>();
  const [answered, setAnswered] = useState<{ query: string; order: Map<string, number> }>();
  const searchBox = useRef<HTMLInputElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // Where the tree was scrolled, so leaving a search lands back on the same rows.
  const treeScroll = useRef(0);
  const listId = useId();
  const navigate = useNavigate();
  const { pathname, key } = useLocation();
  const attention = needsYouCount(data);
  const phone = variant !== "sidebar";
  const order = answered?.query === query ? answered.order : undefined;
  const results: Array<SearchGroup | MachineSearchGroup> = searching ? [...navSearch(data, query, { order }), ...machineSearch(data, query, { order })] : [];
  const hits = results.flatMap((group) => group.hits);
  // A query's first answer fixes its order; the list only reorders when the query changes.
  if (searching && answered?.query !== query) setAnswered({ query, order: new Map(hits.map((hit, index) => [hit.key, index])) });
  const selected = Math.max(0, hits.findIndex((hit) => hit.key === picked));

  const target = request?.target;
  useEffect(() => {
    if (!target) return;
    setSearching(true);
    searchBox.current?.focus();
    searchBox.current?.select();
  }, [target, request?.seq]);

  const browsing = !query.trim();
  useLayoutEffect(() => {
    if (browsing && scroller.current) scroller.current.scrollTop = treeScroll.current;
  }, [browsing]);

  // The desk browses its tree under an empty box, so a press inside the list (a fold, a link) keeps it;
  // a press anywhere else gives the bar back. A phone's sheet closes an empty box when it loses focus.
  useEffect(() => {
    if (phone || !searching || !browsing) return;
    const onDown = (event: PointerEvent) => {
      if (!navigation.current?.contains(event.target as Node)) closeSearch();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [phone, searching, browsing]);

  function clearQuery() {
    setQuery("");
    setPicked(undefined);
    setAnswered(undefined);
  }

  function closeSearch() {
    clearQuery();
    setSearching(false);
  }

  // A pick ends the search once its page is on screen, so a slow chat keeps the picked row up saying
  // it is opening. A navigation the search did not make (the open chat's page replacing itself when
  // its pane closes) leaves a half-typed query alone.
  const picking = useRef(false);
  useEffect(() => {
    if (!picking.current) return;
    picking.current = false;
    closeSearch();
  }, [key]);

  /** Enter opens the picked result, the first one until an arrow moves the pick. */
  function openPicked() {
    const hit = hits[selected];
    if (!hit) return;
    picking.current = true;
    const group = results.find((g) => g.hits.includes(hit));
    navigate(group && "machine" in group ? hitPath(hit, group.machine.herd!, group.machine.session) : hitPath(hit, data, data.session));
  }

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      // On the Search sheet the box is the whole sheet: Escape clears what was typed and keeps the box,
      // and an empty box lets it go on to close the sheet.
      if (variant === "sheet" && !query) return;
      event.stopPropagation();
      if (variant === "sheet") clearQuery();
      else closeSearch();
    }
    if (event.key === "Enter" && !event.nativeEvent.isComposing) openPicked();
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && hits.length > 0) {
      event.preventDefault();
      setPicked(hits[Math.max(0, Math.min(hits.length - 1, selected + (event.key === "ArrowDown" ? 1 : -1)))]!.key);
    }
  }

  return (
    <nav ref={navigation} className="workbench-navigation" aria-label="Projects and chats" data-variant={variant} data-list={query.trim() ? "search" : "browse"}
      onKeyDown={(event) => { if (event.key === "Escape" && searching && !phone) closeSearch(); }}>
      {(!phone || searching) && <div className="nav-top">
        {!phone && <button type="button" className="nav-row" onClick={onNewChat} disabled={!onNewChat} aria-keyshortcuts="Meta+N">
          <SquarePen aria-hidden size={16} /><span className="nav-row-text">New chat</span><kbd className="nav-kbd" aria-hidden>⌘N</kbd>
        </button>}
        {searching ? (
          <label className="nav-row nav-search">
            <Search aria-hidden size={16} />
            <input ref={searchBox} type="search" autoFocus value={query} placeholder="Search" aria-label="Search projects and chats"
              aria-controls={hits.length ? listId : undefined} aria-autocomplete="list"
              aria-activedescendant={hits.length ? optionId(listId, selected) : undefined}
              onChange={(event) => { setQuery(event.target.value); setPicked(undefined); }}
              onBlur={phone ? () => { if (!query.trim()) closeSearch(); } : undefined}
              onKeyDown={onSearchKey} />
          </label>
        ) : !phone && (
          <button type="button" className="nav-row" onClick={() => setSearching(true)} aria-keyshortcuts="Meta+K">
            <Search aria-hidden size={16} /><span className="nav-row-text">Search</span><kbd className="nav-kbd" aria-hidden>⌘K</kbd>
          </button>
        )}
        {!phone && <Link className="nav-row" to={homePath(data.session)} aria-current={pathname === "/" ? "page" : undefined}
          aria-label={attention > 0 ? `Home, ${needYou(attention)}` : undefined}>
          <House aria-hidden size={16} /><span className="nav-row-text">Home</span>
          {attention > 0 && <span className="nav-row-meta" aria-hidden><StatusDot status="blocked" surface="bg-transparent" className="size-1.5" />{attention}</span>}
        </Link>}
        {!phone && <Link className="nav-row" to={projectsPath(data.session)} aria-current={pathname === "/projects" ? "page" : undefined}>
          <LayoutGrid aria-hidden size={16} /><span className="nav-row-text">Projects</span>
        </Link>}
      </div>}

      {/* A link followed from the desk's tree ends its search once the page is on screen, as a result does. */}
      <div ref={scroller} className="nav-scroll" onScroll={(event) => { if (browsing) treeScroll.current = event.currentTarget.scrollTop; }}
        onClickCapture={(event) => { if (searching && !phone && (event.target as Element).closest("a[href]")) picking.current = true; }}>
        {query.trim()
          ? <SearchResults groups={results} query={query} listId={listId} selected={selected} herd={data} session={data.session} onPick={setPicked}
              onOpen={() => { picking.current = true; }} />
          : phone
            ? <PhoneLists data={data} drawer={variant === "drawer"} onNewChat={onNewChat} />
            : searching ? <div className="nav-enter"><SidebarTree data={data} /><MachinesSlot data={data} place="nav" /></div>
            : <>
              {(data.projects?.length || data.agents.length)
                ? <DeskLists data={data} onNewProject={onNewChat && (() => openNewDialog({ kind: "project" }))} />
                : <Empty phone={false} />}
              <MachinesSlot data={data} place="nav" />
            </>}
      </div>

      {/* The host belongs to browsing: on a phone's Search sheet, until something is typed. */}
      {(!phone || !query.trim()) && <div className="nav-footer">
        <SessionSwitcher sessions={data.sessions ?? []} current={data.session} />
        <HostRow data={data} desk={!phone} />
      </div>}
    </nav>
  );
}

const optionId = (listId: string, index: number) => `${listId}-${index}`;

/** Where a search result opens: a project's page, a node's chat (or its detail when it runs nowhere), a pane's chat. */
function hitPath(hit: SearchHit, herd: Herd, session?: string): string {
  if (hit.kind === "project") return projectPath(hit.project.slug, session);
  if (hit.kind === "node") return hit.thread.paneId ? panePath(hit.thread.paneId, session) : nodePath(hit.project.slug, hit.thread.id, session);
  if (hit.kind === "workspace") return workspacePath(hit.workspace.workspaceId, herd, session);
  return panePath(hit.pane.paneId, session);
}

/** The search's matches as one list (Projects, Workspaces, then Chats), each row named as everywhere else with the match in semibold. */
function SearchResults({ groups, query, listId, selected, herd, session, onPick, onOpen }: {
  groups: Array<SearchGroup | MachineSearchGroup>;
  query: string;
  listId: string;
  selected: number;
  herd: Herd;
  session?: string;
  onPick: (key: string) => void;
  onOpen: () => void;
}) {
  useEffect(() => {
    document.getElementById(optionId(listId, selected))?.scrollIntoView?.({ block: "nearest" });
  }, [listId, selected]);
  if (groups.length === 0) return <p className="nav-empty">No matches for “{query.trim()}”</p>;
  let index = 0;
  return (
    <div role="listbox" id={listId} aria-label="Search results">
      {groups.map((group) => (
        <div key={"machine" in group ? `${group.label}@${group.machine.label}` : group.label} role="group"
          aria-label={"machine" in group ? `${group.label} on ${group.machine.label}` : group.label} className="nav-group">
          <div className="nav-label" aria-hidden>
            {group.label}{"machine" in group && <> · {group.machine.label}</>}
            {group.more > 0 && <span className="nav-label-end">{group.hits.length} of {group.hits.length + group.more}</span>}
          </div>
          {group.hits.map((hit) => {
            const at = index++;
            const to = "machine" in group ? hitPath(hit, group.machine.herd!, group.machine.session) : hitPath(hit, herd, session);
            return (
              <Link key={hit.key} id={optionId(listId, at)} role="option" aria-selected={at === selected} className="nav-pane nav-result"
                to={to} onClick={onOpen} onMouseMove={() => { if (at !== selected) onPick(hit.key); }}>
                <RowBody mark={<OpeningMark to={to}><HitMark hit={hit} /></OpeningMark>} title={<Highlight text={hit.title} query={query} />}
                  detail={<PlaceText place={hit.place} query={query} />} end={<span className="sr-only">, {hitState(hit)}</span>} />
              </Link>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function HitMark({ hit }: { hit: SearchHit }) {
  if (hit.kind === "project") return <ProjectGlyph slug={hit.project.slug} pick={hit.project} />;
  if (hit.kind === "node") return <NodeDot state={hit.state} />;
  if (hit.kind === "workspace") return <LayoutGrid aria-hidden size={14} />;
  return <PaneMark pane={hit.pane} />;
}

function hitState(hit: SearchHit): string {
  if (hit.kind === "project") return "project";
  if (hit.kind === "node") return STATE_LABEL[hit.state].toLowerCase();
  if (hit.kind === "workspace") return "workspace";
  return hit.pane.kind === "shell" ? "shell" : STATUS_LABEL[hit.pane.status];
}

/**
 * A phone's drawer or Search sheet before anything is typed. The drawer leads with the chats waiting on
 * you, above the projects, and ends with the ones that moved last, so a coordinator is a tap into its
 * project from the top (ADR 0110).
 */
function PhoneLists({ data, drawer, onNewChat }: { data: HomeData; drawer: boolean; onNewChat?: () => void }) {
  const { paneId } = useParams();
  const chats = drawer ? drawerSections(data, paneId) : undefined;
  const now = Date.now();
  const section = (label: string, rows: readonly DrawerChat[], counted: boolean) => rows.length > 0 && (
    <section aria-label={label} className="nav-group">
      <h3 className="nav-label">{label}{counted && <> <span className="nav-count">{rows.length}</span></>}</h3>
      {rows.map((chat) => <ChatRow key={chat.pane.paneId} pane={chat.pane} projects={data.projects} current={chat.current} now={now}
        session={data.session} />)}
    </section>
  );
  return <>
    {chats && section("Needs you", chats.needsYou, true)}
    <SidebarTree data={data} folded onNewChat={onNewChat} />
    {chats && section("Recent", chats.recent, false)}
    <MachinesSlot data={data} place="nav" />
  </>;
}

/**
 * Your asks, where a phone lists the projects, with how many wait on you; only when Organizations can
 * list asks (ADR 0091), so an older one leaves the lists as they were. A desk reads them on each project.
 */
function AsksRow({ data, current }: { data: HomeData; current: boolean }) {
  if (!asksAvailable(data.projects)) return null;
  const waiting = (data.projects ?? []).reduce((sum, project) => sum + (project.waitingAsks ?? 0), 0);
  return (
    <Link className="nav-row" to={asksPath(data.session)} aria-current={current ? "page" : undefined}
      aria-label={waiting > 0 ? `Your asks, ${waiting} ${waiting === 1 ? "waits" : "wait"} on you` : undefined}>
      <span className="nav-lead"><ListChecks aria-hidden size={16} /></span>
      <span className="nav-row-text">Your asks</span>
      {waiting > 0 && <span className="nav-row-meta" aria-hidden><StatusDot status="blocked" surface="bg-transparent" className="size-1.5" />{waiting}</span>}
    </Link>
  );
}

/**
 * Projects first, then the workspaces no project holds a pane in. `folded` is the phone's: every
 * project and workspace starts closed, and what the operator opens there lasts while the sheet does,
 * so the next open is compact again and the desk's remembered folds stay the desk's.
 */
function SidebarTree({ data, onNewChat, folded = false }: { data: HomeData; onNewChat?: () => void; folded?: boolean }) {
  const { paneId, projectSlug } = useParams();
  const { prefs, setExpanded, setWorkspaceOpen, setTabOpen } = useSidebarPrefs({ persist: !folded });
  const projects = data.projects ?? [];
  const loose = { ...data, ...looseWorkspaces(data) };
  const currentProject = projectSlug ?? projectForPane(data.projects, paneId)?.project.slug;
  useRevealProject(folded ? undefined : currentProject, setExpanded);
  const hasWorkspaces = workspaceTree(loose, paneId).length > 0;

  return <>
    {projects.length > 0 && (
      <section aria-label="Projects" className="nav-group">
        <h3 className="nav-label">Projects</h3>
        {folded && <AsksRow data={data} current={false} />}
        {projects.map((project) => (
          <ProjectSection key={project.slug} project={project} data={data} open={prefs.expanded[project.slug] ?? !folded} phone={folded}
            expanded={prefs.expanded} onExpand={setExpanded} panes={folded ? [] : projectPanes(data, project)} />
        ))}
      </section>
    )}
    {hasWorkspaces && (
      <section aria-label="Workspaces" className="nav-group">
        <h3 className="nav-label">Workspaces</h3>
        <WorkspaceTree source={loose} session={data.session} currentPaneId={paneId}
          expanded={prefs.workspaces} onExpand={setWorkspaceOpen} tabs={prefs.tabs} onTab={setTabOpen} startFolded={folded} />
      </section>
    )}
    {projects.length === 0 && !hasWorkspaces && <Empty phone={folded} onNewChat={onNewChat} />}
  </>;
}

/**
 * Workspaces no project holds a live pane in; all of them when there are no projects. A project's
 * panes are listed under the project, so the workspace tree leaves them out, and a workspace left
 * with only those (a bridge that did not report `workspaceIds`) is not loose either.
 */
export function looseWorkspaces(data: Pick<HomeData, "workspaces" | "projects" | "agents" | "shellPanes">): { workspaces: WorkspaceView[]; agents: AgentView[]; shellPanes: AgentView[] } {
  const held = new Set((data.projects ?? []).flatMap((project) => project.workspaceIds ?? []));
  const free = (pane: AgentView) => !projectForPane(data.projects, pane.paneId);
  const agents = data.agents.filter(free);
  const shellPanes = data.shellPanes.filter(free);
  const panes = [...data.agents, ...data.shellPanes];
  const workspaces = data.workspaces.filter((workspace) => {
    if (held.has(workspace.workspaceId)) return false;
    const inside = panes.filter((pane) => pane.workspaceId === workspace.workspaceId);
    return inside.length === 0 || inside.some(free);
  });
  return { workspaces, agents, shellPanes };
}

/** Arriving in a project reveals it once; collapsing it again afterwards is the operator's call. */
function useRevealProject(currentProject: string | undefined, setExpanded: (slug: string, open: boolean) => void) {
  const revealed = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!currentProject || revealed.current === currentProject) return;
    revealed.current = currentProject;
    setExpanded(currentProject, true);
  }, [currentProject, setExpanded]);
}

/**
 * The host Nenu reaches Herdr on, whether that link is up, and how much it holds. The desk's footer
 * names the host alone, as Cursor's names its account, behind the machine mark the composer uses and in
 * the column of the rows' icons: the link's dot and "Not connected" show only once Herdr is out of
 * reach. A phone names the host after Herdr; neither counts workspaces or agents, which are Home's to give.
 */
function HostRow({ data, desk }: { data: HomeData; desk: boolean }) {
  const connected = data.bridge === "connected" && !data.error;
  const { hostname } = window.location;
  // With more than one machine, the one on screen by Herdr's name for it; else as the browser names it.
  const host = currentMachine(data)?.label ?? (/^[\d.]+$|:/.test(hostname) ? hostname : hostname.split(".")[0] || "local");
  const meta = !connected ? "Not connected" : undefined;
  return (
    <div className="nav-host">
      {desk && connected
        ? <Laptop aria-hidden size={16} className="nav-host-mark" />
        : <span className={cn("nav-host-dot size-2 shrink-0 rounded-full", connected ? "bg-status-done" : "bg-status-blocked")} aria-hidden />}
      <span className="nav-host-text">
        <span className="nav-host-name">{desk ? host : `herdr · ${host}`}</span>
        {meta && <span className="nav-host-meta">{meta}</span>}
      </span>
      <Link className="workbench-icon-button" to={settingsPath(data.session)} aria-label="Settings"><Settings2 aria-hidden size={16} /></Link>
    </div>
  );
}

interface TreeFolds {
  /** Explicit folds, keyed by project slug, `slug/threadId` for a coordinator, and `slug/history`. */
  expanded: Record<string, boolean>;
  onExpand: (key: string, open: boolean) => void;
}

/** A tree row's word and its tone: red asks for you, blue is to review, green has merged and closes on its own. */
const NEEDS_TONE = "text-status-blocked";
const STATE_WORD: Partial<Record<NodeState, { word: string; tone: string }>> = {
  needs: { word: "needs you", tone: NEEDS_TONE }, review: { word: "review", tone: "text-primary" }, closing: { word: "merged", tone: "text-status-done" },
};

function ProjectSection({ project, data, open, expanded, onExpand, panes = [], phone = false }: TreeFolds & {
  project: ProjectView;
  data: HomeData;
  open: boolean;
  /**
   * A phone's drawer or Search sheet: the project opens on its coordinators, each a way into its page,
   * and the threads that work, wait on you or wait for a review; no count, no History (ADR 0110).
   */
  phone?: boolean;
  /** The project's workspace panes outside every thread, listed after its threads. */
  panes?: AgentView[];
}) {
  const { paneId, projectSlug, nodeId } = useParams();
  const listId = useId();
  const session = data.session;
  const status = project.coordinator?.liveStatus;
  const openCount = project.threads.filter(isOpenThread).length;
  const tree = orgTree(project.threads);
  const isCurrent = (node: OrgNode) => (node.thread.paneId !== undefined && node.thread.paneId === paneId) || (projectSlug === project.slug && nodeId === node.thread.id);
  // Open coordinators start open and resolved ones folded; the node on screen opens them.
  const branch = (node: OrgNode, depth: number): ReactNode => {
    const row = (fold?: ThreadRowFold) => <ThreadRow key={node.thread.id} node={node} depth={depth} slug={project.slug} session={session} current={isCurrent(node)}
      fold={fold} page={phone && node.thread.role === "coordinator"} />;
    if (phone) {
      const children = node.children.filter(shownOnPhone);
      return children.length ? <div key={node.thread.id} role="group" aria-label={node.thread.title}>{row()}{children.map((child) => branch(child, depth + 1))}</div> : row();
    }
    if (node.children.length === 0) return row();
    const key = `${project.slug}/${node.thread.id}`;
    const nodeOpen = expanded[key] ?? (node.state !== "resolved" || node.children.some((child) => holds(child, isCurrent)));
    return (
      <div key={node.thread.id} role="group" aria-label={node.thread.title}>
        {row({ open: nodeOpen, onToggle: () => onExpand(key, !nodeOpen) })}
        {nodeOpen && node.children.map((child) => branch(child, depth + 1))}
      </div>
    );
  };
  const historyKey = `${project.slug}/history`;
  const historyOpen = expanded[historyKey] ?? tree.history.some((node) => holds(node, isCurrent));
  const historyTotal = tree.resolved.coordinators + tree.resolved.threads;
  const history = historyPreview(tree.history, (node) => holds(node, isCurrent));
  // A phone opens the project's coordinator on its page, as it opens every coordinator; its page offers the chat.
  const coordinatorTo = phone ? nodePath(project.slug, "root", session) : panePath(project.coordinator?.paneId ?? "", session);
  return (
    <section aria-label={project.name} className="nav-project-section">
      <div className="nav-project">
        <Link className="nav-row" to={projectPath(project.slug, session)} aria-current={projectSlug === project.slug && !nodeId ? "page" : undefined}>
          <span className="nav-lead">
            <OpeningMark to={projectPath(project.slug, session)}>
              <ProjectGlyph slug={project.slug} pick={project} />
            </OpeningMark>
          </span>
          <span className="nav-row-text">{project.name}</span>
          {status && <StatusDot status={status} surface="bg-transparent" className="size-2" />}
          {status && <span className="sr-only">, coordinator {STATUS_LABEL[status]}</span>}
          {openCount > 0 && !phone && <span className="nav-count" aria-hidden>{openCount}</span>}
          {openCount > 0 && !phone && <span className="sr-only">{`, ${openCount} open ${openCount === 1 ? "task" : "tasks"}`}</span>}
        </Link>
        <button type="button" className="nav-disclosure nav-disclosure-end" aria-label={`${project.name} tasks`} aria-expanded={open} aria-controls={listId}
          onClick={() => onExpand(project.slug, !open)}>
          <ChevronRight aria-hidden size={14} />
        </button>
      </div>
      {open && (
        <div id={listId}>
          {project.coordinator && (
            <Link className="nav-row nav-tree-row" style={depthStyle(1)} to={coordinatorTo}
              aria-current={project.coordinator.paneId === paneId || (phone && projectSlug === project.slug && nodeId === "root") ? "page" : undefined}>
              <span className="nav-tree-mark"><OpeningMark to={coordinatorTo}><Workflow aria-hidden size={14} /></OpeningMark></span>
              <span className="nav-row-text">Coordinator</span>
              <span className="sr-only">, {STATUS_LABEL[project.coordinator.liveStatus]}</span>
              {isAttention(project.coordinator.liveStatus)
                ? <span className="nav-row-word text-status-blocked">needs you</span>
                : <span className="nav-row-note">{project.coordinator.agent}</span>}
            </Link>
          )}
          {(phone ? tree.open.filter(shownOnPhone) : tree.open).map((node) => branch(node, 1))}
          {panes.map((pane) => (
            <Link key={pane.paneId} className="nav-row nav-tree-row" style={depthStyle(1)} to={panePath(pane.paneId, session)}
              aria-current={pane.paneId === paneId ? "page" : undefined}>
              <span className="nav-tree-mark"><OpeningMark to={panePath(pane.paneId, session)}><PaneMark pane={pane} /></OpeningMark></span>
              <span className="nav-row-text">{displayName(pane, data.projects)}</span>
              {pane.kind !== "shell" && <span className="sr-only">, {STATUS_LABEL[pane.status]}</span>}
              <span className="nav-row-note">{pane.kind === "shell" ? "shell" : pane.agent}</span>
            </Link>
          ))}
          {!phone && tree.history.length > 0 && <>
            <button type="button" className="nav-row nav-history" aria-expanded={historyOpen}
              title={`History · ${historyCount(tree.resolved)}`} onClick={() => onExpand(historyKey, !historyOpen)}>
              <ChevronRight aria-hidden size={14} />History <span className="nav-count">{historyTotal}</span>
            </button>
            {historyOpen && history.map((node) => branch(node, 2))}
            {historyOpen && history.length < tree.history.length && (
              <Link className="nav-row nav-tree-row nav-history-all" style={depthStyle(2)} to={projectPath(project.slug, session)}>
                <span className="nav-row-text">Show all {historyTotal} in project</span><ChevronRight aria-hidden size={14} />
              </Link>
            )}
          </>}
        </div>
      )}
    </section>
  );
}

/** What a phone's project lists: its coordinators, and the threads that work or wait on you. */
const shownOnPhone = (node: OrgNode): boolean => node.thread.role === "coordinator" || node.state === "needs" || node.state === "working" || node.state === "review";

/** How many resolved nodes the sidebar's History lists before handing the rest to the project page. */
const HISTORY_PREVIEW = 5;

/**
 * History as the sidebar shows it: the nodes that moved last, plus any holding what is on screen,
 * still in the tree's own order (coordinators first, newest first).
 */
function historyPreview(history: OrgNode[], onScreen: (node: OrgNode) => boolean): OrgNode[] {
  if (history.length <= HISTORY_PREVIEW) return history;
  const updated = (node: OrgNode) => Date.parse(node.thread.updated ?? "") || 0;
  const keep = new Set([...history].sort((a, b) => updated(b) - updated(a)).slice(0, HISTORY_PREVIEW));
  return history.filter((node) => keep.has(node) || onScreen(node));
}

/** Panes in a project's workspaces that run neither its coordinator nor one of its threads. */
function projectPanes(data: HomeData, project: ProjectView): AgentView[] {
  const held = new Set(project.workspaceIds ?? []);
  if (held.size === 0) return [];
  return [...data.agents, ...data.shellPanes].filter((pane) => held.has(pane.workspaceId) && !projectForPane(data.projects, pane.paneId));
}

const depthStyle = (depth: number) => ({ "--nav-depth": depth }) as CSSProperties;

interface ThreadRowFold {
  open: boolean;
  onToggle: () => void;
}

/** A node's row: its chat when it runs in a live pane, its detail otherwise, or with `page` its page; never the project page. */
function ThreadRow({ node, depth, slug, session, current, fold, page = false }: {
  node: OrgNode;
  depth: number;
  slug: string;
  session?: string;
  current: boolean;
  /** Present on a coordinator with nodes under it. */
  fold?: ThreadRowFold;
  page?: boolean;
}) {
  const { thread, state } = node;
  const ask = awaits(thread);
  const word = ask ? { word: ASK[ask].word, tone: NEEDS_TONE } : STATE_WORD[state];
  // "not running" only beside a quiet dot: a node whose last group says working keeps its dot's word.
  const note = thread.paneId || state === "resolved" || (thread.status === "open" && state !== "idle") ? undefined : thread.status === "open" ? "not running" : thread.status;
  const to = thread.paneId && !page ? panePath(thread.paneId, session) : nodePath(slug, thread.id, session);
  return (
    <div className="nav-thread">
      {fold && (
        <button type="button" className="nav-disclosure" style={depthStyle(depth)} aria-label={`${thread.title} threads`} aria-expanded={fold.open}
          onClick={fold.onToggle}>
          <ChevronRight aria-hidden size={13} />
        </button>
      )}
      <Link className={cn("nav-row nav-tree-row", fold && "nav-tree-head", state === "resolved" && "nav-tree-resolved")} style={depthStyle(depth)}
        to={to} aria-current={current ? "page" : undefined}>
        <span className="nav-tree-mark"><OpeningMark to={to}><NodeDot state={state} /></OpeningMark></span>
        <span className="nav-row-text">{thread.title}</span>
        <span className="sr-only">, {ask ? ASK[ask].word : STATE_LABEL[state].toLowerCase()}</span>
        {fold && state !== "resolved" && <span className="nav-dots" aria-hidden>{node.children.slice(0, 6).map((child) => <NodeDot key={child.thread.id} state={child.state} className="size-1.5" />)}</span>}
        {word && <span aria-hidden className={cn("nav-row-word", word.tone)}>{word.word}</span>}
        {note && !word && !fold && <span className="nav-row-note">{note}</span>}
        {page && <ChevronRight aria-hidden size={14} className="shrink-0 text-muted-foreground" />}
      </Link>
    </div>
  );
}

/**
 * An empty herd. On the desk Home sits beside the sidebar and leads the start, so the sidebar only
 * says so; a phone's sheet or drawer, which has no New row, offers the way to start.
 */
function Empty({ phone, onNewChat }: { phone: boolean; onNewChat?: () => void }) {
  if (!phone) return <p className="nav-empty">No agents yet.</p>;
  return (
    <EmptyState className="px-2.5 py-8" title="No agents yet"
      action={onNewChat && <Button type="button" onClick={onNewChat}><Plus aria-hidden />New agent</Button>}>
      Agents you start in Herdr show up here too.
    </EmptyState>
  );
}
