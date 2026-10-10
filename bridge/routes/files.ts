import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { artifactMetadata } from "../artifact-metadata.ts";
import type { AuditLog } from "../audit.ts";
import { chatUploadPreviewResponse, isChatUploadPath } from "../chat-upload-preview.ts";
import type { Config } from "../config.ts";
import { renderedHtmlResponse } from "../html-preview.ts";
import { adapterFor } from "../journal/registry.ts";
import { deliveredFilePaths, paneFileResponse } from "../pane-files.ts";
import { projectFiles } from "../project-files.ts";
import type { UploadResponse } from "../types.ts";
import { imageExtFromBytes, SNIFF_BYTES } from "../uploads.ts";
import type { TranscriptEntry } from "../journal/types.ts";
import type { PaneAction, PaneRouteRequest, Services } from "./context.ts";
import { json, jsonError, secure, text } from "./http.ts";

// Image upload limits. Herdr's socket only carries text/keys, so we can't paste an image into the
// terminal — instead we save it to a host file and the client references its path in the message
// (the agent reads images by path). See uploadPane().
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
// Multipart wraps the file in a boundary + part headers, so a legitimately-sized image arrives a
// little over MAX_UPLOAD_BYTES on the wire. Allow a small slack for the Content-Length pre-check.
const MAX_UPLOAD_OVERHEAD = 64 * 1024; // 64 KB
// Image type is sniffed from magic bytes in uploadPane — never from the client-supplied MIME.

/**
 * The pane a file request reads from and its journal, resolved one way for both /file and
 * /html-preview so a file the agent delivered from outside the cwd opens in either.
 */
async function paneFileScope(
  { cfg, conversations, journals, transcripts }: Services,
  { rt, paneId }: PaneRouteRequest,
) {
  const current = rt.engine.current();
  const original = [...current.agents, ...current.shellPanes].find((entry) => entry.paneId === paneId);
  const pane = original ? await conversations.resolve(original, rt.herdr, rt.name) : undefined;
  // The store already bounds and contains source reads. Request its whole available parsed
  // window so an upload or delivery in an older turn can be verified without browser claims.
  let loaded: Promise<readonly TranscriptEntry[]> | undefined;
  const journalEntries = () => loaded ??= (async () => {
    const adapter = pane && journals ? adapterFor(journals, pane.agent) : undefined;
    const page = cfg.transcript && pane?.agentSession && adapter && transcripts
      ? await transcripts.page(adapter, pane.agentSession, { limit: Number.MAX_SAFE_INTEGER }).catch(() => null)
      : null;
    return page?.entries ?? [];
  })();
  return { cwd: pane?.cwd, journalEntries, delivered: async () => deliveredFilePaths(await journalEntries()) };
}

// Inlining sibling assets into HTML previews (ADR 0059) is on unless the operator opts out.
const inlineHtmlAssets = () => process.env.COLLIE_HTML_INLINE_ASSETS !== "0";

export const filePaneActions: Record<string, PaneAction> = {
  file: {
    level: "read",
    marksSeen: false,
    async handle(services, request) {
      const { req, url } = request;
      const { cwd, journalEntries, delivered } = await paneFileScope(services, request);
      const requestedPath = url.searchParams.get("path");
      const ifNoneMatch = req.headers.get("if-none-match");
      if (isChatUploadPath(services.cfg.stateDir, requestedPath))
        return secure(await chatUploadPreviewResponse(services.cfg.stateDir, requestedPath, await journalEntries(), ifNoneMatch));
      return secure(await paneFileResponse(cwd, requestedPath, { range: req.headers.get("range"), ifNoneMatch, delivered }));
    },
  },
  "html-preview": {
    level: "read",
    marksSeen: false,
    async handle(services, request) {
      const { cwd, delivered } = await paneFileScope(services, request);
      return secure(await renderedHtmlResponse(cwd, request.url.searchParams.get("path"),
        { delivered, inlineAssets: inlineHtmlAssets() }));
    },
  },
  files: {
    level: "read",
    marksSeen: false,
    async handle(_ctx, { url, rt, paneId }) {
      const current = rt.engine.current();
      const pane = [...current.agents, ...current.shellPanes].find((entry) => entry.paneId === paneId);
      if (url.searchParams.has("inspect")) {
        try { return json(await artifactMetadata(pane?.cwd, url.searchParams.getAll("inspect")), null); }
        catch { return jsonError("At most 20 artifact paths per request.", 400, null); }
      }
      try { return json(await projectFiles(pane?.cwd, url.searchParams.get("path") ?? "."), null); }
      catch { return jsonError("Directory unavailable in this workspace.", 404, null); }
    },
  },
  upload: {
    level: "write",
    marksSeen: true,
    handle: ({ cfg, audit }, { req, rt, paneId, device }) => uploadPane(cfg, paneId, req, audit, device, rt.name),
  },
};

// Save an uploaded image to a host file and return its absolute path. The client then references
// that path in a message; Claude Code / Codex read images by path (the terminal can't take a
// pasted image over the socket). Validated by MIME and size; the filename is server-generated.
async function uploadPane(
  cfg: Config,
  paneId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
  const ae = req.headers.get("accept-encoding");
  // Reject an oversize upload by its declared Content-Length BEFORE buffering — req.formData()
  // reads the whole body into memory first, so a 100 MB "image" would be materialised just to fail
  // the size check below. Multipart adds a boundary + part headers, so allow a small slack.
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + MAX_UPLOAD_OVERHEAD) {
    return secure(
      new Response(
        JSON.stringify({
          ok: false,
          error: "image too large (max 10 MB)",
        } satisfies UploadResponse),
        { status: 413, headers: { "content-type": "application/json; charset=utf-8" } },
      ),
    );
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return text("expected multipart form data", 400);
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return json({ ok: false, error: "no file" } satisfies UploadResponse, ae);
  }
  const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  const ext = imageExtFromBytes(head);
  if (!ext) {
    return json({ ok: false, error: "unsupported type" } satisfies UploadResponse, ae);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return json({ ok: false, error: "image too large (max 10 MB)" } satisfies UploadResponse, ae);
  }
  try {
    const dir = join(cfg.stateDir, "uploads");
    // 0700 — uploads (and the state dir they live under) may hold sensitive images; keep them
    // owner-only. recursive:true applies the mode to any intermediate dirs it creates too.
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const safePane = paneId.replace(/[^A-Za-z0-9_-]/g, "_");
    const filename = `${safePane}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
    const fullPath = join(dir, filename);
    await Bun.write(fullPath, file);
    audit.record({
      action: "upload",
      paneId,
      session,
      device,
      detail: { filename: file.name, size: file.size, saved: filename },
    });
    return json({ ok: true, path: fullPath } satisfies UploadResponse, ae);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message } satisfies UploadResponse, ae);
  }
}
