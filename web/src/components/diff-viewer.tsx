import { Fragment, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams, useRouteLoaderData } from "react-router";
import { ChatCircleText, ChevronRight, ExternalLink, Pending, Plus, X } from "@/components/ui/icon";

import { errorMessage } from "@/components/node-start";
import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/ui/sheet";
import { fetchPaneDiff } from "@/lib/api";
import { displayName } from "@/lib/display-name";
import { tildeHome } from "@/lib/format";
import { saveDiffComment, useDiffComments, type DiffComment, type DiffLine } from "@/lib/diff-comments";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { panePath } from "@/lib/nav";
import type { DiffFile, DiffHunk, PaneDiff } from "@/lib/types";
import { cn } from "@/lib/utils";

export type DiffRead = { state: "loading" } | { state: "failed"; message: string } | { state: "read"; diff: PaneDiff };

const OMITTED: Record<NonNullable<DiffFile["omitted"]>, string> = {
  binary: "Binary file",
  large: "Too long to show here",
  budget: "Past the size limit",
  untracked: "Untracked, not in git yet",
  private: "Private file, not shown",
};

/** One read of a diff while `active`, again whenever `key` changes, aborted when either ends it. */
export function useDiffRead(key: string, active: boolean, load: (signal: AbortSignal) => Promise<PaneDiff>): DiffRead {
  const [read, setRead] = useState<DiffRead>({ state: "loading" });
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setRead({ state: "loading" });
    load(controller.signal)
      .then((diff) => setRead({ state: "read", diff }))
      .catch((error: unknown) => { if (!controller.signal.aborted) setRead({ state: "failed", message: errorMessage(error) }); });
    return () => controller.abort();
    // `load` is a fresh closure every render; `key` names what it reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active]);
  return read;
}

/**
 * A pull request's diff, read from a pane's folder when it opens: the files with their counts, each
 * folded until tapped. Lines are text nodes; nothing is highlighted, parsed or run.
 */
