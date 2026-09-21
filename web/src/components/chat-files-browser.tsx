import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { FileText, Image, Loader2, Paperclip, RefreshCw } from "lucide-react";

import { BottomSheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { fetchHistory, paneFileUrl } from "@/lib/api";
import { chatFileReferences, type ChatFileKind } from "@/lib/chat-files";
import { FilePreviewContext } from "@/lib/file-preview-context";
import type { PaneHistoryResponse, TranscriptEntry } from "@/lib/types";

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

export function ChatFilesBrowser({
  paneId,
  session,
  history,
}: {
  paneId: string;
  session?: string;
  history: PaneHistoryResponse | null;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<ChatFileKind>("file");
  const [runKey, setRunKey] = useState(0);
  const [scan, setScan] = useState<ScanState>(EMPTY_SCAN);
  const seed = useRef<PaneHistoryResponse | null>(history);
  const accumulated = useRef<TranscriptEntry[]>([]);
  const cursor = useRef<AvailableHistory | null>(null);
  const knownTotal = useRef(0);
  const knownFileTruncated = useRef(false);
  const openFile = useContext(FilePreviewContext);

  // Scope changes must immediately dismiss the old pane's modal and discard every old path. This
  // is defensive even though AgentChat normally remounts by pane: a stale URL must never flash
  // while React adopts a new route tree.
  useEffect(() => {
    setOpen(false);
    seed.current = history;
    accumulated.current = [];
    cursor.current = null;
    knownTotal.current = 0;
    knownFileTruncated.current = false;
    setScan(EMPTY_SCAN);
  }, [paneId, session]);

  useEffect(() => {
    if (!open) seed.current = history;
  }, [history, open]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let active = true;
    const update = (value: ScanState) => { if (active) setScan(value); };

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
        if (page?.available) cursor.current = page;
        knownTotal.current = total;
        knownFileTruncated.current = fileTruncated;
        if (!controller.signal.aborted) update({ entries, total, fileTruncated, batchPaused, pagingBoundary, loading: false, error: true });
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [open, paneId, session, runKey]);

  function openReference(path: string) {
    // Avoid stacking the preview dialog over this modal. Closing first restores focus to the trigger;
    // the next frame then lets FilePreview take focus from a clean accessibility tree.
    setOpen(false);
    requestAnimationFrame(() => openFile?.(path));
  }

  const references = useMemo(() => chatFileReferences(scan.entries), [scan.entries]);
  const photos = references.filter((reference) => reference.kind === "photo");
  const files = references.filter((reference) => reference.kind === "file");
  const shown = filter === "photo" ? photos : files;

  return (
    <>
      <button
        type="button"
        aria-label="Files and photos"
        title="Files and photos"
        onClick={() => {
          seed.current = history;
          accumulated.current = [];
          cursor.current = null;
          knownTotal.current = 0;
          knownFileTruncated.current = false;
          setScan(EMPTY_SCAN);
          setOpen(true);
        }}
        className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground active:bg-muted lg:-mr-1 lg:size-8"
      >
        <Paperclip aria-hidden="true" className="size-4" />
      </button>

      <BottomSheet open={open} onClose={() => setOpen(false)} title="Files and photos" className="max-h-[82dvh]">
        <div className="mb-4 grid grid-cols-2 gap-2" role="group" aria-label="File type">
          <FilterButton active={filter === "file"} onClick={() => setFilter("file")} icon={<FileText className="size-4" />}>
            Files{!scan.loading ? ` · ${files.length}` : ""}
          </FilterButton>
          <FilterButton active={filter === "photo"} onClick={() => setFilter("photo")} icon={<Image className="size-4" />}>
            Photos{!scan.loading ? ` · ${photos.length}` : ""}
          </FilterButton>
        </div>

        {scan.loading && (
          <div role="status" className="mb-3 flex min-h-11 items-center gap-2 rounded-lg bg-muted/50 px-3 text-sm text-muted-foreground">
            <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
            Scanning the full conversation…
          </div>
        )}

        {scan.error && (
          <div role="alert" className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <span>Some older messages could not be scanned.</span>
            <Button variant="outline" size="sm" className="min-h-11" onClick={() => setRunKey((value) => value + 1)}>
              <RefreshCw aria-hidden="true" className="size-4" /> Retry
            </Button>
          </div>
        )}

        {shown.length > 0 ? filter === "photo" ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {shown.map((reference) => (
              <button key={reference.path} type="button" onClick={() => openReference(reference.path)}
                className="group min-h-11 overflow-hidden rounded-xl border bg-muted/30 text-left transition-colors hover:border-primary/40 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring">
                <div className="relative aspect-square overflow-hidden bg-muted">
                  <Image aria-hidden="true" className="absolute left-1/2 top-1/2 size-7 -translate-x-1/2 -translate-y-1/2 text-muted-foreground/50" />
                  <img src={paneFileUrl(paneId, reference.path, session)} alt="" loading="lazy"
                    className="relative size-full object-cover" onError={(event) => { event.currentTarget.hidden = true; }} />
                </div>
                <div className="px-2.5 py-2">
                  <p className="truncate text-sm font-medium">{reference.name}</p>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">{reference.path}</p>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <ul className="divide-y rounded-xl border">
            {shown.map((reference) => (
              <li key={reference.path}>
                <button type="button" aria-label={`Open ${reference.name}`} onClick={() => openReference(reference.path)}
                  className="flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><FileText aria-hidden="true" className="size-4" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{reference.name}</span>
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">{reference.path}</span>
                  </span>
                  {reference.mentions > 1 && <span className="shrink-0 text-xs text-muted-foreground">{reference.mentions} mentions</span>}
                </button>
              </li>
            ))}
          </ul>
        ) : !scan.loading && (
          <div className="rounded-xl border border-dashed px-5 py-10 text-center">
            {filter === "photo" ? <Image aria-hidden="true" className="mx-auto mb-3 size-7 text-muted-foreground/60" /> : <FileText aria-hidden="true" className="mx-auto mb-3 size-7 text-muted-foreground/60" />}
            <p className="text-sm font-medium">No {filter === "photo" ? "photos" : "files"} in this conversation</p>
            <p className="mt-1 text-xs text-muted-foreground">References appear here when the chat mentions a previewable project path.</p>
          </div>
        )}

        {(scan.batchPaused || scan.fileTruncated || scan.pagingBoundary) && (
          <div role="status" className="mt-4 rounded-lg bg-muted/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            {scan.batchPaused
              ? <div className="flex items-center justify-between gap-3"><span>Scanned the newest {scan.entries.length.toLocaleString()} of {Math.max(scan.total, scan.entries.length).toLocaleString()} messages.</span><Button variant="outline" size="sm" className="min-h-11 bg-background" onClick={() => setRunKey((value) => value + 1)}>Load older files</Button></div>
              : scan.fileTruncated
                ? "The journal retains only the newest part of this session, so earlier references are unavailable."
                : "The conversation changed while older messages were loading; some earlier references may be missing."}
          </div>
        )}
      </BottomSheet>
    </>
  );
}

function FilterButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick}
      className={`flex min-h-11 items-center justify-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring ${active ? "border-primary/40 bg-primary/10 text-foreground" : "bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground"}`}>
      {icon}{children}
    </button>
  );
}
