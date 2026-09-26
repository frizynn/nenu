import { lazy, Suspense, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Code2, Download, Eye, RefreshCw, FileText, Loader2, X } from "lucide-react";
import { fetchPaneFile, paneFileUrl } from "@/lib/api";
import { FilePreviewContext } from "@/lib/file-preview-context";
import { useHoldReload } from "@/lib/reload-guard";
import { MarkdownText } from "./markdown-text";
import "./file-preview.css";

const PdfPreview = lazy(() => import("./pdf-preview"));
type DocumentData = { kind: "video"; url: string } | { kind: "pdf"; bytes: ArrayBuffer; url: string } | { kind: "image"; url: string } | { kind: "text"; text: string; markdown: boolean; url: string };
type HtmlView = "render" | "code";

export default function FilePreview({ paneId, session, path, onClose }: { paneId: string; session?: string; path: string; onClose: () => void }) {
  useHoldReload("document-preview", true);
  const [data, setData] = useState<DocumentData | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [htmlView, setHtmlView] = useState<HtmlView>("render");
  const panel = useRef<HTMLDivElement>(null);
  const openFile = useContext(FilePreviewContext);
  const openRelated = openFile ? (target: string) => openFile(target.startsWith("/") ? target : path.slice(0, path.lastIndexOf("/") + 1) + target) : null;
  const name = path.split("/").pop() || "Document";
  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    setError(""); setData(null); setHtmlView("render");
    if (/\.(mp4|m4v|mov|webm)$/i.test(path)) { setData({ kind: "video", url: paneFileUrl(paneId, path, session) }); return () => controller.abort(); }
    void (async () => {
      const response = await fetchPaneFile(paneId, path, session, controller.signal);
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
        if (!controller.signal.aborted) setData({ kind: "text", text, markdown: /\.(md|markdown)$/i.test(path), url });
      } else throw new Error("This file type cannot be previewed.");
    })().catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not open this file."); });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [paneId, session, path, attempt]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus({ preventScroll: true });
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);

  return createPortal(<div className="file-preview-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={panel} role="dialog" aria-modal="true" aria-label={name} tabIndex={-1} className="file-preview-panel" onKeyDown={(event) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
      if (event.key === "Tab") {
        const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]') ?? []);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus({ preventScroll: true }); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first?.focus({ preventScroll: true }); }
      }
    }}>
      <header className="file-preview-header">
        <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1"><h2 className="truncate text-sm font-medium">{name}</h2><p className="truncate text-xs text-muted-foreground" title={path}>{path}</p></div>
        <button type="button" aria-label="Refresh preview" onClick={() => setAttempt(n=>n+1)} className="file-preview-action"><RefreshCw className="size-4" /></button>
        {data && <a href={data.url} download={name} aria-label="Download file" className="file-preview-action"><Download className="size-4" /></a>}
        <button type="button" aria-label="Close document" onClick={onClose} className="file-preview-action"><X className="size-5" /></button>
      </header>
      {data?.kind === "text" && /\.html?$/i.test(path) && <div className="file-preview-tabs" role="tablist" aria-label="HTML preview mode">
        {(["render", "code"] as const).map((view) => <button key={view} type="button" role="tab" aria-selected={htmlView === view} tabIndex={htmlView === view ? 0 : -1} className="file-preview-tab" onClick={() => setHtmlView(view)} onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
          event.preventDefault();
          const next = view === "render" ? "code" : "render";
          setHtmlView(next);
          panel.current?.querySelector<HTMLElement>(`[role="tab"][aria-selected="${next === view}"]`)?.focus();
        }}>{view === "render" ? <><Eye className="size-4" aria-hidden="true" />Render</> : <><Code2 className="size-4" aria-hidden="true" />Código</>}</button>)}
      </div>}
      <div className="file-preview-content">
        {error ? <div role="alert" className="p-6 text-sm">
          <p>{error}</p>
          <button type="button" className="mt-3 min-h-11 rounded-md border px-4" onClick={() => setAttempt((value) => value + 1)}>Retry</button>
        </div> : <DocumentContent data={data} name={name} openRelated={openRelated} html={/\.html?$/i.test(path) ? htmlView : null} renderUrl={paneFileUrl(paneId, path, session).replace("/file?", "/html-preview?")} onError={setError} />}
      </div>
    </div>
  </div>, document.body);
}

function DocumentContent({ data, name, openRelated, html, renderUrl, onError }: { data: DocumentData | null; name: string; openRelated: ((path: string) => void) | null; html: HtmlView | null; renderUrl: string; onError: (message: string) => void }) {
  if (!data) return <Loading />;
  switch (data.kind) {
    case "pdf":
      return <Suspense fallback={<Loading />}><PdfPreview bytes={data.bytes} /></Suspense>;
    case "video":
      return <video src={data.url} controls playsInline preload="metadata" aria-label={name} className="max-h-full w-full" onError={() => onError("Could not play this video. Download it to open in another player.")} />;
    case "image":
      return <img src={data.url} alt={name} className="mx-auto h-auto max-w-full" />;
    case "text":
      if (html === "render") return <iframe
        title={`Rendered preview of ${name}`}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        src={renderUrl}
        className="file-preview-html"
        onError={() => onError("Could not render this HTML file.")}
      />;
      if (!data.markdown) return <pre className="overflow-x-auto p-5 font-mono text-sm whitespace-pre">{data.text}</pre>;
      return <FilePreviewContext.Provider value={openRelated}>
        <MarkdownText text={data.text} className="mx-auto max-w-3xl p-5 sm:p-8" />
      </FilePreviewContext.Provider>;
  }
}

function Loading() { return <div role="status" className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin motion-reduce:animate-none" />Loading document…</div>; }
