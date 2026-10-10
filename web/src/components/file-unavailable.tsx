import { useState } from "react";
import { Check, Copy } from "lucide-react";

import type { PaneRoot } from "@/lib/file-links";
import { FileOpenButton } from "./file-open-dialog";

export interface FileFailure { message: string; outside: boolean; status?: number }

/** Refusals a confirmed open can get past: outside the folder, too large, or a type the preview lacks. */
const openable = (failure: FileFailure) => failure.outside || failure.status === 413 || failure.status === 415;

/**
 * Why the viewer cannot show a file, and what the operator can do instead. A path beyond the pane's
 * folder is refused by design (CLAUDE.md, pane-files.ts), so it gets the path and the way around it
 * rather than a Retry that can never succeed.
 */
export function FileUnavailable({ failure, path, paneId, session, owner, onOpenFrom, onRetry }: {
  failure: FileFailure;
  path: string;
  /** The pane a relative path belongs to, for the Open link. */
  paneId: string;
  session?: string;
  owner?: PaneRoot;
  onOpenFrom: (paneId: string) => void;
  onRetry: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (!failure.outside) return <div role="alert" className="p-6 text-sm">
    <p>{failure.message}</p>
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" className="min-h-11 rounded-md border px-4" onClick={onRetry}>Retry</button>
      {openable(failure) && path && <FileOpenButton paneId={paneId} session={session} path={path} />}
    </div>
  </div>;
  const copy = async () => {
    try { await navigator.clipboard.writeText(path); setCopied(true); } catch { setCopied(false); }
  };
  return <div role="alert" className="mx-auto flex max-w-xl flex-col gap-3 p-6 text-sm">
    <p className="font-medium">This file is outside this agent's folder</p>
    <p className="text-muted-foreground">
      Nenu only previews files inside the folder this agent works in, or files the agent sent with SendUserFile.
      {owner ? " Another agent works in the folder that holds it." : " You can still open it outside the preview."}
    </p>
    <code className="select-all rounded bg-muted px-2 py-1.5 font-mono text-xs break-all">{path}</code>
    <div className="flex flex-wrap gap-2">
      {owner && <button type="button" className="min-h-11 rounded-md border bg-primary px-4 text-primary-foreground" onClick={() => onOpenFrom(owner.paneId)}>Open from {owner.label}</button>}
      <FileOpenButton paneId={paneId} session={session} path={path} />
      <button type="button" className="inline-flex min-h-11 items-center gap-2 rounded-md border px-4" onClick={() => void copy()}>
        {copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}{copied ? "Copied" : "Copy path"}
      </button>
    </div>
  </div>;
}
