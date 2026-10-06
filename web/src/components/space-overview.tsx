import { useState } from "react";
import { ChevronRight, Folder, Search, Terminal } from "lucide-react";

import { cn } from "@/lib/utils";
import { StatusDot } from "@/components/status-badge";
import { filterSpaces, groupPanesByTab, sortSpacesByRecency, spaceLastSeenMap, spaceTriageMap } from "@/lib/spaces";
import { TRIAGE_STATUS } from "@/lib/triage";
import { timeAgo } from "@/lib/format";
import { paneDisplayName, STATUS_LABEL } from "@/lib/types";
import type { AgentView, TabView, WorkspaceView } from "@/lib/types";

interface SpaceOverviewProps {
  workspaces: WorkspaceView[];
  /** The bridge's tab metadata, kept separate from panes so empty tabs remain visible. */
  tabs: TabView[];
  agents: AgentView[];
  /** Bare shells too — a space you only ever opened a shell in still counts as used. */
  shellPanes?: AgentView[];
  onOpen: (workspaceId: string) => void;
  /** Open a pane from the nested tree without changing the workspace's fold state first. */
  onOpenPane: (paneId: string) => void;
  /** Fold state, owned by the dashboard so it can be persisted. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// The dashboard's navigator, and the LAST section on the page: everything you might act on comes
// first. It folds to a single line — with 45 spaces that's the difference between a dashboard and a
// scroll — and expands to a recency-ordered, filterable workspace → tab → pane tree.
export function SpaceOverview({
  workspaces,
  tabs,
  agents,
  shellPanes = [],
  onOpen,
  onOpenPane,
  open,
  onOpenChange,
}: SpaceOverviewProps) {
  // Ephemeral view state, like SpaceRoute's tab selection — a filter you typed yesterday should not
  // greet you today with most of your spaces missing.
  const [query, setQuery] = useState("");

  const panes = [...agents, ...shellPanes];
  // One pass over the panes, then map lookups — this component re-renders on every poll.
  const lastSeen = spaceLastSeenMap(panes);
  // One pass for "what's the most urgent thing in each space", shared with the chips so a row and a
  // chip can never mean different things by the same colour (lib/spaces.ts).
  const worstBySpace = spaceTriageMap(agents);
  const blockedSpaces = [...worstBySpace.values()].filter((b) => b === "needs").length;
  const visible = filterSpaces(sortSpacesByRecency(workspaces, panes, lastSeen), query);
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Record<string, boolean>>({});
  const [expandedTabs, setExpandedTabs] = useState<Record<string, boolean>>({});

  const groups = visible.map((workspace) => ({
    workspace,
    tabs: navigationTabs(workspace.workspaceId, tabs, agents, shellPanes),
  }));

  const count = query.trim() ? visible.length : workspaces.length;
  const row = "flex min-h-11 w-full min-w-0 items-center gap-3 rounded-md px-2 text-left transition-colors hover:bg-[var(--workbench-row-hover)]";

  // Same quiet list as Home's projects and chats: a plain label, hairline-separated rows, dots for
  // status. Only the dot and its word say a space needs you; no row is tinted or carded.
  return (
    <section aria-labelledby="home-workspaces" className="mb-10">
      <div className="flex items-center gap-1">
        <h2 id="home-workspaces" className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => onOpenChange(!open)}
            aria-expanded={open}
            {...(open ? { "aria-controls": "spaces-body" } : {})}
            className="flex min-h-11 w-full items-center gap-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} aria-hidden />
            Workspaces{" "}
            {/* While filtering, the count reports what you can SEE. */}
            <span className="tabular-nums">{count}</span>
          </button>
        </h2>
        {/* Why you'd bother expanding — stays visible while folded. */}
        {blockedSpaces > 0 && (
          <span
            className="flex items-center gap-1.5 px-1 text-xs tabular-nums text-muted-foreground"
            aria-label={`${blockedSpaces} ${blockedSpaces === 1 ? "space needs" : "spaces need"} you`}
          >
            <StatusDot status="blocked" className="size-2" />
            {blockedSpaces}
          </span>
        )}
      </div>

      {open && (
        <div id="spaces-body">
          {/* Deliberately NOT autofocused: on a phone that would throw the keyboard over the list.
              Sticky: at 45 spaces a filter that scrolls away turns into scroll-up, type, scroll-down. */}
          {workspaces.length > 1 && (
            <label className="nav-row nav-search sticky top-0 z-10 mb-1">
              <Search className="size-4 shrink-0" aria-hidden />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter workspaces"
                aria-label="Filter spaces"
                className="placeholder:text-muted-foreground"
              />
            </label>
          )}

          {workspaces.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">No workspaces yet.</p>
          ) : visible.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">No workspace matches “{query}”.</p>
          ) : (
            <ul className="divide-y divide-border/70 border-y border-border/70">
              {groups.map(({ workspace: w, tabs: workspaceTabs }) => {
                const bucket = worstBySpace.get(w.workspaceId);
                const status = bucket ? TRIAGE_STATUS[bucket] : null;
                const seen = lastSeen.get(w.workspaceId) ?? 0;
                const name = w.label || `Workspace ${w.number}`;
                const workspaceCanExpand = workspaceTabs.length > 1;
                const workspaceOpen = !workspaceCanExpand || (expandedWorkspaces[w.workspaceId] ?? true);
                const workspaceBodyId = treeSectionId("workspace", w.workspaceId);
                return (
                  <li key={w.workspaceId} className="py-1">
                    <div className="flex min-w-0 items-center">
                      <button type="button" onClick={() => onOpen(w.workspaceId)} aria-label={`Open workspace ${name}`} className={cn(row, "min-h-12")}>
                        <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{w.label}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            <span aria-label={`${w.paneCount} ${w.paneCount === 1 ? "pane" : "panes"}`}>
                              {w.paneCount} {w.paneCount === 1 ? "pane" : "panes"}
                            </span>
                            {seen > 0 && <span className="tabular-nums"> · {timeAgo(seen)}</span>}
                          </span>
                        </span>
                        {status && <StatusDot status={status} surface="bg-transparent" className="size-2" />}
                        {/* The dot alone is colour-only; give SR users the status word. */}
                        {status && <span className="sr-only">{STATUS_LABEL[status]}</span>}
                      </button>
                      {workspaceCanExpand && (
                        <button
                          type="button"
                          aria-label={`${workspaceOpen ? "Collapse" : "Expand"} workspace ${name}`}
                          aria-expanded={workspaceOpen}
                          aria-controls={workspaceBodyId}
                          className="grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--workbench-row-hover)] hover:text-foreground"
                          onClick={() => setExpandedWorkspaces((current) => ({
                            ...current,
                            [w.workspaceId]: !(current[w.workspaceId] ?? true),
                          }))}
                        >
                          <ChevronRight className={cn("size-4 transition-transform", workspaceOpen && "rotate-90")} aria-hidden />
                        </button>
                      )}
                    </div>
                    <div id={workspaceBodyId} hidden={!workspaceOpen} className="pl-7">
                      {workspaceTabs.map((tab) => {
                        // Tab ids are normally globally unique, but older bridges scoped them to the
                        // workspace. Keep both the fold state and controlled region collision-free.
                        const tabStateKey = `${w.workspaceId}/${tab.tabId}`;
                        const tabCanExpand = tab.panes.length > 1;
                        const tabOpen = !tabCanExpand || (expandedTabs[tabStateKey] ?? true);
                        const tabBodyId = treeSectionId("tab", tabStateKey);
                        const onlyPane = tab.panes[0];
                        return (
                          <div key={tab.tabId} className="min-w-0">
                            {tabCanExpand ? (
                              <button
                                type="button"
                                aria-label={`${tabOpen ? "Collapse" : "Expand"} tab ${tab.label}`}
                                aria-expanded={tabOpen}
                                aria-controls={tabBodyId}
                                className={cn(row, "gap-2 text-sm")}
                                onClick={() => setExpandedTabs((current) => ({
                                  ...current,
                                  [tabStateKey]: !(current[tabStateKey] ?? true),
                                }))}
                              >
                                <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", tabOpen && "rotate-90")} aria-hidden />
                                <span className="min-w-0 flex-1 truncate">{tab.label}</span>
                                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{tab.paneCount} panes</span>
                              </button>
                            ) : onlyPane ? (
                              <button
                                type="button"
                                onClick={() => onOpenPane(onlyPane.paneId)}
                                aria-label={`Open tab ${tab.label}, pane ${paneLabel(onlyPane)}`}
                                className={cn(row, "gap-2")}
                              >
                                <PaneMark pane={onlyPane} />
                                <span className="min-w-0 flex-1 truncate text-sm">
                                  {tab.label} <span className="text-muted-foreground">· {paneLabel(onlyPane)}</span>
                                </span>
                                <span className="shrink-0 text-xs text-muted-foreground">{STATUS_LABEL[onlyPane.status]}</span>
                              </button>
                            ) : (
                              <div className={cn(row, "gap-2 text-sm text-muted-foreground hover:bg-transparent")}>
                                <span className="min-w-0 flex-1 truncate">{tab.label}</span>
                                <span className="text-xs">Empty</span>
                              </div>
                            )}
                            {tabCanExpand && <div id={tabBodyId} hidden={!tabOpen} className="pl-5">
                              {tab.panes.map((pane) => (
                                <button
                                  key={pane.paneId}
                                  type="button"
                                  onClick={() => onOpenPane(pane.paneId)}
                                  aria-label={`Open pane ${paneLabel(pane)}`}
                                  title={`${paneLabel(pane)} · ${pane.agent} · ${STATUS_LABEL[pane.status]}`}
                                  className={cn(row, "gap-2 text-sm text-muted-foreground hover:text-foreground")}
                                >
                                  <PaneMark pane={pane} />
                                  <span className="min-w-0 flex-1 truncate">{paneLabel(pane)}</span>
                                  <span className="sr-only">{STATUS_LABEL[pane.status]}</span>
                                </button>
                              ))}
                            </div>}
                          </div>
                        );
                      })}
                      {workspaceTabs.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">No tabs yet</p>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/** A shell gets the terminal glyph; an agent its status dot, in the same 14px slot. */
function PaneMark({ pane }: { pane: AgentView }) {
  return pane.kind === "shell"
    ? <Terminal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
    : <span className="grid size-3.5 shrink-0 place-items-center"><StatusDot status={pane.status} surface="bg-transparent" className="size-1.5" /></span>;
}

interface NavigationTab extends TabView {
  panes: AgentView[];
}

function navigationTabs(
  workspaceId: string,
  tabs: TabView[],
  agents: AgentView[],
  shellPanes: AgentView[],
): NavigationTab[] {
  return groupPanesByTab(workspaceId, tabs, agents, shellPanes).map((group, index) => {
    const declared = tabs.find((tab) => tab.tabId === group.tabId);
    if (declared) {
      return {
        ...declared,
        label: declared.label || `Tab ${declared.number}`,
        panes: group.panes,
      };
    }
    return {
      tabId: group.tabId,
      workspaceId,
      number: index + 1,
      label: group.label === "…" ? "Other panes" : group.label || `Tab ${index + 1}`,
      focused: false,
      paneCount: group.panes.length,
      panes: group.panes,
    };
  });
}

function paneLabel(pane: AgentView): string {
  return pane.paneLabel || pane.sessionName || pane.tabLabel || pane.terminalTitle || paneDisplayName(pane);
}

function treeSectionId(kind: "workspace" | "tab", id: string): string {
  return `spaces-${kind}-${encodeURIComponent(id)}`;
}
