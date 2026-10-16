import { ArtifactsPanel } from "./artifacts-panel";
import { ProjectFilesBrowser } from "./project-files-browser";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FileIcon } from "@/components/ui/file-icon";
import { FileText, Pending, Paperclip, RefreshCw } from "@/components/ui/icon";

import { BottomSheet, finePointer } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { SEGMENT_TRACK, segmentClass } from "@/components/dock-tile";
import type { ActivityArtifact } from "@/lib/activity";
import { fetchHistory } from "@/lib/api";
import { chatFileReferences, fileExtension } from "@/lib/chat-files";
import { FilePreviewContext } from "@/lib/file-preview-context";
import type { PaneHistoryResponse, TranscriptEntry } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FileLink } from "./file-link";

type AvailableHistory = Extract<PaneHistoryResponse, { available: true }>;
type ScanState = {
  entries: TranscriptEntry[];
  loading: boolean;
  error: boolean;
  total: number;
  fileTruncated: boolean;
  batchPaused: boolean;
  pagingBoundary: boolean;
};

const PAGE_SIZE = 120;
/** Pause after each bounded batch; the user can continue without losing already-found references. */
export const MAX_SCANNED_ENTRIES = 6_000;

const EMPTY_SCAN: ScanState = {
  entries: [], loading: false, error: false, total: 0,
  fileTruncated: false, batchPaused: false, pagingBoundary: false,
};

function mergeEntries(older: TranscriptEntry[], newer: TranscriptEntry[]): TranscriptEntry[] {
  const seen = new Set<string>();
  return [...older, ...newer].filter((entry) => {
    if (seen.has(entry.uuid)) return false;
    seen.add(entry.uuid);
    return true;
  });
}

/**
 * The whole conversation of a pane, read page by page while `active`, for the files it names: from
 * `seed` (the history already on screen) back to the start, in bounded batches. Pages read survive a
 * pause; `reset` starts over from a new seed, `retry` resumes. A new pane or session starts over.
 */
