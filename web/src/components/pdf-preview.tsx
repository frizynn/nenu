import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "@/components/ui/icon";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

/** One page/canvas at a time bounds phone memory independently of the document's page count. */
export default function PdfPreview({ bytes }: { bytes: ArrayBuffer }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [rendering, setRendering] = useState(true);
  const [width, setWidth] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderTask = useRef<RenderTask | null>(null);

  useEffect(() => {
    let stopped = false;
    // The worker transfers ownership; copy so StrictMode/reopening never receives detached bytes.
    const task = getDocument({
      data: new Uint8Array(bytes.slice(0)), disableFontFace: true, useSystemFonts: true,
      canvasMaxAreaInBytes: 16_000_000, cMapUrl: "/pdfjs/cmaps/", cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/", wasmUrl: "/pdfjs/wasm/",
      // Use PDF.js's bundled JS image decoders; the app keeps its strict no-eval CSP.
      useWasm: false,
    });
    void task.promise.then((pdf) => { if (!stopped) setDocument(pdf); }).catch((cause: unknown) => { if (!stopped) setError(cause instanceof Error ? cause.message : "Could not read PDF."); });
    return () => { stopped = true; renderTask.current?.cancel(); void task.destroy(); };
  }, [bytes]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(1, Math.floor(element.clientWidth - 24)));
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!document || !width) return;
    let stopped = false;
    const previous = renderTask.current;
    previous?.cancel();
    setRendering(true); setError("");
    void (async () => {
      await previous?.promise.catch(() => {});
      const pdfPage = await document.getPage(page);
      try {
        if (stopped || !canvas.current) return;
        const base = pdfPage.getViewport({ scale: 1 });
        const cssScale = Math.min(width, 1400) / base.width;
        // Cap pixel density and total canvas area, including abnormally long PDF pages.
        const density = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(4_000_000 / (base.width * base.height * cssScale * cssScale)));
        const viewport = pdfPage.getViewport({ scale: cssScale * density });
        const element = canvas.current;
        element.width = Math.ceil(viewport.width); element.height = Math.ceil(viewport.height);
        element.style.width = `${base.width * cssScale}px`; element.style.height = `${base.height * cssScale}px`;
        const task = pdfPage.render({ canvas: element, viewport });
        renderTask.current = task;
        await task.promise;
        if (!stopped) setRendering(false);
      } finally {
        pdfPage.cleanup();
      }
    })().catch((cause: unknown) => { if (!stopped) { setRendering(false); setError(cause instanceof Error ? cause.message : "Could not render this page."); } });
    return () => { stopped = true; renderTask.current?.cancel(); };
  }, [document, page, width]);

  return <div ref={host} className="min-w-0">
    <div className="pdf-preview-toolbar">
      <button type="button" className="file-preview-action disabled:opacity-30" aria-label="Previous page" disabled={!document || page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft className="size-4" /></button>
      <span aria-live="polite">{document ? `${page} / ${document.numPages}` : "Opening PDF…"}</span>
      <button type="button" className="file-preview-action disabled:opacity-30" aria-label="Next page" disabled={!document || page >= document.numPages} onClick={() => setPage((value) => value + 1)}><ChevronRight className="size-4" /></button>
    </div>
    {error ? <p role="alert" className="p-5 text-footnote">{error}</p> : <div className="relative p-3" aria-busy={rendering}>
      {rendering && <p role="status" className="absolute inset-x-3 top-4 text-center text-xs text-muted-foreground">Rendering page…</p>}
      <canvas ref={canvas} aria-label={`PDF page ${page}`} className="mx-auto bg-white" />
    </div>}
  </div>;
}
