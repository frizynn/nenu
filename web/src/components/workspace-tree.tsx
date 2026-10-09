import { useId, type ReactNode } from "react";
import { Link } from "react-router";
import { ChevronRight, LayoutGrid, Terminal } from "lucide-react";

import { StatusDot } from "@/components/status-badge";
import { panePath, spacePath } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { defaultOpen, paneSubject, workspaceTree, type TabBranch, type TreeSource, type WorkspaceBranch } from "@/lib/workspace-tree";
import { STATUS_LABEL, type AgentStatus, type AgentView } from "@/lib/types";

/** Only states worth reading at a glance get a word; a resting pane keeps its hollow dot. */
const STATUS_WORD: Partial<Record<AgentStatus, string>> = { blocked: "needs you", working: "working", done: "done" };
const STATUS_TEXT: Partial<Record<AgentStatus, string>> = { blocked: "text-status-blocked", working: "text-status-working", done: "text-status-done" };

/** The herd as Herdr holds it: each workspace, its tabs, and a tab's panes when it has several. */
export function WorkspaceTree({ source, query, session, currentPaneId, expanded, onExpand, onNavigate, empty = null }: {
  source: TreeSource;
  query: string;
  session?: string;
  currentPaneId?: string;
  /** Explicit fold per workspace id; an untouched one follows {@link defaultOpen}. */
  expanded: Record<string, boolean>;
  onExpand: (workspaceId: string, open: boolean) => void;
  onNavigate?: () => void;
  /** Shown instead when nothing is left to list. */
  empty?: ReactNode;
}) {
  const searching = query.trim() !== "";
  const branches = workspaceTree(source, query, currentPaneId);
  if (branches.length === 0) return empty;
  return branches.map((branch) => (
    <WorkspaceSection key={branch.workspace.workspaceId} branch={branch} session={session} currentPaneId={currentPaneId}
      open={searching || (expanded[branch.workspace.workspaceId] ?? defaultOpen(branch, branches.length))} searching={searching}
      onToggle={(open) => onExpand(branch.workspace.workspaceId, open)} onNavigate={onNavigate} />
  ));
}

function WorkspaceSection({ branch, session, currentPaneId, open, searching, onToggle, onNavigate }: {
  branch: WorkspaceBranch;
  session?: string;
  currentPaneId?: string;
  open: boolean;
  searching: boolean;
  onToggle: (open: boolean) => void;
  onNavigate?: () => void;
}) {
  const bodyId = useId();
  const { name, counts, workspace } = branch;
  return (
    <section aria-label={name} className="nav-ws">
      <div className="nav-ws-head">
        <button type="button" className="nav-ws-toggle" aria-expanded={open} aria-controls={open ? bodyId : undefined} disabled={searching}
          onClick={() => onToggle(!open)}>
          <ChevronRight aria-hidden size={15} className="nav-ws-chevron" />
          <span className="nav-ws-title">
            <span className="nav-ws-name">{name}</span>
            <span className="nav-ws-meta"><WorkspaceSummary counts={counts} tabs={branch.tabs.length} /></span>
          </span>
        </button>
        <Link className="nav-ws-open" to={spacePath(workspace.workspaceId, session)} onClick={onNavigate} aria-label={`Open workspace ${name}`}>
          <LayoutGrid aria-hidden size={15} />
        </Link>
      </div>
      {open && (
        <div id={bodyId} className="nav-ws-body">
          {branch.tabs.map((tab) => <TabRows key={tab.tabId} tab={tab} session={session} currentPaneId={currentPaneId} onNavigate={onNavigate} />)}
          {branch.tabs.length === 0 && <p className="nav-empty">No panes yet</p>}
        </div>
      )}
    </section>
  );
}

/** "3 chats · 2 working · 1 needs you": what is inside, and only the states worth a look. */
function WorkspaceSummary({ counts, tabs }: { counts: WorkspaceBranch["counts"]; tabs: number }) {
  const size = counts.agents ? `${counts.agents} ${counts.agents === 1 ? "chat" : "chats"}` : `${tabs} ${tabs === 1 ? "tab" : "tabs"}`;
  return <>
    {size}
    {counts.blocked > 0 && <> · <span className="text-status-blocked">{counts.blocked} needs you</span></>}
    {counts.working > 0 && <> · <span className="text-status-working">{counts.working} working</span></>}
    {counts.done > 0 && <> · {counts.done} done</>}
  </>;
}

/** A one-pane tab is a single row named after the tab; a tab with several panes lists each. */
function TabRows({ tab, session, currentPaneId, onNavigate }: { tab: TabBranch; session?: string; currentPaneId?: string; onNavigate?: () => void }) {
  if (tab.panes.length === 1) {
    const pane = tab.panes[0];
    const subject = paneSubject(pane);
    return <PaneRow pane={pane} title={tab.label} detail={subject === tab.label ? pane.agent : subject} session={session}
      current={pane.paneId === currentPaneId} onNavigate={onNavigate} />;
  }
  return (
    <div role="group" aria-label={tab.label}>
      <div className="nav-tab-label"><span className="nav-row-text">{tab.label}</span><span className="nav-count">{tab.panes.length} panes</span></div>
      {tab.panes.map((pane) => (
        <PaneRow key={pane.paneId} nested pane={pane} title={paneSubject(pane)} detail={pane.kind === "shell" ? "shell" : pane.agent}
          session={session} current={pane.paneId === currentPaneId} onNavigate={onNavigate} />
      ))}
    </div>
  );
}

function PaneRow({ pane, title, detail, session, current, nested, onNavigate }: {
  pane: AgentView;
  title: string;
  detail: string;
  session?: string;
  current: boolean;
  nested?: boolean;
  onNavigate?: () => void;
}) {
  const word = pane.kind === "shell" ? undefined : STATUS_WORD[pane.status];
  return (
    <Link className={cn("nav-pane", nested && "nav-pane-nested")} to={panePath(pane.paneId, session)} onClick={onNavigate}
      aria-current={current ? "page" : undefined}>
      <span className="nav-pane-mark">
        {pane.kind === "shell" ? <Terminal aria-hidden size={14} /> : <StatusDot status={pane.status} surface="bg-transparent" className="size-2" />}
      </span>
      <span className="nav-pane-text">
        <span className="nav-pane-title">{title}</span>
        {detail && <span className="nav-pane-detail">{detail}</span>}
      </span>
      {word && <span className={cn("nav-pane-status", STATUS_TEXT[pane.status])}>{word}</span>}
      {pane.kind !== "shell" && !word && <span className="sr-only">, {STATUS_LABEL[pane.status]}</span>}
    </Link>
  );
}