export function useConversationScan(paneId: string, session: string | undefined, active: boolean, seedHistory?: PaneHistoryResponse | null) {
  const [runKey, setRunKey] = useState(0);
  const [scan, setScan] = useState<ScanState>(EMPTY_SCAN);
  const seed = useRef<PaneHistoryResponse | null>(seedHistory ?? null);
  const accumulated = useRef<TranscriptEntry[]>([]);
  const cursor = useRef<AvailableHistory | null>(null);
  const knownTotal = useRef(0);
  const knownFileTruncated = useRef(false);
  const reset = (next: PaneHistoryResponse | null | undefined) => {
    seed.current = next ?? null;
    accumulated.current = [];
    cursor.current = null;
    knownTotal.current = 0;
    knownFileTruncated.current = false;
    setScan(EMPTY_SCAN);
  };

  useEffect(() => {
    reset(seedHistory);
    // Only a new scope starts over; a newer seed waits for the next reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, session]);

  useEffect(() => {
    if (seedHistory !== undefined) seed.current = seedHistory;
  }, [seedHistory]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let live = true;
    const update = (value: ScanState) => { if (live) setScan(value); };

    void (async () => {
      let page = cursor.current ?? seed.current;
      let entries = accumulated.current.length > 0
        ? accumulated.current
        : page?.available ? page.entries : [];
      let total = Math.max(knownTotal.current, page?.available ? page.total : 0);
      let fileTruncated = knownFileTruncated.current || (page?.available ? page.fileTruncated : false);
      let batchPaused = false;
      let pagingBoundary = false;
      update({ entries, total, fileTruncated, batchPaused, pagingBoundary, loading: true, error: false });
      try {
        if (!page || !page.available) page = await fetchHistory(paneId, { limit: PAGE_SIZE }, session, controller.signal);
        if (!page.available) {
          update({ ...EMPTY_SCAN, loading: false });
          return;
        }
        entries = mergeEntries(page.entries, entries);
        total = Math.max(total, page.total);
        fileTruncated ||= page.fileTruncated;
        let cursorPage: AvailableHistory = page;
        let scannedThisBatch = 0;
        update({ entries, total, fileTruncated, batchPaused, pagingBoundary, loading: cursorPage.hasMore, error: false });

        while (cursorPage.hasMore) {
          if (scannedThisBatch >= MAX_SCANNED_ENTRIES) {
            batchPaused = true;
            break;
          }
          const before = cursorPage.entries[0]?.uuid;
          if (!before) {
            pagingBoundary = true;
            break;
          }
          const older = await fetchHistory(paneId, { limit: PAGE_SIZE, before }, session, controller.signal);
          if (!older.available) {
            pagingBoundary = true;
            break;
          }
          const merged = mergeEntries(older.entries, entries);
          if (merged.length === entries.length) {
            pagingBoundary = true;
            break;
          }
          scannedThisBatch += Math.max(0, merged.length - entries.length);
          entries = merged;
          total = Math.max(total, older.total);
          fileTruncated ||= older.fileTruncated;
          cursorPage = older;
          accumulated.current = entries;
          cursor.current = cursorPage;
          knownTotal.current = total;
          knownFileTruncated.current = fileTruncated;
          update({ entries, total, fileTruncated, batchPaused, pagingBoundary, loading: true, error: false });
        }
        if (cursorPage.hasMore && scannedThisBatch >= MAX_SCANNED_ENTRIES) batchPaused = true;
        accumulated.current = entries;
        cursor.current = cursorPage.hasMore ? cursorPage : null;
        knownTotal.current = total;
        knownFileTruncated.current = fileTruncated;
        update({ entries, total, fileTruncated, batchPaused, pagingBoundary, loading: false, error: false });
      } catch {
        accumulated.current = entries;
        // The loop moves the cursor with every page it adds; only a scan stopped before its first
        // older page resumes from the page it started on.
        if (page?.available) cursor.current ??= page;
        knownTotal.current = total;
        knownFileTruncated.current = fileTruncated;
        if (!controller.signal.aborted) update({ entries, total, fileTruncated, batchPaused, pagingBoundary, loading: false, error: true });
      }
    })();

    return () => {
      live = false;
      controller.abort();
    };
  }, [active, paneId, session, runKey]);

  return { scan, reset, retry: () => setRunKey((value) => value + 1) };
}

export function ChatFilesBrowser({
  paneId,
  session,
  history,
  published,
  open: openProp,
  onOpenChange,
}: {
  paneId: string;
  session?: string;
  history: PaneHistoryResponse | null;
  /** The session's claude.ai pages (Activity), listed first under Artifacts. */
  published?: ActivityArtifact[];
  /** Controlled from a menu item: no trigger of its own is rendered. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const controlled = openProp !== undefined;
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlled ? openProp : ownOpen;
  const setOpen = (next: boolean) => {
    if (!controlled) setOwnOpen(next);
    onOpenChange?.(next);
  };
  const [filter, setFilter] = useState<"artifacts" | "project" | "file">("project");
  const [query, setQuery] = useState("");
  const [extension, setExtension] = useState("all");
  const [sort, setSort] = useState("recent");
  const openFile = useContext(FilePreviewContext);
  const { scan, reset, retry } = useConversationScan(paneId, session, open && filter !== "project", open ? undefined : history);

  // Scope changes must immediately dismiss the old pane's modal and discard every old path. This
  // is defensive even though AgentChat normally remounts by pane: a stale URL must never flash
  // while React adopts a new route tree.
  useEffect(() => {
    setOpen(false);
  }, [paneId, session]);

  function openReference(path: string) {
    // Avoid stacking the preview dialog over this modal. Closing first restores focus to the trigger;
    // the next frame then lets FilePreview take focus from a clean accessibility tree.
    setOpen(false);
    requestAnimationFrame(() => openFile?.(path));
  }

  const references = useMemo(() => chatFileReferences(scan.entries), [scan.entries]);

  const files = references.filter(reference => reference.kind === "file");
  const extensions = [...new Set(files.map(fileExtension))].sort();
  const shown = files.filter(r => (extension === "all" || fileExtension(r) === extension)
    && r.path.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => (sort === "extension" ? fileExtension(a).localeCompare(fileExtension(b))
      : sort === "name" ? a.name.localeCompare(b.name) : 0) || b.lastSeen.order - a.lastSeen.order);
  /** Every open starts from the history on screen now, on the project tab, with no filters. */
  function begin() {
    reset(history);
    setFilter("project"); setQuery(""); setExtension("all");
  }
  const openedFromMenu = controlled && openProp;
  useLayoutEffect(() => {
    if (openedFromMenu) begin();
  }, [openedFromMenu]);
  // Project opens first and has no search; picking Files, the list that has one, puts the cursor there on a
  // desk, as the sheet does for Commands. A touch screen keeps its keyboard down until a tap.
  const searchRef = useRef<HTMLInputElement>(null);
  const searchNext = useRef(false);
  useEffect(() => {
    if (searchNext.current) searchRef.current?.focus({ preventScroll: true });
    searchNext.current = false;
  }, [filter]);
  function changeFilter(next: typeof filter) {
    setFilter(next);
    setExtension("all");
    searchNext.current = next === "file" && finePointer();
  }

  return (
    <>
      {!controlled && <button
        type="button"
        aria-label="Artifacts and files"
        title="Artifacts and files"
        onClick={() => { begin(); setOpen(true); }}
        className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/50 active:bg-muted lg:size-8"
      >
        <Paperclip aria-hidden="true" className="size-4" />
      </button>}

      <BottomSheet open={open} onClose={() => setOpen(false)} title="Artifacts and files" desktop="dialog">
        <div className={cn("mb-4", SEGMENT_TRACK)} role="group" aria-label="File type">
          <FilterButton active={filter === "artifacts"} onClick={() => changeFilter("artifacts")}>Artifacts</FilterButton>
          <FilterButton active={filter === "project"} onClick={() => changeFilter("project")}>Project</FilterButton>
          <FilterButton active={filter === "file"} onClick={() => changeFilter("file")}>
            Files{!scan.loading ? ` · ${files.length}` : ""}
          </FilterButton>
        </div>

        {filter === "project" ? <ProjectFilesBrowser key={`${paneId}:${session}`} paneId={paneId} session={session} onOpen={openReference} /> : <>
        {filter === "file" && <div className="mb-3 flex flex-wrap gap-2">
          <input ref={searchRef} aria-label="Search files" placeholder="Search name or path…" value={query} onChange={event => setQuery(event.target.value)} className="min-h-11 min-w-0 flex-[1_1_100%] rounded-md border bg-background px-3 text-sm" />
          <select aria-label="File extension" value={extension} onChange={event => setExtension(event.target.value)} className="min-h-11 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs">
            <option value="all">Any format</option>{extensions.map(ext => <option key={ext} value={ext}>.{ext}</option>)}
          </select>
          <select aria-label="Sort files" value={sort} onChange={event => setSort(event.target.value)} className="min-h-11 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs">
            <option value="recent">Recent first</option><option value="extension">Extension</option><option value="name">Name</option>
          </select>
        </div>}
        {scan.loading && (
          <div role="status" className="mb-3 flex min-h-11 items-center gap-2 rounded-lg bg-muted/50 px-3 text-sm text-muted-foreground">
            <Pending aria-hidden="true" className="size-4" />
            Scanning the full conversation…
          </div>
        )}

        {scan.error && (
          <div role="alert" className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <span>Some older messages could not be scanned.</span>
            <Button variant="outline" size="sm" className="min-h-11" onClick={retry}>
              <RefreshCw aria-hidden="true" className="size-4" /> Retry
            </Button>
          </div>
        )}

        {filter === "artifacts" ? <ArtifactsPanel paneId={paneId} session={session} references={references} published={published} ready={!scan.loading} onOpen={openReference} />
        : shown.length > 0 ? (
          <ul className="divide-y rounded-xl border">
            {shown.map((reference) => (
              <li key={reference.path}>
                <FileLink path={reference.path} onOpen={() => openReference(reference.path)} label={`Open ${reference.name}`}
                  className="flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><FileIcon name={reference.name} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{reference.name}</span>
                    <span className="block truncate font-mono text-caption text-muted-foreground">{reference.path}</span>
                  </span>
                  <span className="shrink-0 text-right text-xs text-muted-foreground">
                    <span className="block">{fileExtension(reference).toUpperCase()}</span>
                    {reference.lastSeen.timestamp && <time className="block" dateTime={reference.lastSeen.timestamp}>{new Date(reference.lastSeen.timestamp).toLocaleDateString([], { month: "short", day: "numeric" })}</time>}
                  </span>
                </FileLink>
              </li>
            ))}
          </ul>
        ) : !scan.loading && (
          <div className="rounded-xl border border-dashed px-5 py-10 text-center">
            <FileText aria-hidden="true" className="mx-auto mb-3 size-7 text-muted-foreground/60" />
            <p className="text-sm font-medium">{query || extension !== "all" ? "No matching files" : "No files in this conversation"}</p>
            <p className="mt-1 text-xs text-muted-foreground">Browse Project for the working directory.</p>
          </div>
        )}

        {(scan.batchPaused || scan.fileTruncated || scan.pagingBoundary) && (
          <div role="status" className="mt-4 rounded-lg bg-muted/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            {scan.batchPaused
              ? <div className="flex items-center justify-between gap-3"><span>Scanned the newest {scan.entries.length.toLocaleString()} of {Math.max(scan.total, scan.entries.length).toLocaleString()} messages.</span><Button variant="outline" size="sm" className="min-h-11 bg-background" onClick={retry}>Load older files</Button></div>
              : scan.fileTruncated
                ? "The journal retains only the newest part of this session, so earlier references are unavailable."
                : "The conversation changed while older messages were loading; some earlier references may be missing."}
          </div>
        )}
        </>}
      </BottomSheet>
    </>
  );
}

// Three names share a phone's width, so a segment takes the footnote step (an iOS segmented control's
// size) and a 2px inset: every name, a three-digit Files count included, fits from 320px at the
// default text size. Larger browser text ends a name in an ellipsis inside its own segment.
function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick} className={cn(segmentClass(active), "px-0.5 text-footnote")}>
      <span className="block truncate">{children}</span>
    </button>
  );
}
