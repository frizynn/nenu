import { useEffect, useRef, useState, type RefObject } from "react";
import { Code2, Expand, Eye, Loader2, Monitor, ShieldCheck, Smartphone } from "lucide-react";
import { fetchPaneFile, paneFileError, paneFileUrl, type PaneFileError } from "@/lib/api";

// The in-app HTML viewer. The document only ever runs in the opaque-origin `allow-scripts` iframe
// served by /html-preview with its own no-network CSP (ADR 0021, 0059): never srcdoc, never this
// origin. The frame mounts at once, so opening costs one request; the source is fetched only when
// the Code view is chosen.

type View = "render" | "code";
type Width = "desktop" | "phone";

/** How often an open viewer asks whether the file changed on disk. */
export const HTML_VERSION_POLL_MS = 3000;

export function htmlRenderUrl(paneId: string, path: string, session?: string): string {
  return paneFileUrl(paneId, path, session).replace("/file?", "/html-preview?");
}

/**
 * Bumps when the file's ETag changes while the viewer is open. The first check runs once the frame
 * has loaded, so it neither delays the page nor misses an edit made right after opening. A 304
 * costs a header round trip; a changed file's body is dropped as soon as the headers arrive. The
 * frame shows a refusal as a bare text page, so a refused check (4xx) is reported to `onRefused`.
 */
function useFileVersion(url: string, enabled: boolean, onRefused: RefObject<(error: PaneFileError) => void>): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let etag: string | null = null;
    let stopped = false;
    let inflight: AbortController | null = null;
    const check = async () => {
      if (stopped || document.visibilityState === "hidden") return;
      inflight = new AbortController();
      try {
        const response = await fetch(url, { cache: "no-store", redirect: "manual", signal: inflight.signal, headers: etag ? { "if-none-match": etag } : {} });
        const next = response.status === 200 ? response.headers.get("etag") : null;
        if (response.status >= 400 && response.status < 500 && !stopped) {
          const error = await paneFileError(response);
          if (!stopped) onRefused.current(error);
        }
        inflight.abort();
        if (next && etag && next !== etag && !stopped) setVersion((n) => n + 1);
        if (next) etag = next;
      } catch {
        // A failed check leaves the frame as it is; the next tick tries again.
      }
    };
    void check();
    const timer = setInterval(() => void check(), HTML_VERSION_POLL_MS);
    return () => { stopped = true; clearInterval(timer); inflight?.abort(); };
  }, [url, enabled]);
  return version;
}

export function HtmlViewer({ paneId, session, path, name, reload, onError }: {
  paneId: string;
  session?: string;
  path: string;
  name: string;
  reload: number;
  /** The file cannot be read through this pane; the caller replaces the viewer with the reason. */
  onError: (error: unknown) => void;
}) {
  const [view, setView] = useState<View>("render");
  const [width, setWidth] = useState<Width>("desktop");
  const [source, setSource] = useState<{ text: string } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const reportError = useRef(onError);
  reportError.current = onError;
  const version = useFileVersion(paneFileUrl(paneId, path, session), view === "render" && loaded, reportError);
  const tabs = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (view !== "code") return;
    const controller = new AbortController();
    setSource(null);
    void fetchPaneFile(paneId, path, session, controller.signal)
      .then((response) => response.text())
      .then((text) => { if (!controller.signal.aborted) setSource({ text }); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) reportError.current(cause); });
    return () => controller.abort();
  }, [paneId, session, path, view, reload]);

  const tab = (value: View, label: string, Icon: typeof Eye) => <button key={value} type="button" role="tab" aria-selected={view === value} tabIndex={view === value ? 0 : -1}
    className="file-preview-tab" onClick={() => setView(value)} onKeyDown={(event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const next = value === "render" ? "code" : "render";
      setView(next);
      tabs.current?.querySelector<HTMLElement>(`[data-view="${next}"]`)?.focus();
    }} data-view={value}><Icon className="size-4" aria-hidden="true" />{label}</button>;

  return <>
    <div className="file-preview-tabs html-viewer-bar">
      <div ref={tabs} role="tablist" aria-label="HTML preview mode" className="flex gap-1">
        {tab("render", "Render", Eye)}
        {tab("code", "Code", Code2)}
      </div>
      {view === "render" && <div role="group" aria-label="Preview width" className="html-viewer-widths">
        {([["desktop", "Desktop", Monitor], ["phone", "Phone", Smartphone]] as const).map(([value, label, Icon]) =>
          <button key={value} type="button" aria-pressed={width === value} className="file-preview-tab" onClick={() => setWidth(value)}>
            <Icon className="size-4" aria-hidden="true" /><span className="max-sm:sr-only">{label}</span>
          </button>)}
        {/* The page on its own tab: a pinch zooms the document instead of Nenu, and a canvas gets
            the whole screen. The response's own CSP sandbox keeps it opaque and offline there too. */}
        <a className="file-preview-tab" href={htmlRenderUrl(paneId, path, session)} target="_blank" rel="noopener noreferrer">
          <Expand className="size-4" aria-hidden="true" /><span className="max-sm:sr-only">Full screen</span>
        </a>
      </div>}
    </div>
    <p className="html-viewer-note"><ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />Sandboxed · scripts on, no network, no cookies</p>
    <div className={`file-preview-content html-viewer-stage${view === "render" && width === "phone" ? " html-viewer-stage--phone" : ""}`}>
      {view === "render"
        ? <iframe
            key={`${reload}:${version}`}
            title={`Rendered preview of ${name}`}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            src={htmlRenderUrl(paneId, path, session)}
            className="file-preview-html"
            onLoad={() => setLoaded(true)}
          />
        : source === null
          ? <div role="status" className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin motion-reduce:animate-none" />Loading source…</div>
          : <pre className="overflow-x-auto p-5 font-mono text-sm whitespace-pre">{source.text}</pre>}
    </div>
  </>;
}
