import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { grantFileOpen, type FileOpenGrant } from "@/lib/api";

/** A link is good for two minutes on the bridge; ask again a little before that. */
export const GRANT_REFRESH_MS = 100_000;

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

type GrantState = { state: "loading" } | { state: "ready"; grant: FileOpenGrant } | { state: "refused"; error: string };

/**
 * The confirmed way out for a file the preview refuses (ADR 0063). The link is requested as soon as
 * the dialog opens, so the confirm button is a plain link the tap follows directly: an installed iOS
 * PWA blocks a new tab opened after an await. The link is single-use and short-lived, so a used or
 * stale one is replaced by asking again.
 */
export function FileOpenButton({ paneId, session, path }: { paneId: string; session?: string; path: string }) {
  const [open, setOpen] = useState(false);
  const [grant, setGrant] = useState<GrantState>({ state: "loading" });
  const request = useRef(0);

  const ask = useCallback(() => {
    const id = ++request.current;
    setGrant({ state: "loading" });
    grantFileOpen(paneId, path, session).then(
      (answer) => { if (id === request.current) setGrant("error" in answer ? { state: "refused", error: answer.error } : { state: "ready", grant: answer }); },
      (cause: unknown) => { if (id === request.current) setGrant({ state: "refused", error: cause instanceof Error ? cause.message : "Could not prepare the file." }); },
    );
  }, [paneId, session, path]);

  useEffect(() => {
    if (!open) { request.current++; return; }
    ask();
  }, [open, ask]);

  useEffect(() => {
    if (!open || grant.state !== "ready") return;
    const timer = setTimeout(ask, GRANT_REFRESH_MS);
    return () => clearTimeout(timer);
  }, [open, grant, ask]);

  const close = () => setOpen(false);
  const ready = grant.state === "ready" ? grant.grant : null;

  return <>
    <button type="button" className="inline-flex min-h-11 items-center gap-2 rounded-md border px-4" onClick={() => setOpen(true)}>
      <ExternalLink className="size-4" aria-hidden="true" />Open
    </button>
    {/* Keys belong to this dialog: Escape must not also close the preview behind it, nor Tab hit its focus trap. */}
    <div onKeyDown={(event) => event.stopPropagation()}>
      <Dialog open={open} onClose={close} title="Open this file outside Nenu's preview?"
        description="It opens in a new browser tab. Web pages and SVG run sandboxed there, with no network and no access to Nenu. Other files may download.">
        <code className="mt-3 block select-all rounded bg-muted px-2 py-1.5 font-mono text-xs break-all">{path}</code>
        <p className="mt-2 text-sm text-muted-foreground" aria-live="polite">
          {grant.state === "loading" ? "Checking the file…" : ready ? formatFileSize(ready.size) : null}
        </p>
        {grant.state === "refused" && <p role="alert" className="mt-2 text-sm text-destructive">{grant.error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="lg" onClick={close}>Cancel</Button>
          {ready
            ? <a href={ready.url} target="_blank" rel="noopener noreferrer" className={buttonVariants({ size: "lg" })}
                // The link is spent by this tap. Close after the browser has followed it: an anchor
                // removed during its own click no longer navigates.
                onClick={() => { request.current++; setTimeout(close, 0); }}>
                <ExternalLink className="size-4" aria-hidden="true" />Open
              </a>
            : grant.state === "refused"
              ? <Button type="button" size="lg" onClick={ask}>Try again</Button>
              : <Button type="button" size="lg" disabled><Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />Open</Button>}
        </div>
      </Dialog>
    </div>
  </>;
}
