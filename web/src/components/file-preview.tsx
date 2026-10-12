import { lazy, Suspense, useContext, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Download, FileText, Globe, Loader2, MoreHorizontal, RefreshCw, X } from "lucide-react";
import { useMediaQuery } from "@/hooks/use-media-query";
import { fetchArtifactMetadata, fetchPaneFile, journalImageUrl, PaneFileError, paneFileUrl } from "@/lib/api";
import { displayPath } from "@/lib/display-path";
import { shortCwd } from "@/lib/format";
import { paneOwningPath, type PaneRoot } from "@/lib/file-links";
import { FilePreviewContext } from "@/lib/file-preview-context";
import { shortName, useFitted } from "@/lib/fit-text";
import { IMAGE_EXTENSION } from "@/lib/message-images";
import { useHoldReload } from "@/lib/reload-guard";
import { cn } from "@/lib/utils";
import { ActionGroups } from "./conversation-actions";
import { MarkdownText } from "./markdown-text";
import { HtmlViewer } from "./html-viewer";
import { FileUnavailable, type FileFailure } from "./file-unavailable";
import { ImageViewer, reducedMotion, type ViewerImage } from "./image-viewer";
import { WorkbenchPopover } from "./ui/workbench-popover";
import type { PreviewItem } from "./file-preview-provider";
import "./file-preview.css";

const PdfPreview = lazy(() => import("./pdf-preview"));
type DocumentData = { kind: "video"; url: string } | { kind: "pdf"; bytes: ArrayBuffer; url: string } | { kind: "image"; url: string } | { kind: "text"; text: string; markdown: boolean; url: string };

const isHtml = (item: PreviewItem | undefined) => item?.kind === "file" && /\.html?$/i.test(item.path);
/** Pictures open in the black viewer; SVG stays a document (CLAUDE.md, ADR 0059). */
const isImage = (item: PreviewItem | undefined) => item?.kind === "journal" || (item?.kind === "file" && IMAGE_EXTENSION.test(item.path));
const keyOf = (item: PreviewItem | undefined) => item?.kind === "journal" ? `journal:${item.entry}:${item.index}` : `file:${item?.path ?? ""}`;
const fileName = (path: string) => path.split("/").pop() || "Document";

/** How long the layer stays mounted for its exit: a fade and a fall, or the fade alone. */
const exitMs = () => reducedMotion() ? 120 : 150;

/** The folder that holds a file, from the folder of the pane it is read through; "" at its top. */
function folderOf(path: string, cwd: string | undefined): string {
  const { dir } = displayPath(path, cwd, Infinity);
  return dir.length > 1 ? dir.slice(0, -1) : dir;
}

/**
 * The line under a file's name: the folder that holds it, giving up whole folders from the front to
 * fit `max` characters, and whose folder it is when another pane reads it. The name is the heading.
 */
function whereLine(folder: string, from: string, max: number): string {
  return [folder && shortCwd(folder, max), from && `from ${from}`].filter(Boolean).join(" · ");
}

