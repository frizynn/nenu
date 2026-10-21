import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight, FolderGit2, GitBranch } from "@/components/ui/icon";

import { MarkdownText } from "@/components/markdown-text";
import { fetchOrgContext } from "@/lib/api";
import { FileHrefContext, FileKnownContext, FileMediaContext, FilePreviewContext } from "@/lib/file-preview-context";
import { reducedMotion } from "@/lib/motion";
import type { OrgProjectDetail, ProjectThreadView, ProjectView } from "@/lib/types";
import { cn } from "@/lib/utils";

// A desk project's Context tab (ADR 0102): what the project panel's Context showed, now on the project's page.

const size = (text: string) => text.length < 1000 ? String(text.length) : `${(text.length / 1000).toFixed(1)}k`;

// Each project's last read, drawn at once when the tab opens again while a fresh read runs behind it,
// and the read in flight, which a hover over the tab starts and the tab then joins. A read this young
// is not asked for again: `project show` is a process the bridge spawns.
const known = new Map<string, { at: number; detail: OrgProjectDetail | null }>();
const reading = new Map<string, Promise<OrgProjectDetail | null>>();
const FRESH_MS = 10_000;

function readContext(slug: string): Promise<OrgProjectDetail | null> {
  let read = reading.get(slug);
  if (!read) {
    read = fetchOrgContext(slug)
      .then(({ detail }) => { known.set(slug, { at: Date.now(), detail }); return detail; })
      .finally(() => reading.delete(slug));
    reading.set(slug, read);
  }
  return read;
}

/** Start reading a project's Context before its tab opens (a pointer over the tab, a focus). */
export function prefetchContext(slug: string): void {
  const last = known.get(slug);
  if (!last || Date.now() - last.at >= FRESH_MS) readContext(slug).catch(() => {});
}

export function __forgetContexts(): void {
  known.clear();
  reading.clear();
}

/** One file every thread receives: a header with its name and size, its Markdown drawn under it when opened. */
function SharedFile({ name, note, text, open, onToggle, resolve, onFollow }: {
  name: string; note?: string; text: string; open: boolean; onToggle: () => void;
  /** A link's target as a listed file's name, read from this file's folder; null for anything else. */
  resolve: (from: string, path: string) => string | null;
  onFollow: (name: string) => void;
}) {
  const target = (path: string) => resolve(name, path);
  return (
    <li className="desk-context-file" id={fileAnchor(name)}>
      <button type="button" aria-expanded={open} onClick={onToggle} className="desk-context-row">
        <ChevronRight aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", open && "rotate-90")} />
        <span className="min-w-0 flex-1 truncate text-left"><span className="font-medium">{name}</span>{note && <span className="text-muted-foreground"> · {note}</span>}</span>
        <span className="tabular-nums text-muted-foreground">{size(text)}</span>
      </button>
      {/* Only the files listed here open: no pane's file page or media route reaches this tab. */}
      {open && <div className="desk-context-body">
        <FileHrefContext.Provider value={null}><FileMediaContext.Provider value={null}>
          <FileKnownContext.Provider value={(path) => target(path) !== null}>
            <FilePreviewContext.Provider value={(path) => { const listed = target(path); if (listed) onFollow(listed); }}>
              <MarkdownText text={text.trim()} />
            </FilePreviewContext.Provider>
          </FileKnownContext.Provider>
        </FileMediaContext.Provider></FileHrefContext.Provider>
      </div>}
    </li>
  );
}

const fileAnchor = (name: string) => `context-${encodeURIComponent(name)}`;

