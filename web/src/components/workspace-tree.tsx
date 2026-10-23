import { useId } from "react";
import { Link } from "react-router";
import { ChevronRight, LayoutGrid, LayoutTemplate } from "@/components/ui/icon";

import { OpeningMark, PaneMark, RowBody } from "@/components/nav-rows";
import { resting, StatusDot } from "@/components/status-badge";
import { displayName } from "@/lib/display-name";
import { panePath, workspacePath } from "@/lib/nav";
import type { Herd } from "@/lib/spaces";
import { cn } from "@/lib/utils";
import { orderWorkspaces, useWorkspaceOrder } from "@/lib/workspace-order";
import { defaultOpen, opensDirectly, tabFolds, tabStartsOpen, workspaceTree, type AgentCounts, type TabBranch, type WorkspaceBranch } from "@/lib/workspace-tree";
import { STATUS_LABEL, type AgentStatus, type AgentView, type ProjectView } from "@/lib/types";

/** Only states worth reading at a glance get a word; a resting pane keeps its hollow dot. */
const STATUS_WORD: Partial<Record<AgentStatus, string>> = { blocked: "needs you", working: "working", done: "done" };
const STATUS_TEXT: Partial<Record<AgentStatus, string>> = { blocked: "text-status-blocked", working: "text-status-working", done: "text-status-done" };

/**
 * The herd as Herdr holds it, drawn like the projects above it: a row per workspace whose name opens
 * its pane and whose chevron folds its tabs, one level in. A workspace of one tab has no chevron: its
 * row is that tab's.
 */
export function WorkspaceTree({ source, session, currentPaneId, expanded, onExpand, tabs, onTab, startFolded = false }: {
  /** With the projects, so a pane is called what every other view calls it (lib/display-name.ts). */
  source: Herd & { projects?: readonly ProjectView[] };
  session?: string;
  currentPaneId?: string;
  /** Explicit fold per workspace id; an untouched one follows {@link defaultOpen}. */
  expanded: Record<string, boolean>;
  onExpand: (workspaceId: string, open: boolean) => void;
  /** Explicit fold per id of a tab that folds; an untouched one follows {@link tabStartsOpen}. */
  tabs: Record<string, boolean>;
  onTab: (tabId: string, open: boolean) => void;
  /** An untouched workspace starts folded instead of following {@link defaultOpen}. */
  startFolded?: boolean;
}) {
  const { order } = useWorkspaceOrder();
  const branches = orderWorkspaces(workspaceTree(source, currentPaneId), (branch) => branch.workspace.workspaceId, (branch) => branch.name, order);
  return branches.map((branch) => (
    <WorkspaceSection key={branch.workspace.workspaceId} branch={branch} href={workspacePath(branch.workspace.workspaceId, source, session)}
      session={session} currentPaneId={currentPaneId} projects={source.projects}
      open={expanded[branch.workspace.workspaceId] ?? (!startFolded && defaultOpen(branch, branches.length))}
      onToggle={(open) => onExpand(branch.workspace.workspaceId, open)} tabs={tabs} onTab={onTab} />
  ));
}

function WorkspaceSection({ branch, href, session, currentPaneId, projects, open, onToggle, tabs, onTab }: {
  branch: WorkspaceBranch;
  projects?: readonly ProjectView[];
  /** Where the workspace's name opens (see workspacePath). */
  href: string;
  session?: string;
  currentPaneId?: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  tabs: Record<string, boolean>;
  onTab: (tabId: string, open: boolean) => void;
}) {
  const bodyId = useId();
  const { name, counts } = branch;
  const status = workspaceStatus(counts);
  const fold = !opensDirectly(branch);
  return (
    <section aria-label={name} className="nav-ws">
      <div className="nav-project">
        <Link className="nav-row" to={href} aria-current={branch.current ? "true" : undefined}>
          <span className="nav-lead"><OpeningMark to={href}><LayoutGrid aria-hidden size={14} /></OpeningMark></span>
          <span className="nav-row-text">{name}</span>
          {status && !resting(status) && <StatusDot status={status} />}
          {status && <span className="sr-only">, {STATUS_LABEL[status]}</span>}
          <span className="nav-count">{branch.tabs.length} {branch.tabs.length === 1 ? "tab" : "tabs"}</span>
        </Link>
        {fold && <button type="button" className="nav-disclosure nav-disclosure-end" aria-label={`${name} panes`} aria-expanded={open}
          aria-controls={open ? bodyId : undefined} onClick={() => onToggle(!open)}>
          <ChevronRight aria-hidden size={14} />
        </button>}
      </div>
      {fold && open && (
        <div id={bodyId} className="nav-ws-body">
          {branch.tabs.map((tab) => <TabRows key={tab.tabId} tab={tab} folds={tabFolds(tab.panes.length, branch.tabs.length)} projects={projects} session={session}
            currentPaneId={currentPaneId} open={tabs[tab.tabId] ?? tabStartsOpen(tab.panes, currentPaneId)} onToggle={(next) => onTab(tab.tabId, next)} />)}
          {branch.tabs.length === 0 && <p className="nav-empty">No panes yet</p>}
        </div>
      )}
    </section>
  );
}

