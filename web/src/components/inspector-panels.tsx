import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, FolderTree, GitCompareArrows, GitPullRequest, PanelRightClose, RefreshCw, SquareTerminal, type IconComponent } from "@/components/ui/icon";

import { ArtifactsPanel } from "@/components/artifacts-panel";
import { useConversationScan } from "@/components/chat-files-browser";
import { DiffBody, useDiffRead } from "@/components/diff-viewer";
import { ciLabel, ciTone } from "@/components/ci-checks";
import { ProjectFilesBrowser } from "@/components/project-files-browser";
import { ColumnEdge, ICON_BUTTON, slidePanel, type InspectorTab, type SessionInspectorState, type SessionPr, type TerminalSlots } from "@/components/session-inspector";
import { fetchActivity, type ActivityArtifact } from "@/lib/activity";
import { fetchSessionDiff } from "@/lib/api";
import { chatFileReferences } from "@/lib/chat-files";
import { FilePreviewContext } from "@/lib/file-preview-context";
import type { DiffScope } from "@/lib/types";
import { cn } from "@/lib/utils";

const TABS: ReadonlyArray<readonly [InspectorTab, string, IconComponent]> = [
  ["changes", "Changes", GitCompareArrows],
  ["files", "Files", FolderTree],
  ["terminal", "Terminal", SquareTerminal],
];

/**
 * A session's panel on a desk, right of its chat: Changes, Files and Terminal for that pane, each read
 * only while it is on screen.
 */
export default function SessionPanel({ inspector, paneId, session, artifacts, pr }: {
  inspector: SessionInspectorState;
  paneId: string;
  session?: string;
  /** The pane has a conversation whose files can be listed (an agent, not a shell). */
  artifacts: boolean;
  pr?: SessionPr;
}) {
  const view = inspector.tab;
  const { panelRef, entering } = inspector;
  useLayoutEffect(() => {
    // Only an open the person asked for slides in; a reload or a pane switch shows the panel in place.
    if (entering.current && panelRef.current) slidePanel(panelRef.current, "in");
    entering.current = false;
  }, [panelRef, entering]);

  return (
    <aside ref={panelRef} aria-label="Session panel" className="session-panel" style={{ width: inspector.width }}>
      <ColumnEdge inspector={inspector} label="Resize session panel" />
      <div className="flex min-h-13 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        {/* A narrow panel scrolls its tabs rather than overlap the fold button. */}
        <div role="tablist" aria-label="Session" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
          {TABS.map(([key, label, Icon]) => (
            <button key={key} type="button" role="tab" aria-selected={view === key} onClick={() => inspector.setTab(key)} className="panel-tab shrink-0 px-1.5">
              <Icon aria-hidden className="size-3.5" />{label}
            </button>
          ))}
        </div>
        <button ref={inspector.toggleRef} type="button" aria-label="Hide session panel" title="Hide session panel (⌘⌥B)" onClick={() => inspector.setOpen(false)} className={ICON_BUTTON}>
          <PanelRightClose aria-hidden className="size-4" />
        </button>
      </div>
      <div role="tabpanel" aria-label={TABS.find(([key]) => key === view)![1]} className={cn("min-h-0 flex-1", view === "terminal" ? "flex flex-col" : "overflow-y-auto")}>
        {view === "terminal" ? <Terminal publish={inspector.setTerminal} />
          : <TabBody key={`${paneId}\0${session ?? ""}`} tab={view} paneId={paneId} session={session} pr={pr} artifacts={artifacts} />}
      </div>
    </aside>
  );
}

/**
 * The Terminal tab is two empty places the chat draws into while the tab is on screen: the pane's
 * mirror, then Type into terminal (agent-chat.tsx and composer.tsx own both).
 */
function Terminal({ publish }: { publish: (slots: TerminalSlots | null) => void }) {
  const mirror = useRef<HTMLDivElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    publish({ mirror: mirror.current!, controls: controls.current! });
    return () => publish(null);
  }, [publish]);
  return <>
    <div ref={mirror} className="min-h-0 flex-1" />
    <div ref={controls} className="shrink-0 border-t border-border/60" />
  </>;
}

/** The body of the tab on screen; the panel remounts it for another pane. */
function TabBody({ tab, paneId, session, pr, artifacts }: { tab: "changes" | "files"; paneId: string; session?: string; pr?: SessionPr; artifacts: boolean }) {
  if (tab === "changes") return <Changes paneId={paneId} session={session} pr={pr} />;
  return <Files paneId={paneId} session={session} artifacts={artifacts} />;
}

const FILE_VIEWS: ReadonlyArray<readonly ["folder" | "artifacts", string]> = [["folder", "Folder"], ["artifacts", "Artifacts"]];

