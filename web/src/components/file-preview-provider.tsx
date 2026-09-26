import { paneFileUrl } from "@/lib/api";
import { Component, lazy, Suspense, useCallback, useState, type ReactNode } from "react";
import { FilePreviewContext, FileMediaContext } from "@/lib/file-preview-context";

const FilePreview = lazy(() => import("./file-preview"));

class PreviewBoundary extends Component<{ children: ReactNode; onClose: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div role="alert" className="fixed bottom-4 right-4 z-50 max-w-[calc(100vw-32px)] rounded-lg border bg-background p-4 text-sm">
      <p>The document viewer could not load. Reopen Nenu and try again.</p>
      <button type="button" className="mt-2 min-h-11 px-3" onClick={this.props.onClose}>Close</button>
    </div>;
    return this.props.children;
  }
}

export function FilePreviewProvider({ paneId, session, children }: { paneId?: string; session?: string; children: ReactNode }) {
  const [selection, setSelection] = useState<{ paneId: string; session?: string; path: string } | null>(null);
  const open = useCallback((path: string) => { if (paneId) setSelection({ paneId, session, path }); }, [paneId, session]);
  const close = useCallback(() => setSelection(null), []);
  const visible = selection?.paneId === paneId && selection?.session === session ? selection : null;
  return <FileMediaContext.Provider value={paneId ? (path) => paneFileUrl(paneId, path, session) : null}><FilePreviewContext.Provider value={paneId ? open : null}>
    {children}
    {visible && <PreviewBoundary key={visible.path} onClose={close}><Suspense fallback={<div role="status" className="fixed bottom-4 right-4 z-50 rounded-lg border bg-background px-4 py-3 text-sm">Opening document…</div>}>
      <FilePreview key={`${paneId}:${session}:${visible.path}`} paneId={visible.paneId} session={session} path={visible.path} onClose={close} />
    </Suspense></PreviewBoundary>}
  </FilePreviewContext.Provider></FileMediaContext.Provider>;
}