/** The one dot a folded workspace or tab shows: its most urgent agent, none for shells alone. */
function workspaceStatus(counts: AgentCounts): AgentStatus | undefined {
  if (counts.blocked) return "blocked";
  if (counts.working) return "working";
  if (counts.done) return "done";
  return counts.agents ? "idle" : undefined;
}

/**
 * A tab's panes, each named after its agent as the chat it opens is. A one-pane tab is that pane's
 * row, the tab named at its end while nothing more urgent sits there. A tab that folds (tabFolds) is a
 * row of its own, its chevron in the fold column, saying its most urgent agent and how many panes it
 * holds; its panes sit one level in.
 */
function TabRows({ tab, folds, projects, session, currentPaneId, open, onToggle }: {
  tab: TabBranch;
  folds: boolean;
  projects?: readonly ProjectView[];
  session?: string;
  currentPaneId?: string;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const bodyId = useId();
  if (!folds) {
    return tab.panes.map((pane) => {
      const name = displayName(pane, projects);
      return <PaneRow key={pane.paneId} pane={pane} title={name} note={tab.label === name ? undefined : tab.label} session={session}
        current={pane.paneId === currentPaneId} />;
    });
  }
  const status = workspaceStatus(tab.counts);
  const count = `${tab.panes.length} panes`;
  return <>
    <button type="button" className="nav-pane nav-tab" aria-expanded={open} aria-controls={open ? bodyId : undefined}
      aria-label={[tab.label, status && STATUS_LABEL[status], count].filter(Boolean).join(", ")} onClick={() => onToggle(!open)}>
      <ChevronRight aria-hidden size={14} className="nav-tab-fold" />
      <RowBody mark={<LayoutTemplate aria-hidden size={14} />} title={tab.label} end={<>
        {status && !resting(status) && <StatusDot status={status} />}
        <span className="nav-count">{count}</span>
      </>} />
    </button>
    {open && (
      <div id={bodyId} role="group" aria-label={tab.label}>
        {tab.panes.map((pane) => (
          <PaneRow key={pane.paneId} nested pane={pane} title={displayName(pane, projects)} session={session}
            current={pane.paneId === currentPaneId} />
        ))}
      </div>
    )}
  </>;
}

function PaneRow({ pane, title, note, session, current, nested }: {
  pane: AgentView;
  title: string;
  /** Said at the end when no state word is. */
  note?: string;
  session?: string;
  current: boolean;
  nested?: boolean;
}) {
  const word = pane.kind === "shell" ? undefined : STATUS_WORD[pane.status];
  const to = panePath(pane.paneId, session);
  return (
    <Link className={cn("nav-pane", nested && "nav-pane-nested")} to={to} aria-current={current ? "page" : undefined}>
      <RowBody mark={<OpeningMark to={to}><PaneMark pane={pane} /></OpeningMark>} title={title} end={<>
        {word ? <span className={cn("nav-pane-status", STATUS_TEXT[pane.status])}>{word}</span>
          : note && <span className="nav-row-note"><span className="sr-only">, </span>{note}</span>}
        {pane.kind !== "shell" && !word && <span className="sr-only">, {STATUS_LABEL[pane.status]}</span>}
      </>} />
    </Link>
  );
}
