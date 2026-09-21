import { useState } from "react";
import { ChevronRight, Folder, FolderPlus, LayoutGrid, Search, Terminal } from "lucide-react";

import { cn } from "@/lib/utils";
import { SectionHeader } from "@/components/section-header";
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
  onNewSpace: () => void;
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
  onNewSpace,
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

  return (
    <section className="flex flex-col gap-2 px-3 py-4">
      <SectionHeader
        label="Workspaces"
        // While filtering, the count reports what you can SEE — a header reading (45) above four
        // rows makes you doubt the filter rather than trust it.
        count={query.trim() ? visible.length : workspaces.length}
        open={open}
        onToggle={onOpenChange}
        controls="spaces-body"
        trailing={
          <>
            {/* Why you'd bother expanding — stays visible while folded. */}
            {blockedSpaces > 0 && (
              <span
                className="flex items-center gap-1 text-[11px] font-semibold tabular-nums text-status-blocked"
                aria-label={`${blockedSpaces} ${blockedSpaces === 1 ? "space needs" : "spaces need"} you`}
              >
                <span className="size-2 rounded-full bg-status-blocked" aria-hidden />
                {blockedSpaces}
              </span>
            )}
            <button
              type="button"
              onClick={onNewSpace}
              aria-label="New space"
              className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-95"
            >
              <FolderPlus className="size-4" />
            </button>
          </>
        }
      />

      {open && (
        <div id="spaces-body" className="flex flex-col gap-3">
          {/* Deliberately NOT autofocused: on a phone that would throw the keyboard over the list
              you just asked to see. */}
          {/* Sticky: at 45 spaces the list is five screens, and a filter that scrolls away turns
              "wrong part of the list" into scroll-up, type, scroll-down. */}
          {workspaces.length > 1 && (
            <label className="sticky top-0 z-10 flex items-center gap-2 rounded-lg border bg-card px-3 py-2 shadow-sm">
              <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter spaces…"
                aria-label="Filter spaces"
                // min-h-9 so the control itself clears the 36px touch floor, not just its padded label.
                className="min-h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </label>
          )}

          {workspaces.length === 0 ? (
            <p className="px-1 py-6 text-center text-sm text-muted-foreground">No spaces yet.</p>
          ) : visible.length === 0 ? (
            <p className="px-1 py-6 text-center text-sm text-muted-foreground">
              No space matches “{query}”.
            </p>
          ) : (
            groups.map(({ workspace: w, tabs: workspaceTabs }) => {
              const bucket = worstBySpace.get(w.workspaceId);
              const status = bucket ? TRIAGE_STATUS[bucket] : null;
              const blocked = bucket === "needs";
              const seen = lastSeen.get(w.workspaceId) ?? 0;
              const workspaceCanExpand = workspaceTabs.length > 1;
              const workspaceOpen = !workspaceCanExpand || (expandedWorkspaces[w.workspaceId] ?? true);
              const workspaceBodyId = treeSectionId("workspace", w.workspaceId);
              return (
                <div
                  key={w.workspaceId}
                  className={cn(
                    "min-w-0 overflow-hidden rounded-xl border bg-card shadow-sm",
                    blocked && "border-status-blocked/40",
                  )}
                >
                  <div className="flex min-w-0 items-center gap-1 p-1.5">
                    {workspaceCanExpand && (
                      <button
                        type="button"
                        aria-label={`${workspaceOpen ? "Collapse" : "Expand"} workspace ${w.label || `Workspace ${w.number}`}`}
                        aria-expanded={workspaceOpen}
                        aria-controls={workspaceBodyId}
                        className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-95"
                        onClick={() => setExpandedWorkspaces((current) => ({
                          ...current,
                          [w.workspaceId]: !(current[w.workspaceId] ?? true),
                        }))}
                      >
                        <ChevronRight className={cn("size-4 transition-transform", workspaceOpen && "rotate-90")} aria-hidden />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onOpen(w.workspaceId)}
                      aria-label={`Open workspace ${w.label || `Workspace ${w.number}`}`}
                      className={cn(
                        // Square, like the herd rows: this is a divide-y list, and a rounded fill under
                        // a straight hairline reads as a fault. The blocked row below has a real border,
                        // so it keeps its radius.
                        "flex min-h-12 min-w-0 flex-1 flex-row items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors active:scale-[0.99]",
                        blocked
                          ? "border border-status-blocked/40 bg-status-blocked/5"
                          : "hover:bg-muted/50",
                      )}
                    >
                      {/* Flat rows, not cards: these are single-line entries, so a card is 100% chrome
                          around one string, forty-five times. Card treatment is reserved for the agent
                          sections that mean "a human is required here". A blocked space still gets the
                          tint — that's the one cue worth the weight. */}
                      <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      {status ? (
                        <>
                          <StatusDot status={status} />
                          {/* The dot alone is colour-only; give SR users the status word. */}
                          <span className="sr-only">{STATUS_LABEL[status]}</span>
                        </>
                      ) : (
                        <span className="size-2.5 shrink-0 rounded-full border border-muted-foreground/40" />
                      )}
                      <span className="min-w-0 flex-1 truncate font-medium">{w.label}</span>
                      {/* One count plus a relative time is what a 390px row has room for — the tab
                          count went, the pane count is the useful one. */}
                      <span
                        aria-label={`${w.paneCount} ${w.paneCount === 1 ? "pane" : "panes"}`}
                        className="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium tabular-nums text-muted-foreground"
                      >
                        <LayoutGrid className="size-3.5" aria-hidden />
                        {w.paneCount}
                      </span>
                      {seen > 0 && (
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {timeAgo(seen)}
                        </span>
                      )}
                    </button>
                  </div>
                  <div id={workspaceBodyId} hidden={!workspaceOpen} className="border-t border-border/60 bg-muted/15 p-2">
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
                              className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-lg px-3 text-left text-sm font-medium transition-colors hover:bg-muted active:scale-[0.99]"
                              onClick={() => setExpandedTabs((current) => ({
                                ...current,
                                [tabStateKey]: !(current[tabStateKey] ?? true),
                              }))}
                            >
                              <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", tabOpen && "rotate-90")} aria-hidden />
                              <span className="min-w-0 flex-1 truncate">{tab.label}</span>
                              <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">{tab.paneCount} panes</span>
                            </button>
                          ) : onlyPane ? (
                            <button
                              type="button"
                              onClick={() => onOpenPane(onlyPane.paneId)}
                              aria-label={`Open tab ${tab.label}, pane ${paneLabel(onlyPane)}`}
                              className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-lg px-3 text-left transition-colors hover:bg-muted active:scale-[0.99]"
                            >
                              {onlyPane.kind === "shell" ? <Terminal className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : <span className="workbench-status-dot" data-status={onlyPane.status} aria-hidden />}
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium">{tab.label}</span>
                                <span className="block truncate text-xs text-muted-foreground">{paneLabel(onlyPane)}</span>
                              </span>
                              <span className="text-[11px] text-muted-foreground">{STATUS_LABEL[onlyPane.status]}</span>
                            </button>
                          ) : (
                            <div className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm text-muted-foreground">
                              <span className="min-w-0 flex-1 truncate">{tab.label}</span>
                              <span className="text-[11px]">Empty</span>
                            </div>
                          )}
                          {tabCanExpand && <div id={tabBodyId} hidden={!tabOpen} className="grid gap-1 pl-5">
                            {tab.panes.map((pane) => (
                              <button
                                key={pane.paneId}
                                type="button"
                                onClick={() => onOpenPane(pane.paneId)}
                                aria-label={`Open pane ${paneLabel(pane)}`}
                                title={`${paneLabel(pane)} · ${pane.agent} · ${STATUS_LABEL[pane.status]}`}
                                className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-lg px-3 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-[0.99]"
                              >
                                {pane.kind === "shell" ? <Terminal className="size-3.5 shrink-0" aria-hidden /> : <span className="workbench-status-dot" data-status={pane.status} aria-hidden />}
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
                </div>
              );
            })
          )}
        </div>
      )}
    </section>
  );
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
