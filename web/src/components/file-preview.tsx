import { lazy, Suspense, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Download, Globe, ImageIcon, RefreshCw, FileText, Loader2, X } from "lucide-react";
import { fetchPaneFile, journalImageUrl, paneFileUrl } from "@/lib/api";
import { FilePreviewContext } from "@/lib/file-preview-context";
import { useHoldReload } from "@/lib/reload-guard";
import { MarkdownText } from "./markdown-text";
import { HtmlViewer } from "./html-viewer";
import type { PreviewItem } from "./file-preview-provider";
import "./file-preview.css";

const PdfPreview = lazy(() => import("./pdf-preview"));
type DocumentData = { kind: "video"; url: string } | { kind: "pdf"; bytes: ArrayBuffer; url: string } | { kind: "image"; url: string } | { kind: "text"; text: string; markdown: boolean; url: string };

const isHtml = (item: PreviewItem | undefined) => item?.kind === "file" && /\.html?$/i.test(item.path);

export default function FilePreview({ paneId, session, items, start = 0, path, onClose }: {
  paneId: string;
  session?: string;
  /** A gallery to step through; `path` is the one-file shorthand. */
  items?: readonly PreviewItem[];
  start?: number;
  path?: string;
  onClose: () => void;
}) {
  useHoldReload("document-preview", true);
  const list: readonly PreviewItem[] = items ?? (path ? [{ kind: "file", path }] : []);
  const [index, setIndex] = useState(start);
  const item = list[Math.min(index, list.length - 1)];
  const [data, setData] = useState<DocumentData | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const openFile = useContext(FilePreviewContext);
  const filePath = item?.kind === "file" ? item.path : "";
  const openRelated = openFile ? (target: string) => openFile(target.startsWith("/") ? target : filePath.slice(0, filePath.lastIndexOf("/") + 1) + target) : null;
  const name = item?.kind === "journal" ? item.label : filePath.split("/").pop() || "Document";
  const html = isHtml(item);
  const itemKey = item?.kind === "journal" ? `journal:${item.entry}:${item.index}` : `file:${filePath}`;

  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    setError(""); setData(null);
    if (!item || html) return;
    if (item.kind === "journal") { setData({ kind: "image", url: journalImageUrl(paneId, item.entry, item.index, session) }); return; }
    if (/\.(mp4|m4v|mov|webm)$/i.test(item.path)) { setData({ kind: "video", url: paneFileUrl(paneId, item.path, session) }); return; }
    void (async () => {
      const response = await fetchPaneFile(paneId, item.path, session, controller.signal);
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob);
      const type = response.headers.get("content-type")?.split(";")[0] ?? "";
      if (type === "application/pdf") {
        const bytes = await blob.arrayBuffer();
        if (!controller.signal.aborted) setData({ kind: "pdf", bytes, url });
      } else if (/^image\/(png|jpeg|gif|webp)$/.test(type)) setData({ kind: "image", url });
      else if (type.startsWith("text/")) {
        const text = await blob.text();
        if (!controller.signal.aborted) setData({ kind: "text", text, markdown: /\.(md|markdown)$/i.test(item.path), url });
      } else throw new Error("This file type cannot be previewed.");
    })().catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not open this file."); });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
    // itemKey names the item; the object itself is rebuilt on every render of a one-file preview.
  }, [paneId, session, itemKey, html, attempt]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus({ preventScroll: true });
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);

  const step = (by: number) => setIndex((current) => (current + by + list.length) % list.length);
  const downloadUrl = data?.url ?? (html ? paneFileUrl(paneId, filePath, session) : undefined);
  const Icon = html ? Globe : item?.kind === "journal" ? ImageIcon : FileText;

  return createPortal(<div className="file-preview-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={panel} role="dialog" aria-modal="true" aria-label={name} tabIndex={-1} className={`file-preview-panel${html ? " file-preview-panel--full" : ""}`} onKeyDown={(event) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
      if (list.length > 1 && (event.key === "ArrowLeft" || event.key === "ArrowRight")) { event.preventDefault(); step(event.key === "ArrowLeft" ? -1 : 1); }
      if (event.key === "Tab") {
        const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]') ?? []);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus({ preventScroll: true }); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first?.focus({ preventScroll: true }); }
      }
    }}>
      <header className="file-preview-header">
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1"><h2 className="truncate text-sm font-medium">{name}</h2>
          <p className="truncate text-xs text-muted-foreground" title={filePath || undefined}>{item?.kind === "journal" ? "From the conversation" : filePath}</p></div>
        <button type="button" aria-label="Refresh preview" onClick={() => setAttempt(n=>n+1)} className="file-preview-action"><RefreshCw className="size-4" /></button>
        {downloadUrl && <a href={downloadUrl} download={name} aria-label="Download file" className="file-preview-action"><Download className="size-4" /></a>}
        <button type="button" aria-label="Close document" onClick={onClose} className="file-preview-action"><X className="size-5" /></button>
      </header>
      {html ? <HtmlViewer paneId={paneId} session={session} path={filePath} name={name} reload={attempt} />
        : <div className="file-preview-content">
          {error ? <div role="alert" className="p-6 text-sm">
            <p>{error}</p>
            <button type="button" className="mt-3 min-h-11 rounded-md border px-4" onClick={() => setAttempt((value) => value + 1)}>Retry</button>
          </div> : <DocumentContent data={data} name={name} openRelated={openRelated} onError={setError} />}
        </div>}
      {list.length > 1 && <nav aria-label="Gallery" className="file-preview-gallery">
        <button type="button" aria-label="Previous" onClick={() => step(-1)} className="file-preview-action"><ChevronLeft className="size-5" /></button>
        <span aria-live="polite" className="min-w-28 text-center text-sm">{name} <span className="text-muted-foreground">· {index + 1} of {list.length}</span></span>
        <button type="button" aria-label="Next" onClick={() => step(1)} className="file-preview-action"><ChevronRight className="size-5" /></button>
      </nav>}
    </div>
  </div>, document.body);
}

function DocumentContent({ data, name, openRelated, onError }: { data: DocumentData | null; name: string; openRelated: ((path: string) => void) | null; onError: (message: string) => void }) {
  if (!data) return <Loading />;
  switch (data.kind) {
    case "pdf":
      return <Suspense fallback={<Loading />}><PdfPreview bytes={data.bytes} /></Suspense>;
    case "video":
      return <video src={data.url} controls playsInline preload="metadata" aria-label={name} className="max-h-full w-full" onError={() => onError("Could not play this video. Download it to open in another player.")} />;
    case "image":
      return <img src={data.url} alt={name} decoding="async" className="mx-auto h-auto max-w-full" onError={() => onError("Could not load this image.")} />;
    case "text":
      if (!data.markdown) return <pre className="overflow-x-auto p-5 font-mono text-sm whitespace-pre">{data.text}</pre>;
      return <FilePreviewContext.Provider value={openRelated}>
        <MarkdownText text={data.text} className="mx-auto max-w-3xl p-5 sm:p-8" />
      </FilePreviewContext.Provider>;
  }
}

function Loading() { return <div role="status" className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin motion-reduce:animate-none" />Loading document…</div>; }