/** The pane's folder, and beside it what the agent handed over when the pane has a conversation. */
function Files({ paneId, session, artifacts }: { paneId: string; session?: string; artifacts: boolean }) {
  const openFile = useContext(FilePreviewContext);
  const open = (path: string) => openFile?.(path);
  const [view, setView] = useState<"folder" | "artifacts">("folder");
  const shown = artifacts ? view : "folder";
  return <>
    {artifacts && <div role="radiogroup" aria-label="Files" className="mx-3 mt-3 flex w-fit rounded-lg bg-muted/50 p-0.5">
      {FILE_VIEWS.map(([key, label]) => (
        <button key={key} type="button" role="radio" aria-checked={shown === key} onClick={() => setView(key)}
          className={cn("inline-flex h-7 items-center rounded-md px-2.5 text-xs", shown === key ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground")}>
          {label}
        </button>
      ))}
    </div>}
    {shown === "folder" ? <div className="px-3 pb-8 pt-2"><ProjectFilesBrowser paneId={paneId} session={session} onOpen={open} /></div>
      : <Artifacts paneId={paneId} session={session} onOpen={open} />}
  </>;
}

const SCOPES: ReadonlyArray<readonly [DiffScope, string]> = [["branch", "Branch"], ["uncommitted", "Uncommitted"]];
const REVIEW: Record<NonNullable<SessionPr["review"]>, string> = {
  approved: "Approved",
  changes_requested: "Changes requested",
  review_required: "Review required",
};

/** The session's pull request when it has one, then its diff: the branch against its base, or what is not committed. */
function Changes({ paneId, session, pr }: { paneId: string; session?: string; pr?: SessionPr }) {
  const [scope, setScope] = useState<DiffScope>("branch");
  const [attempt, setAttempt] = useState(0);
  const read = useDiffRead(`${scope}\0${attempt}`, true, (signal) => fetchSessionDiff(paneId, scope, session, signal));
  return (
    <div className="flex flex-col gap-2 pb-8 pt-3">
      {pr && <PrSummary pr={pr} />}
      <div className="flex items-center gap-2 px-4">
        <div role="radiogroup" aria-label="Diff scope" className="flex shrink-0 rounded-lg bg-muted/50 p-0.5">
          {SCOPES.map(([key, label]) => (
            <button key={key} type="button" role="radio" aria-checked={scope === key} onClick={() => setScope(key)}
              className={cn("inline-flex h-7 items-center rounded-md px-2.5 text-xs", scope === key ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground")}>
              {label}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <button type="button" aria-label="Read the diff again" title="Read the diff again" onClick={() => setAttempt((n) => n + 1)}
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground">
          <RefreshCw aria-hidden className="size-3.5" />
        </button>
      </div>
      <DiffBody read={read} comments={{ paneId, session }} empty={<div className="mx-4 rounded-xl border border-dashed px-5 py-8 text-center">
        <p className="text-footnote font-medium">{scope === "branch" ? "Nothing changed on this branch" : "Nothing left to commit"}</p>
        <p className="mt-1 text-xs text-muted-foreground">{scope === "branch" ? "The working tree matches where the branch started." : "Every edit in this folder is committed."}</p>
      </div>} />
    </div>
  );
}

/** The session's pull request as a flat row above its diff, as the panel's other rows are: no box around it. */
function PrSummary({ pr }: { pr: SessionPr }) {
  const name = pr.number !== undefined ? `#${pr.number}` : "Pull request";
  return (
    <section aria-label={pr.number !== undefined ? `Pull request #${pr.number}` : "Pull request"} className="flex flex-col gap-1.5 px-4 pb-1 text-[13px]">
      <div className="flex min-w-0 items-center gap-2">
        <GitPullRequest aria-hidden className="size-4 shrink-0 text-status-done" />
        <span className="shrink-0 font-semibold tabular-nums">{name}</span>
        <span className="min-w-0 flex-1 truncate font-medium">{pr.title}</span>
        {pr.state && pr.state !== "open" && <span className="shrink-0 text-xs text-muted-foreground">{pr.state}</span>}
        {pr.review && <span className="shrink-0 text-xs text-muted-foreground">{REVIEW[pr.review]}</span>}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {pr.head && <span className="min-w-0 truncate font-mono">{pr.base ? `${pr.head} → ${pr.base}` : pr.head}</span>}
        <span className="inline-flex items-center gap-1.5 tabular-nums"><span aria-hidden className={cn("size-1.5 rounded-full", ciTone(pr.checks))} />{ciLabel(pr.checks)}</span>
        {pr.diff && <span className="font-mono tabular-nums"><span className="text-status-done">+{pr.diff.additions}</span> <span className="text-status-blocked">−{pr.diff.deletions}</span></span>}
      </div>
      {pr.url && <a href={pr.url} target="_blank" rel="noreferrer" className="quiet-action -ml-2 w-fit">
        <ExternalLink aria-hidden className="size-3" />Open on GitHub
      </a>}
    </section>
  );
}

/** What the agent handed over in this conversation: the whole history read once, and its claude.ai pages read once. */
function Artifacts({ paneId, session, onOpen }: { paneId: string; session?: string; onOpen: (path: string) => void }) {
  const { scan } = useConversationScan(paneId, session, true);
  const references = useMemo(() => chatFileReferences(scan.entries), [scan.entries]);
  const [published, setPublished] = useState<ActivityArtifact[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    fetchActivity(paneId, session, controller.signal)
      .then((activity) => { if (activity.available) setPublished(activity.artifacts); })
      .catch(() => {});
    return () => controller.abort();
  }, [paneId, session]);
  return (
    <div className="px-2 pb-8 pt-3">
      {scan.loading && <p role="status" className="mb-2 px-2 text-xs text-muted-foreground">Reading the conversation…</p>}
      <ArtifactsPanel paneId={paneId} session={session} references={references} published={published} ready={!scan.loading} onOpen={onOpen} />
    </div>
  );
}