export default function FilePreview({ paneId, session, items, start = 0, path, panes = [], onClose }: {
  paneId: string;
  session?: string;
  /** Live panes, so a file beyond this pane's folder can be opened from the pane that holds it. */
  panes?: readonly PaneRoot[];
  /** A gallery to step through; `path` is the one-file shorthand. */
  items?: readonly PreviewItem[];
  start?: number;
  path?: string;
  onClose: () => void;
}) {
  useHoldReload("document-preview", true);
  const list: readonly PreviewItem[] = items ?? (path ? [{ kind: "file", path }] : []);
  const [index, setIndex] = useState(start);
  const at = Math.min(index, list.length - 1);
  const item = list[at];
  const [data, setData] = useState<DocumentData | null>(null);
  const [error, setError] = useState<FileFailure | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const whereRef = useRef<HTMLParagraphElement>(null);
  const exit = useRef(0);
  const probe = useRef<AbortController | null>(null);
  const narrow = useMediaQuery("(max-width: 639px)");
  const openFile = useContext(FilePreviewContext);
  const itemKey = keyOf(item);
  // A name the pane's folder lacks can live in a folder the conversation names (a summary recapping
  // another repo, a scratchpad): where the bridge found it, for this item only.
  const [moved, setMoved] = useState<{ itemKey: string; path: string } | null>(null);
  const shown = useRef(itemKey);
  shown.current = itemKey;
  const filePath = item?.kind !== "file" ? "" : moved?.itemKey === itemKey ? moved.path : item.path;
  const openRelated = openFile ? (target: string) => openFile(target.startsWith("/") ? target : filePath.slice(0, filePath.lastIndexOf("/") + 1) + target) : null;
  const name = item?.kind === "journal" ? item.label : fileName(filePath);
  const html = isHtml(item);
  const image = isImage(item);
  // The pane this item is read through: the open one, unless the operator chose the pane whose
  // folder holds it. The choice belongs to one item, so stepping the gallery drops it.
  const [from, setFrom] = useState<{ itemKey: string; paneId: string } | null>(null);
  const source = from?.itemKey === itemKey ? from.paneId : paneId;
  const owner = error?.outside ? paneOwningPath(panes, filePath, source) : undefined;
  const sourceLabel = source === paneId ? "" : panes.find((pane) => pane.paneId === source)?.label ?? source;
  const imageUrl = (entry: PreviewItem, target = entry.kind === "file" ? entry.path : "", through = paneId) =>
    entry.kind === "journal" ? journalImageUrl(paneId, entry.entry, entry.index, session) : paneFileUrl(through, target, session);
  const imageSrc = image && item ? imageUrl(item, filePath, source) : "";
  // Pictures whose <img> failed, the shown one or one waiting beside it. Shown again, the same
  // element with the same src fires no second error, so the failure is kept until it loads or Retry.
  const failedImages = useRef(new Set<string>());
  const fail = (cause: unknown) => {
    const failure: FileFailure = cause instanceof PaneFileError
      ? { message: cause.message, outside: cause.outside, status: cause.status }
      : { message: cause instanceof Error ? cause.message : "Could not open this file.", outside: false };
    // Inside the folder by name and not there: ask the bridge where the name leads before saying so.
    if (failure.status !== 404 || failure.outside || !filePath) return setError(failure);
    const key = itemKey;
    fetchArtifactMetadata(source, [filePath], session).then(([found]) => {
      if (shown.current !== key) return;
      if (found?.state === "missing") setError({ message: "File not found.", outside: false, status: 404 });
      else if (found?.resolved && found.resolved !== filePath) setMoved({ itemKey: key, path: found.resolved });
      else setError(failure);
    }, () => { if (shown.current === key) setError(failure); });
  };

  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    setError(null); setData(null);
    if (imageSrc && failedImages.current.has(imageSrc)) { imageFailed(); return; }
    // HTML loads in its frame and a picture in its <img>, each by its own request.
    if (!item || html || image) return;
    if (/\.(mp4|m4v|mov|webm)$/i.test(filePath)) { setData({ kind: "video", url: paneFileUrl(source, filePath, session) }); return; }
    void (async () => {
      const response = await fetchPaneFile(source, filePath, session, controller.signal);
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
        if (!controller.signal.aborted) setData({ kind: "text", text, markdown: /\.(md|markdown)$/i.test(filePath), url });
      } else throw new Error("This file type cannot be previewed.");
    })().catch((cause: unknown) => { if (!controller.signal.aborted) fail(cause); });
    return () => { controller.abort(); probe.current?.abort(); if (url) URL.revokeObjectURL(url); };
    // itemKey and filePath name the item; the object itself is rebuilt on every render of a one-file preview.
  }, [paneId, source, session, itemKey, filePath, html, image, imageSrc, attempt]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus({ preventScroll: true });
    return () => {
      window.clearTimeout(exit.current);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  /** Leave with the layer still mounted for its exit, then unmount. */
  const close = () => {
    if (exit.current) return;
    const ms = exitMs();
    if (!ms) return onClose();
    setLeaving(true);
    exit.current = window.setTimeout(onClose, ms);
  };

  /** An <img> that will not load says nothing of why: the file read answers that. */
  const imageFailed = () => {
    if (item?.kind !== "file") return setError({ message: "Could not load this image.", outside: false });
    const key = itemKey;
    probe.current?.abort();
    probe.current = new AbortController();
    fetchPaneFile(source, filePath, session, probe.current.signal).then((response) => {
      void response.body?.cancel();
      if (shown.current === key) setError({ message: "Could not load this image.", outside: false });
    }, (cause: unknown) => { if (shown.current === key && !probe.current?.signal.aborted) fail(cause); });
  };

  const copyPath = async () => {
    try { await navigator.clipboard.writeText(filePath); setCopied(true); } catch { setCopied(false); }
  };

  const imageError = (src: string) => {
    failedImages.current.add(src);
    if (src === imageSrc) imageFailed();
  };
  const retry = () => {
    failedImages.current.delete(imageSrc);
    setAttempt((value) => value + 1);
  };

  const step = (by: number) => setIndex((current) => Math.min(list.length - 1, Math.max(0, current + by)));
  const downloadUrl = error ? undefined : imageSrc || (data?.url ?? (html ? paneFileUrl(source, filePath, session) : undefined));
  const failure = error && <FileUnavailable failure={error} path={filePath} paneId={source} session={session} owner={owner} onRetry={retry}
    onOpenFrom={(paneId) => setFrom({ itemKey, paneId })} />;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      if (!menu) return close();
      setMenu(false);
      more.current?.focus({ preventScroll: true });
      return;
    }
    if (list.length > 1 && (event.key === "ArrowLeft" || event.key === "ArrowRight")) { event.preventDefault(); step(event.key === "ArrowLeft" ? -1 : 1); }
    if (event.key === "Tab") {
      // Done and Close trade places by width; only the one on screen takes focus.
      const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]') ?? [])
        .filter((control) => control.checkVisibility?.() ?? control.getClientRects().length > 0);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus({ preventScroll: true }); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first?.focus({ preventScroll: true }); }
    }
  };

  const gallery: (ViewerImage | null)[] = image ? list.map((entry, i) => !isImage(entry) ? null : {
    key: keyOf(entry),
    src: i === at ? imageSrc : imageUrl(entry),
    label: entry.kind === "journal" ? entry.label : fileName(entry.path),
  }) : [];
  const cwd = panes.find((pane) => pane.paneId === source)?.cwd;
  const title = useFitted(titleRef, heading, name, (max) => shortName(name, max), narrow ? 21 : 80);
  const folder = folderOf(filePath, cwd);
  const where = useFitted(whereRef, heading, whereLine(folder, sourceLabel, Infinity), (max) => whereLine(folder, sourceLabel, max), narrow ? 28 : 96);
  const Icon = html ? Globe : FileText;

  return createPortal(<div className={cn("file-preview-backdrop", image && "file-preview-backdrop--image")} data-leaving={leaving ? "" : undefined}
    onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div ref={panel} role="dialog" aria-modal="true" aria-label={name} tabIndex={-1} onKeyDown={onKeyDown}
      className={cn("file-preview-panel", html && "file-preview-panel--full", image && "file-preview-panel--image")}>
      {image ? <ImageViewer images={gallery} index={at} name={name} downloadUrl={downloadUrl} error={failure || undefined}
        onStep={step} onClose={close} onDismissed={onClose} onImageError={imageError} onImageLoad={(src) => failedImages.current.delete(src)} />
      : <>
        <header className="file-preview-header">
          {/* A full-screen modal leaves on a Done text button, not a back chevron. */}
          <button type="button" className="preview-done" onClick={close}>Done</button>
          <Icon className="file-preview-kind size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div ref={heading} className="file-preview-heading">
            <h2 ref={titleRef} className="file-preview-title" aria-label={title === name ? undefined : name} title={title === name ? undefined : name}>{title}</h2>
            {where && <p ref={whereRef} className="file-preview-subtitle" title={filePath || undefined}>{where}</p>}
          </div>
          <div className="file-preview-actions">
            {downloadUrl && <a href={downloadUrl} download={name} aria-label="Download file" className="file-preview-action"><Download className="size-5" aria-hidden="true" /></a>}
            <button ref={more} type="button" aria-label="More actions" aria-haspopup="dialog" aria-expanded={menu} className="file-preview-action"
              onClick={() => { setCopied(false); setMenu(!menu); }}><MoreHorizontal className="size-5" aria-hidden="true" /></button>
            <button type="button" aria-label="Close document" onClick={close} className="file-preview-action preview-close"><X className="size-5" aria-hidden="true" /></button>
          </div>
          <WorkbenchPopover open={menu} onDismiss={() => setMenu(false)} anchorRef={more} label="More actions" className="w-56 [&>div:first-child]:hidden [&>div:last-child]:p-1.5">
            <ActionGroups onRun={(action) => action()} groups={[{ label: "More actions", actions: [
              { id: "reload", label: "Reload", icon: RefreshCw, run: () => { setMenu(false); setAttempt((value) => value + 1); } },
              { id: "copy", label: copied ? "Copied path" : "Copy path", icon: copied ? Check : Copy, run: () => void copyPath() },
            ] }]} />
          </WorkbenchPopover>
        </header>
        {error ? <div className="file-preview-content">{failure}</div>
          : html ? <HtmlViewer paneId={source} session={session} path={filePath} name={name} reload={attempt} onError={fail} />
          : <div className="file-preview-content">
            <DocumentContent data={data} name={name} openRelated={openRelated} onError={(message) => setError({ message, outside: false })} />
          </div>}
      </>}
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
      // A picture under a name without an image extension: the bridge's type says what it is.
      return <img src={data.url} alt={name} decoding="async" className="mx-auto h-auto max-w-full" onError={() => onError("Could not load this image.")} />;
    case "text":
      if (!data.markdown) return <pre className="overflow-x-auto p-5 font-mono text-sm whitespace-pre">{data.text}</pre>;
      return <FilePreviewContext.Provider value={openRelated}>
        <MarkdownText text={data.text} className="mx-auto max-w-3xl p-5 sm:p-8" />
      </FilePreviewContext.Provider>;
  }
}

function Loading() { return <div role="status" className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin motion-reduce:animate-none" />Loading document…</div>; }
