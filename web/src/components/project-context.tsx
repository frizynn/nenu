import { useEffect, useState, type ReactNode } from "react";
import { BookText, FileText, FolderGit2 } from "@/components/ui/icon";

import { fetchOrgContext } from "@/lib/api";
import type { OrgProjectDetail, ProjectThreadView, ProjectView } from "@/lib/types";

// A desk project's Context tab (ADR 0101): what the project panel's Context showed, now on the project's page.

const size = (text: string) => text.length < 1000 ? String(text.length) : `${(text.length / 1000).toFixed(1)}k`;

/** One file every thread receives: its name and size, its text in place when opened. */
function SharedFile({ icon, name, text }: { icon: ReactNode; name: ReactNode; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="desk-context-row">
        {icon}<span className="min-w-0 flex-1 truncate text-left">{name}</span><span className="tabular-nums text-muted-foreground">{size(text)}</span>
      </button>
      {open && <pre className="desk-context-text">{text.trim()}</pre>}
    </li>
  );
}

/** The goal, what every thread receives, where they work and the agents; the routines have their own tab. */
export function ProjectContext({ project, threads }: { project: ProjectView; threads: readonly ProjectThreadView[] }) {
  const [read, setRead] = useState<{ detail: OrgProjectDetail | null } | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    fetchOrgContext(project.slug, controller.signal)
      .then(({ detail }) => setRead({ detail }))
      .catch(() => { if (!controller.signal.aborted) setRead({ detail: null }); });
    return () => controller.abort();
  }, [project.slug]);
  const detail = read?.detail;
  const branches = threads.filter((thread) => thread.branch && thread.status !== "resolved");
  const card = (label: string, children: ReactNode) => <section aria-label={label} className="mb-5">
    <h3 className="panel-group-heading">{label}</h3>{children}
  </section>;
  const fileIcon = <FileText aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;
  return <>
    {card("Goal", <p className="px-1 text-sm leading-relaxed">{project.goal || "This project has no goal written down yet."}</p>)}
    {read === undefined && <p role="status" className="px-1 text-sm text-muted-foreground">Reading the project…</p>}
    {detail && card("Every thread receives", <ul className="desk-context-list">
      <SharedFile icon={fileIcon} name={<>PROJECT.md <span className="text-muted-foreground">· standing instructions</span></>} text={detail.instructions} />
      {detail.memory.trim() && <SharedFile icon={<BookText aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />} name="MEMORY.md" text={detail.memory} />}
      {detail.memoryFiles.map((file) => <SharedFile key={file.name} icon={fileIcon} name={`memory/${file.name}`} text={file.text} />)}
    </ul>)}
    {detail && detail.repos.length > 0 && card("Repositories", <ul className="desk-context-list">
      {detail.repos.map((repo) => <li key={`${repo.machine}\0${repo.path}`} className="desk-context-row">
        <FolderGit2 aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{repo.path}</span>
        <span className="text-muted-foreground">{repo.machine || "this machine"}</span>
      </li>)}
    </ul>)}
    {detail && card("Agents", <div className="flex flex-wrap gap-1.5">
      {[detail.coordinatorProfile && `Coordinator · ${detail.coordinatorProfile}`, detail.threadProfile && `Threads · ${detail.threadProfile}`,
        detail.maxParallelThreads > 0 && `Max ${detail.maxParallelThreads} in parallel`].filter(Boolean).map((chip) => <span key={String(chip)} className="desk-context-chip">{chip}</span>)}
    </div>)}
    {branches.length > 0 && card("Branches", <ul className="flex flex-col gap-1 px-1 text-sm">
      {branches.map((thread) => <li key={thread.id} className="flex items-baseline gap-2">
        <span className="shrink-0">{thread.title}</span>
        <span className="truncate font-mono text-xs text-muted-foreground">{thread.branch}</span>
      </li>)}
    </ul>)}
    {read && !detail && <p className="px-1 text-xs text-muted-foreground">Memory and instructions appear here with a newer Herdr Organizations, which can show them (<code>project show</code>).</p>}
  </>;
}
