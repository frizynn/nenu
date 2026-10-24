import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { House, Laptop, LayoutGrid, Plus, Search, Settings2, SquarePen } from "@/components/ui/icon";

import { DeskLists } from "@/components/desk-nav";
import { SessionSwitcher } from "@/components/session-switcher";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusDot } from "@/components/status-badge";
import { ChatRow, Highlight, OpeningMark, PaneMark, PlaceText, RowBody } from "@/components/nav-rows";
import { WorkspaceTree } from "@/components/workspace-tree";
import { MachinesSlot } from "@/components/machines-slot";
import { cn } from "@/lib/utils";
import { workspaceTree } from "@/lib/workspace-tree";
import { navSearch, type SearchGroup, type SearchHit } from "@/lib/nav-search";
import { currentMachine, machineSearch, type MachineSearchGroup } from "@/lib/machines";
import { useSidebarPrefs } from "@/hooks/use-sidebar-prefs";
import { drawerSections, type DrawerChat } from "@/lib/nav-drawer";
import { needsYouCount, needYou } from "@/lib/home-stats";
import type { HomeData } from "@/lib/loaders";
import { homePath, panePath, settingsPath, workspacePath } from "@/lib/nav";
import type { Herd } from "@/lib/spaces";
import { STATUS_LABEL } from "@/lib/types";

export interface SidebarRequest {
  target: "search";
  seq: number;
}

/**
 * Where the navigation is drawn. The desk's sidebar is Cursor's: New chat, Search, Home (which counts
 * what needs you), then its chats by when they last moved; the tree of workspaces is its Search's,
 * under the box until something is typed (ADR 0080). A phone's Search sheet (the tab bar's) is also
 * its browsing: under its box, until something is typed, every workspace folded, the sessions and the
 * host. Its drawer (Home's or a chat's Nenu mark) leaves New and Search to its header and leads with
 * what needs you and the chats that moved last.
 */
export type SidebarVariant = "sidebar" | "sheet" | "drawer";

/** The workbench navigation: its variant's lead, then the workspaces, and the host it all runs on. */
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
    <nav ref={navigation} className="workbench-navigation" aria-label="Workspaces and chats" data-variant={variant} data-list={query.trim() ? "search" : "browse"}
      onKeyDown={(event) => { if (event.key === "Escape" && searching && !phone) closeSearch(); }}>
      {(!phone || searching) && <div className="nav-top">
        {!phone && <button type="button" className="nav-row" onClick={onNewChat} disabled={!onNewChat} aria-keyshortcuts="Meta+N">
          <SquarePen aria-hidden size={16} /><span className="nav-row-text">New chat</span><kbd className="nav-kbd" aria-hidden>⌘N</kbd>
        </button>}
        {searching ? (
          <label className="nav-row nav-search">
            <Search aria-hidden size={16} />
            <input ref={searchBox} type="search" autoFocus value={query} placeholder="Search" aria-label="Search workspaces and chats"
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
          {attention > 0 && <span className="nav-row-meta" aria-hidden><StatusDot status="blocked" />{attention}</span>}
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
              {data.agents.length ? <DeskLists data={data} /> : <Empty phone={false} />}
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

/** Where a search result opens: a workspace's pane, or a pane's chat. */
function hitPath(hit: SearchHit, herd: Herd, session?: string): string {
  if (hit.kind === "workspace") return workspacePath(hit.workspace.workspaceId, herd, session);
  return panePath(hit.pane.paneId, session);
}

/** The search's matches as one list (Workspaces, then Chats), each row named as everywhere else with the match in semibold. */
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
  if (hit.kind === "workspace") return <LayoutGrid aria-hidden size={14} />;
  return <PaneMark pane={hit.pane} />;
}

function hitState(hit: SearchHit): string {
  if (hit.kind === "workspace") return "workspace";
  return hit.pane.kind === "shell" ? "shell" : STATUS_LABEL[hit.pane.status];
}

/**
 * A phone's drawer or Search sheet before anything is typed. The drawer leads with the chats waiting on
 * you, above the workspaces, and ends with the ones that moved last.
 */
function PhoneLists({ data, drawer, onNewChat }: { data: HomeData; drawer: boolean; onNewChat?: () => void }) {
  const { paneId } = useParams();
  const chats = drawer ? drawerSections(data, paneId) : undefined;
  const now = Date.now();
  const section = (label: string, rows: readonly DrawerChat[], counted: boolean) => rows.length > 0 && (
    <section aria-label={label} className="nav-group">
      <h3 className="nav-label">{label}{counted && <> <span className="nav-count">{rows.length}</span></>}</h3>
      {rows.map((chat) => <ChatRow key={chat.pane.paneId} pane={chat.pane} current={chat.current} now={now}
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
 * The workspaces. `folded` is the phone's: every workspace starts closed, and what the operator opens
 * there lasts while the sheet does, so the next open is compact again and the desk's remembered folds
 * stay the desk's.
 */
function SidebarTree({ data, onNewChat, folded = false }: { data: HomeData; onNewChat?: () => void; folded?: boolean }) {
  const { paneId } = useParams();
  const { prefs, setWorkspaceOpen, setTabOpen } = useSidebarPrefs({ persist: !folded });
  if (workspaceTree(data, paneId).length === 0) return <Empty phone={folded} onNewChat={onNewChat} />;
  return (
    <section aria-label="Workspaces" className="nav-group">
      <h3 className="nav-label">Workspaces</h3>
      <WorkspaceTree source={data} session={data.session} currentPaneId={paneId}
        expanded={prefs.workspaces} onExpand={setWorkspaceOpen} tabs={prefs.tabs} onTab={setTabOpen} startFolded={folded} />
    </section>
  );
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
        : <span className={cn("nav-host-dot size-1.5 shrink-0 rounded-full", connected ? "bg-status-done" : "bg-status-blocked")} aria-hidden />}
      <span className="nav-host-text">
        <span className="nav-host-name">{desk ? host : `herdr · ${host}`}</span>
        {meta && <span className="nav-host-meta">{meta}</span>}
      </span>
      <Link className="workbench-icon-button" to={settingsPath(data.session)} aria-label="Settings"><Settings2 aria-hidden size={16} /></Link>
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