/** The goal, what every thread receives, where they work and the agents; the routines have their own tab. */
export function ProjectContext({ project, threads }: { project: ProjectView; threads: readonly ProjectThreadView[] }) {
  const [read, setRead] = useState<{ slug: string; detail: OrgProjectDetail | null } | undefined>(() => {
    const last = known.get(project.slug);
    return last && { slug: project.slug, detail: last.detail };
  });
  // Which files are open, by name. A link in one file to another listed here opens it in place.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let live = true;
    const last = known.get(project.slug);
    setRead(last && { slug: project.slug, detail: last.detail });
    setOpened(new Set());
    if (last && Date.now() - last.at < FRESH_MS && !reading.has(project.slug)) return;
    // A failed read keeps what the tab last showed.
    readContext(project.slug)
      .then((detail) => { if (live) setRead({ slug: project.slug, detail }); })
      .catch(() => { if (live && !known.has(project.slug)) setRead({ slug: project.slug, detail: null }); });
    return () => { live = false; };
  }, [project.slug]);
  const current = read?.slug === project.slug ? read : undefined;
  const detail = current?.detail;
  const files = detail ? [
    { name: "PROJECT.md", note: "standing instructions", text: detail.instructions },
    ...(detail.memory.trim() ? [{ name: "MEMORY.md", text: detail.memory }] : []),
    ...detail.memoryFiles.map((file) => ({ name: `memory/${file.name}`, text: file.text })),
  ] : [];
  const listed = new Set(files.map((file) => file.name));
  const toggle = (name: string) => setOpened((now) => {
    const next = new Set(now);
    if (!next.delete(name)) next.add(name);
    return next;
  });
  // From memory/a.md, `b.md` is memory/b.md; `./b.md` too; a name with no listed file reads as words.
  const resolve = (from: string, path: string) => {
    const clean = path.replace(/^\.\//, "");
    const folder = from.slice(0, from.lastIndexOf("/") + 1);
    return [folder + clean, clean].find((name) => listed.has(name)) ?? null;
  };
  const follow = (name: string) => {
    setOpened((now) => new Set(now).add(name));
    requestAnimationFrame(() => document.getElementById(fileAnchor(name))?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" }));
  };
  const branches = threads.filter((thread) => thread.branch && thread.status !== "resolved");
  const card = (label: string, children: ReactNode) => <section aria-label={label} className="mb-5">
    <h3 className="panel-group-heading">{label}</h3>{children}
  </section>;
  return <>
    {card("Goal", <p className="px-1 text-body">{project.goal || "This project has no goal written down yet."}</p>)}
    {!current && card("Every thread receives", <>
      <p role="status" className="sr-only">Reading the project…</p>
      {/* The files' rows before they arrive, so nothing under them moves when they do. */}
      <ul aria-hidden className="desk-context-files">
        {[44, 28, 36].map((width) => <li key={width} className="desk-context-file"><span className="desk-context-row">
          <span className="h-3 rounded bg-muted" style={{ width: `${width}%` }} />
        </span></li>)}
      </ul>
    </>)}
    {detail && card("Every thread receives", <ul className="desk-context-files">
      {files.map((file) => <SharedFile key={file.name} {...file} open={opened.has(file.name)} onToggle={() => toggle(file.name)} resolve={resolve} onFollow={follow} />)}
    </ul>)}
    {detail && detail.repos.length > 0 && card("Repositories", <ul className="desk-context-files">
      {detail.repos.map((repo) => <li key={`${repo.machine}\0${repo.path}`} className="desk-context-file"><div className="desk-context-row">
        <FolderGit2 aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-footnote">{repo.path}</span>
        <span className="shrink-0 text-muted-foreground">{repo.machine || "this machine"}</span>
      </div></li>)}
    </ul>)}
    {detail && card("Agents", <div className="flex flex-wrap gap-1.5">
      {[detail.coordinatorProfile && `Coordinator · ${detail.coordinatorProfile}`, detail.threadProfile && `Threads · ${detail.threadProfile}`,
        detail.maxParallelThreads > 0 && `Max ${detail.maxParallelThreads} in parallel`].filter(Boolean).map((chip) => <span key={String(chip)} className="desk-context-chip">{chip}</span>)}
    </div>)}
    {branches.length > 0 && card("Branches", <ul className="desk-context-files">
      {branches.map((thread) => <li key={thread.id} className="desk-context-file"><div className="desk-context-row">
        <GitBranch aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0">{thread.title}</span>
        <span className="min-w-0 truncate font-mono text-footnote text-muted-foreground">{thread.branch}</span>
      </div></li>)}
    </ul>)}
    {current && !detail && <p className="px-1 text-footnote text-muted-foreground">Memory and instructions appear here with a newer Herdr Organizations, which can show them (<code>project show</code>).</p>}
  </>;
}
