import { checkForUpdate } from "@/lib/pwa";
import { journalImageUrl, paneFileUrl } from "@/lib/api";
import { Component, createContext, lazy, Suspense, useCallback, useMemo, useState, type ReactNode } from "react";
import { FilePreviewContext, FileMediaContext } from "@/lib/file-preview-context";

const FilePreview = lazy(() => import("./file-preview"));

/** One thing the viewer can show: a file the bridge resolves, or an image the journal holds inline. */
export type PreviewItem =
  | { kind: "file"; path: string }
  | { kind: "journal"; entry: string; index: number; label: string };

export interface MediaViewer {
  paneId: string;
  session?: string;
  /** Bytes of a journal image, addressed by entry and index, never by path (ADR 0059). */
  journalUrl: (entry: string, index: number) => string;
  /** Open a gallery at `start`; the viewer steps through `items` with previous and next. */
  open: (items: readonly PreviewItem[], start?: number) => void;
}

export const MediaViewerContext = createContext<MediaViewer | null>(null);

class PreviewBoundary extends Component<{ children: ReactNode; onClose: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div role="alert" className="fixed bottom-4 right-4 z-50 max-w-[calc(100vw-32px)] rounded-lg border bg-background p-4 text-sm">
      <p>The document viewer could not load. Reload Nenu to try again.</p>
      <div className="mt-2 flex gap-2"><button type="button" className="min-h-11 rounded-md border px-3" onClick={() => { void checkForUpdate(); }}>Reload Nenu</button><button type="button" className="min-h-11 px-3" onClick={this.props.onClose}>Close</button></div>
    </div>;
    return this.props.children;
  }
}

interface Selection { paneId: string; session?: string; items: readonly PreviewItem[]; start: number; seq: number }

export function FilePreviewProvider({ paneId, session, children }: { paneId?: string; session?: string; children: ReactNode }) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const openItems = useCallback((items: readonly PreviewItem[], start = 0) => {
    if (paneId && items.length) setSelection((previous) => ({ paneId, session, items, start: Math.min(Math.max(start, 0), items.length - 1), seq: (previous?.seq ?? 0) + 1 }));
  }, [paneId, session]);
  const open = useCallback((path: string) => openItems([{ kind: "file", path }]), [openItems]);
  const close = useCallback(() => setSelection(null), []);
  const viewer = useMemo<MediaViewer | null>(() => paneId ? {
    paneId,
    session,
    journalUrl: (entry, index) => journalImageUrl(paneId, entry, index, session),
    open: openItems,
  } : null, [paneId, session, openItems]);
  const visible = selection?.paneId === paneId && selection?.session === session ? selection : null;
  return <FileMediaContext.Provider value={paneId ? (path) => paneFileUrl(paneId, path, session) : null}><FilePreviewContext.Provider value={paneId ? open : null}><MediaViewerContext.Provider value={viewer}>
    {children}
    {visible && <PreviewBoundary key={visible.seq} onClose={close}><Suspense fallback={<div role="status" className="fixed bottom-4 right-4 z-50 rounded-lg border bg-background px-4 py-3 text-sm">Opening document…</div>}>
      <FilePreview key={`${paneId}:${session}`} paneId={visible.paneId} session={session} items={visible.items} start={visible.start} onClose={close} />
    </Suspense></PreviewBoundary>}
  </MediaViewerContext.Provider></FilePreviewContext.Provider></FileMediaContext.Provider>;
}
