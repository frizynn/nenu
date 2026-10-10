import { useState } from "react";
import { Link } from "react-router";
import { Ellipsis, Plus, Terminal } from "lucide-react";

import { TasksHeader } from "@/components/project-tasks";
import { StatusDot } from "@/components/status-badge";
import { TabActionsSheet } from "@/components/tab-actions-sheet";
import { Chip } from "@/components/ui/chip";
import { shortCwd, tildeHome, timeAgoShort } from "@/lib/format";
import { panePath } from "@/lib/nav";
import { groupPanesByTab, neighborTab, shownTab, tabName, workspaceFolder, workspaceName } from "@/lib/spaces";
import { worstTriage } from "@/lib/triage";
import { STATUS_LABEL, type AgentView, type TabView, type WorkspaceView } from "@/lib/types";
import { paneSubject } from "@/lib/workspace-tree";

interface SpaceViewProps {
  workspace: WorkspaceView;
  tabs: TabView[];
  agents: AgentView[];
  shellPanes: AgentView[];
  onNewTab: () => void;
  /** After a rename or close lands, so the snapshot catches up. */
  onChanged: () => void;
  session?: string;
  readOnly?: boolean;
  now?: number;
}

/**
 * The tab last shown in each workspace, so Back from a pane lands on it. In memory, not in the URL:
 * a search param is a navigation, which waits on a snapshot read before the tab can change.
 */
const lastShownTab = new Map<string, string>();

/** Forget every remembered tab, for tests. */
export function __resetShownTabs(): void {
  lastShownTab.clear();
}

/**
 * A workspace as Herdr holds it: its name and folder, its tabs, and the selected tab's panes, each
 * one tap from its chat. The selected tab's rename and close sit behind the ⋯ at the end of the tab
 * row, and behind a tap on the selected tab, as in a pane's own tab bar.
 */
export function SpaceView({
  workspace,
  tabs,
  agents,
  shellPanes,
  onNewTab,
  onChanged,
  session,
  readOnly,
  now = Date.now(),
}: SpaceViewProps) {
  const [picked, setPicked] = useState(() => lastShownTab.get(workspace.workspaceId) ?? null);
  const [sheetTab, setSheetTab] = useState<TabView | null>(null);
  const pick = (tabId: string) => {
    lastShownTab.set(workspace.workspaceId, tabId);
    setPicked(tabId);
  };
  const groups = groupPanesByTab(workspace.workspaceId, tabs, agents, shellPanes);
  const shown = shownTab(groups, picked, workspace.activeTabId);
  const shownRecord = tabs.find((t) => t.tabId === shown?.tabId);
  const shownName = shown ? tabName(shown.label, groups.indexOf(shown) + 1) : "";
  const folder = workspaceFolder(groups.flatMap((g) => g.panes));

  return (
    <>
      <TasksHeader
        title={workspaceName(workspace)}
        subtitle={folder && <span className="font-mono text-xs" title={tildeHome(folder)}>{shortCwd(folder, 44)}</span>}
        // A box the title's line height, so the taller touch target centres on the title.
        action={<div className="flex h-7 shrink-0 items-center">
          <button type="button" className="quiet-action" onClick={onNewTab}><Plus aria-hidden className="size-4" />New tab</button>
        </div>}
      />

      {shown ? <>
        <div className="mb-2 flex items-end gap-1 border-b border-border/60">
          {/* The same quiet tabs as a pane's tab bar, so a tab looks and answers the same in both. As
              there, the chips' 44px touch band hangs 8px past the line into the margin below, and
              the underline sits on the line. */}
          <div data-workbench-navigation-band="tabs" role="group" aria-label="Tabs"
            className="-mb-[9px] flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {groups.map((g, index) => {
              const record = tabs.find((t) => t.tabId === g.tabId);
              return (
                <Chip key={g.tabId} label={tabName(g.label, index + 1)} active={g === shown} ring={record?.focused}
                  status={worstTriage(g.panes.filter((p) => p.kind !== "shell"))}
                  onClick={() => pick(g.tabId)}
                  onLongPress={record && (() => setSheetTab(record))}
                  onTapActive={record && (() => setSheetTab(record))} />
              );
            })}
          </div>
          {/* A box the tabs' height, so the taller touch target centres on them. */}
          {shownRecord && (
            <div className="flex h-9 shrink-0 items-center">
              <button type="button" className="workbench-icon-button" aria-label={`${shownName} actions`} aria-haspopup="dialog"
                onClick={() => setSheetTab(shownRecord)}>
                <Ellipsis aria-hidden className="size-4" />
              </button>
            </div>
          )}
        </div>

        {shown.panes.length > 0
          ? <ul className="task-list" aria-label={`${shownName} panes`}>
            {shown.panes.map((pane) => <PaneRow key={pane.paneId} pane={pane} folder={folder} session={session} now={now} />)}
          </ul>
          : <p className="px-2 py-1 text-sm text-muted-foreground">No panes in this tab.</p>}
      </> : <p className="px-2 py-1 text-sm text-muted-foreground">No tabs yet.</p>}

      <TabActionsSheet
        open={sheetTab !== null}
        onClose={() => setSheetTab(null)}
        tab={sheetTab}
        session={session}
        readOnly={readOnly}
        onRenamed={onChanged}
        // Closing the tab on screen moves to the one beside it, as Herdr and a browser do.
        onClosed={(tabId) => {
          const next = tabId === shown?.tabId ? neighborTab(tabs, tabId) : undefined;
          if (next) pick(next);
          onChanged();
        }}
      />
    </>
  );
}

/** A pane: what it is about, its agent and state, what it is doing, and when it last changed. */
function PaneRow({ pane, folder, session, now }: { pane: AgentView; folder?: string; session?: string; now: number }) {
  const shell = pane.kind === "shell";
  const title = paneSubject(pane);
  // The folder only when this pane sits somewhere other than the workspace's own.
  const elsewhere = pane.cwd && pane.cwd !== folder ? shortCwd(pane.cwd) : undefined;
  const detail = [shell ? "shell" : `${pane.agent} · ${STATUS_LABEL[pane.status]}`, pane.terminalTitle, elsewhere]
    .filter((part): part is string => !!part && part.toLowerCase() !== title.toLowerCase())
    .join(" · ");
  return (
    <li>
      <div className="task-row">
        <Link className="task-main" to={panePath(pane.paneId, session)}>
          {/* One mark column, centred on the title's first line, so a shell's glyph and an agent's dot
              line their titles up. */}
          <span className="flex h-5 w-3.5 shrink-0 items-center justify-center">
            {shell
              ? <Terminal aria-hidden className="size-3.5 text-muted-foreground" />
              : <StatusDot status={pane.status} surface="bg-transparent" className="size-2" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block break-words text-sm font-medium">{title}</span>
            {detail && <span className="block truncate text-xs text-muted-foreground">{detail}</span>}
          </span>
          {pane.lastActiveAt !== undefined && (
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{timeAgoShort(pane.lastActiveAt, now)}</span>
          )}
        </Link>
      </div>
    </li>
  );
}