export default function DiffViewer({ open, onClose, paneId, pr, session, url }: {
  open: boolean;
  onClose: () => void;
  paneId: string;
  pr: number;
  session?: string;
  url?: string;
}) {
  const read = useDiffRead(`${paneId}\0${pr}\0${session ?? ""}`, open, (signal) => fetchPaneDiff(paneId, pr, session, signal));
  const github = url && <a href={url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground lg:min-h-8">
    <ExternalLink aria-hidden className="size-3" />Open on GitHub
  </a>;
  // A portal: the sheet is fixed to the viewport, and a row or bar it is opened from may not be.
  return createPortal(
    <BottomSheet open={open} onClose={onClose} title={`PR #${pr} changes`} desktop="dialog" bodyClassName="flex flex-col gap-2 px-0 pb-4">
      <DiffBody read={read} footer={github} comments={{ paneId, session }} onLeave={onClose} />
    </BottomSheet>,
    document.body,
  );
}

/** Where a diff came from, in words. */
function sourceLine(diff: Extract<PaneDiff, { ok: true }>): ReactNode {
  const code = (text: string) => <code className="font-mono">{text}</code>;
  // A coordinator works in its project's folder: what it reads is the project's repository.
  const where = diff.repo && <>This pane's folder is not a git repository, so these are its project's changes, in {code(tildeHome(diff.repo))}: </>;
  if (diff.source === "uncommitted") return <>{where}{where ? "what" : "What"} is not committed on {code(diff.head)} yet, against its last commit.</>;
  if (diff.source === "branch") return <>The pushed branch {code(diff.head)}, against {code(diff.base)}.</>;
  return <>{where}{where ? "the" : diff.pr === undefined ? "This session's" : "This thread's"} worktree on {code(diff.head)}, uncommitted edits included, against {code(diff.base)}.</>;
}

/** The pane a diff was read from, whose composer its line comments wait on. */
export interface CommentTarget {
  paneId: string;
  session?: string;
}

/** What a file's rows need to take comments: whom they are for, and the ones already made. */
interface Commenting {
  target: CommentTarget;
  comments: readonly DiffComment[];
}

/**
 * A diff as read: loading, a refusal or failure with its reason, or the summary over the files.
 * `footer` sits under the summary (Open on GitHub); `empty` replaces the empty-list line. With
 * `comments`, each changed line takes a comment for that pane; `onLeave` runs when Open chat leaves.
 */
export function DiffBody({ read, footer, empty, comments: target, onLeave }: {
  read: DiffRead;
  footer?: ReactNode;
  empty?: ReactNode;
  comments?: CommentTarget;
  onLeave?: () => void;
}) {
  const diff = read.state === "read" ? read.diff : undefined;
  const comments = useDiffComments(target?.paneId, target?.session);
  const onScreen = useParams().paneId;
  return <>
    {read.state === "loading" && <p role="status" className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
      <Pending aria-hidden className="size-4" />Reading the diff…
    </p>}
    {read.state === "failed" && <div className="px-4"><p role="alert" className="text-sm">{read.message}</p>{footer}</div>}
    {diff && !diff.ok && <div className="px-4"><p className="text-sm">{diff.message}</p>
      {diff.repo && <p className="mt-1 text-xs text-muted-foreground">In the project's repository, <code className="font-mono">{tildeHome(diff.repo)}</code>, since this pane's folder is not a git repository.</p>}
      {footer}</div>}
    {diff?.ok && <>
      <div className="flex flex-col gap-1 px-4 text-xs text-muted-foreground">
        <p className="text-[13px] text-foreground">
          <span>{diff.totals.files} {diff.totals.files === 1 ? "file" : "files"}</span>{" · "}
          <span className="font-mono tabular-nums"><span className="text-status-done">+{diff.totals.additions}</span> <span className="text-status-blocked">−{diff.totals.deletions}</span></span>
        </p>
        <p className="break-words">{sourceLine(diff)}</p>
        {diff.truncated?.files && <p className="text-foreground">Showing {diff.files.length} of {diff.totals.files} files.</p>}
        {diff.truncated?.bytes && <p className="text-foreground">The diff is over the size limit: files further down show their counts only.</p>}
        {footer}
      </div>
      {target && comments.length > 0 && target.paneId !== onScreen && <CommentsElsewhere target={target} count={comments.length} onLeave={onLeave} />}
      {diff.files.length === 0
        ? empty ?? <p className="px-4 text-sm text-muted-foreground">No changes against the base branch.</p>
        : <ul className="border-t border-border/60">{diff.files.map((file) => <FileRow key={`${file.from ?? ""}\0${file.path}`} file={file}
          commenting={target && { target, comments: comments.filter((comment) => comment.path === file.path) }} />)}</ul>}
    </>}
  </>;
}

/** The diff is another chat's than the one on screen: its comments wait over that chat's composer. */
function CommentsElsewhere({ target, count, onLeave }: { target: CommentTarget; count: number; onLeave?: () => void }) {
  const navigate = useNavigate();
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData | undefined;
  const pane = data?.agents.find((agent) => agent.paneId === target.paneId);
  return (
    <div className="mx-4 flex items-center gap-2 rounded-lg border border-border/70 py-1 pl-3 pr-1 text-[13px]">
      <ChatCircleText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">{count} {count === 1 ? "comment" : "comments"} for {pane ? displayName(pane, data?.projects) : "this thread"}</span>
      <button type="button" className="quiet-action" onClick={() => { onLeave?.(); navigate(panePath(target.paneId, target.session)); }}>Open chat</button>
    </div>
  );
}

function FileRow({ file, commenting }: { file: DiffFile; commenting?: Commenting }) {
  const [open, setOpen] = useState(false);
  const lines = !!file.hunks?.length;
  const slash = file.path.lastIndexOf("/") + 1;
  const note = file.omitted ? OMITTED[file.omitted]
    : !lines ? (file.status === "renamed" ? "Renamed, no line changes" : "No line changes") : undefined;
  const status = file.omitted === "untracked" ? undefined : file.status === "added" ? "new" : file.status === "deleted" ? "deleted" : undefined;
  return (
    <li className="border-b border-border/60">
      <button type="button" aria-expanded={lines ? open : undefined} disabled={!lines} onClick={() => setOpen(!open)}
        className="flex min-h-11 w-full items-start gap-2 px-4 py-2 text-left disabled:cursor-default lg:min-h-9">
        <ChevronRight aria-hidden className={cn("mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", open && "rotate-90", !lines && "invisible")} />
        <span className="min-w-0 flex-1">
          <span className="block break-all font-mono text-xs">
            {file.from && <span className="text-muted-foreground">{file.from} → </span>}
            <span className="text-muted-foreground">{file.path.slice(0, slash)}</span>{file.path.slice(slash)}
          </span>
          {(note || status) && <span className="block text-[11.5px] text-muted-foreground">{[status, note].filter(Boolean).join(" · ")}</span>}
        </span>
        {!file.binary && file.omitted !== "untracked" && <span className="shrink-0 font-mono text-xs tabular-nums">
          <span className="text-status-done">+{file.additions}</span> <span className="text-status-blocked">−{file.deletions}</span>
        </span>}
      </button>
      {open && file.hunks && <div className="@container overflow-x-auto border-t border-border/60">
        <div className="inline-block min-w-full font-mono text-[12px] leading-5 [font-variant-ligatures:none]">
          {file.hunks.map((hunk, index) => <Hunk key={index} hunk={hunk} path={file.path} commenting={commenting} />)}
        </div>
      </div>}
    </li>
  );
}

/** A hunk's rows, numbered on the side that has the line: the new file's, or the old one's for a removal. */
function Hunk({ hunk, path, commenting }: { hunk: DiffHunk; path: string; commenting?: Commenting }) {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  return <>
    <div className="whitespace-pre bg-muted/60 px-4 text-muted-foreground">{hunk.header}</div>
    {hunk.lines.map((line, index) => {
      const mark = line[0];
      const number = mark === "+" ? newLine++ : mark === "-" ? oldLine++ : mark === " " ? (oldLine++, newLine++) : undefined;
      const row = (comment?: ReactNode) => (
        <div className={cn("flex", comment && "group relative", mark === "+" && "bg-status-done/15", mark === "-" && "bg-status-blocked/15")}>
          <span aria-hidden className="w-11 shrink-0 select-none pr-2 text-right text-muted-foreground/70">{number}</span>
          <span className={cn("w-4 shrink-0 select-none", mark === "+" ? "text-status-done" : "text-status-blocked")}>{mark === "+" || mark === "-" ? mark : ""}</span>
          <span className={cn("whitespace-pre pr-4", mark === "\\" && "italic text-muted-foreground")}>{line.slice(mark === "\\" ? 2 : 1) || " "}</span>
          {comment}
        </div>
      );
      if (!commenting || (mark !== "+" && mark !== "-")) return <Fragment key={index}>{row()}</Fragment>;
      const at: DiffLine = { path, side: mark, line: number!, quote: line.slice(1) };
      return <CommentableLine key={index} at={at} commenting={commenting} row={row} />;
    })}
  </>;
}

/**
 * A changed line that takes a comment: a "+" beside it under a hovering pointer, a tap on the line
 * where nothing hovers, then a one-line box under it (Enter saves, Esc cancels). A saved comment
 * shows under its line, and a tap on it edits it.
 */
function CommentableLine({ at, commenting, row }: { at: DiffLine; commenting: Commenting; row: (comment: ReactNode) => ReactNode }) {
  const [editing, setEditing] = useState(false);
  const saved = commenting.comments.find((comment) => comment.side === at.side && comment.line === at.line);
  const name = `${at.side === "-" ? "removed " : ""}${at.path}:${at.line}`;
  const save = (text: string) => { saveDiffComment(commenting.target.paneId, commenting.target.session, at, text); setEditing(false); };
  const Mark = saved ? ChatCircleText : Plus;
  return (
    <div onClick={() => { if (window.matchMedia?.("(hover: none)").matches) setEditing(true); }}>
      {row(<button type="button" aria-label={`Comment on ${name}`} onClick={(event) => { event.stopPropagation(); setEditing(true); }}
        className={cn("absolute left-1 top-0.5 grid size-4 place-items-center rounded bg-primary text-primary-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
          saved && "bg-transparent text-muted-foreground opacity-100")}>
        <Mark aria-hidden className="size-3" />
      </button>)}
      {editing
        ? <CommentBox name={name} initial={saved?.text ?? ""} onSave={save} onCancel={() => setEditing(false)} />
        : saved && <div className="sticky left-0 flex w-[100cqw] items-start gap-2 border-y border-border/60 bg-muted/40 py-1.5 pl-4 pr-1 font-sans text-[13px] leading-5">
          <ChatCircleText aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <button type="button" aria-label={`Edit comment on ${name}`} onClick={(event) => { event.stopPropagation(); setEditing(true); }}
            className="min-w-0 flex-1 whitespace-normal break-words text-left">{saved.text}</button>
          <button type="button" aria-label={`Remove comment on ${name}`} onClick={(event) => { event.stopPropagation(); save(""); }}
            className="hit-area grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground">
            <X aria-hidden className="size-3" />
          </button>
        </div>}
    </div>
  );
}

function CommentBox({ name, initial, onSave, onCancel }: { name: string; initial: string; onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial);
  return (
    <div onClick={(event) => event.stopPropagation()}
      className="sticky left-0 flex w-[100cqw] items-center gap-1.5 border-y border-border/60 bg-background py-1.5 pl-4 pr-2 font-sans">
      {/* Focused on open: the line was tapped to write here. */}
      <input autoFocus value={text} onChange={(event) => setText(event.target.value)} aria-label={`Comment on ${name}`} placeholder="Comment for the agent"
        enterKeyHint="done" className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring/40 md:text-sm"
        onKeyDown={(event) => {
          // The IME owns Enter while committing a word; Safari can say so only with 229.
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === "Enter") { event.preventDefault(); onSave(text); }
          // The box's own Escape: the sheet or dialog around it stays open.
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); }
        }} />
      <Button type="button" variant="ghost" size="sm" className="hit-area h-8" onClick={onCancel}>Cancel</Button>
      <Button type="button" size="sm" className="hit-area h-8" onClick={() => onSave(text)}>Save</Button>
    </div>
  );
}
