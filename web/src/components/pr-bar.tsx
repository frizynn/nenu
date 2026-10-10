import { useRef, useState, type ReactNode } from "react";
import { Check, ExternalLink, GitPullRequest, X } from "lucide-react";

import { errorMessage } from "@/components/new-thread-menu";
import { WorkbenchPopover } from "@/components/ui/workbench-popover";
import { setOrgThreadFlags } from "@/lib/api";
import { setStatus } from "@/lib/status";
import type { ProjectThreadView, ProjectView, ThreadPullRequest } from "@/lib/types";
import { cn } from "@/lib/utils";

type Checks = NonNullable<ThreadPullRequest["checks"]>;
type Flag = "autoFixCi" | "autoMerge";

/** The chip's words: passed out of total, or what Organizations has not counted yet. */
export function ciLabel(checks: Checks | undefined): string {
  if (!checks) return "CI";
  const total = checks.passed + checks.failed + checks.pending;
  return total ? `CI ${checks.passed}/${total}` : "CI";
}

function ciTone(checks: Checks | undefined): string {
  if (!checks) return "bg-muted-foreground/50";
  if (checks.failed) return "bg-status-blocked";
  return checks.pending ? "bg-status-working" : "bg-status-done";
}

/**
 * A thread's pull request above its composer: number, branch and diff size, and a CI chip whose
 * popover lists the checks. The two automation toggles are Organizations' own and appear only when
 * it reports PR actions; without them the popover is read-only.
 */
export function PrBar({ project, thread, session, readOnly, onChanged }: {
  project: ProjectView;
  thread: ProjectThreadView;
  session?: string;
  readOnly: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState<Flag | null>(null);
  const [error, setError] = useState<string | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const pr = thread.pr;
  if (!pr) return null;
  const checks = pr.checks;
  const actions = Boolean(project.prActions) && pr.state === "open";

  async function toggle(flag: Flag, next: boolean) {
    setSaving(flag);
    setError(null);
    try {
      await setOrgThreadFlags({ project: project.slug, id: thread.id, [flag]: next }, session);
      setStatus(`${flag === "autoFixCi" ? "Auto-fix" : "Auto-merge"} ${next ? "on" : "off"}`, "success");
      onChanged();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSaving(null);
    }
  }

  const flag = (key: Flag, label: string) => {
    const on = Boolean(thread[key]);
    return (
      <label className="flex min-h-9 cursor-pointer items-center gap-2.5 text-[13px]">
        <input type="checkbox" className="size-4 accent-primary" checked={on} disabled={readOnly || saving !== null}
          onChange={() => void toggle(key, !on)} />
        {label}
      </label>
    );
  };

  return (
    <div className="mx-3 mb-2 flex min-h-11 items-center gap-2.5 rounded-xl border border-border bg-card/40 pl-3 pr-1.5 text-[13px]">
      <GitPullRequest aria-hidden className={cn("size-4 shrink-0", pr.state === "merged" ? "text-violet-400" : "text-status-done")} />
      {pr.url
        ? <a href={pr.url} target="_blank" rel="noreferrer" className="shrink-0 font-medium tabular-nums hover:underline">{pr.number !== undefined ? `#${pr.number}` : "PR"}</a>
        : <span className="shrink-0 font-medium tabular-nums">{pr.number !== undefined ? `#${pr.number}` : "PR"}</span>}
      {pr.state !== "open" && <span className="shrink-0 text-xs text-muted-foreground">{pr.state}</span>}
      <span className="hidden min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground sm:block">{thread.branch}</span>
      <span className="flex-1 sm:hidden" />
      {pr.diff && <span className="shrink-0 font-mono text-xs tabular-nums">
        <span className="text-status-done">+{pr.diff.additions}</span> <span className="text-status-blocked">−{pr.diff.deletions}</span>
      </span>}
      <button ref={anchor} type="button" aria-expanded={open} aria-label={`${ciLabel(checks)}, checks`} onClick={() => setOpen(!open)}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-muted px-2.5 text-xs font-medium tabular-nums">
        <span aria-hidden className={cn("size-1.5 rounded-full", ciTone(checks))} />{ciLabel(checks)}
      </button>
      <WorkbenchPopover open={open} onDismiss={() => setOpen(false)} anchorRef={anchor} label="CI monitoring">
        <div className="flex flex-col gap-1 text-[13px]">
          {pr.url && <a href={pr.url} target="_blank" rel="noreferrer" className="mb-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
            <ExternalLink aria-hidden className="size-3" />Open on GitHub
          </a>}
          {checks ? <>
            <Row icon={<span aria-hidden className="size-2 rounded-full border border-muted-foreground" />} label="In progress" count={checks.pending} />
            <Row icon={<Check aria-hidden className="size-3.5 text-status-done" />} label="Passed" count={checks.passed} />
            <Row icon={<X aria-hidden className="size-3.5 text-status-blocked" />} label="Failed" count={checks.failed} />
            {checks.failing?.map((name) => <p key={name} className="truncate pl-6 text-xs text-status-blocked">{name}</p>)}
          </> : <p className="text-muted-foreground">Organizations has not reported checks for this PR yet.</p>}
          {pr.mergeBlocker && <p className="mt-1 text-xs text-muted-foreground">Merge waits: {pr.mergeBlocker}</p>}
          {actions ? <div className="mt-2 border-t border-border pt-2">
            {flag("autoFixCi", "Auto-fix CI & address comments")}
            {flag("autoMerge", "Auto-merge when ready")}
            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
            <p className="mt-1 text-[11.5px] leading-snug text-muted-foreground">The Herdr Organizations ticker does this even while Nenu is closed.</p>
          </div> : pr.state === "open" && <p className="mt-2 text-[11.5px] text-muted-foreground">This Organizations build has no PR actions, so the checks are read-only.</p>}
        </div>
      </WorkbenchPopover>
    </div>
  );
}

function Row({ icon, label, count }: { icon: ReactNode; label: string; count: number }) {
  return (
    <div className="flex min-h-7 items-center gap-2.5">
      <span className="flex w-3.5 justify-center">{icon}</span>
      <span className="flex-1">{label}</span>
      <span className="tabular-nums text-muted-foreground">{count}</span>
    </div>
  );
}
