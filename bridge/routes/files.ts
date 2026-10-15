import { basename, isAbsolute, join, resolve } from "node:path";
import { artifactMetadata, mentionedFolders } from "../artifact-metadata.ts";
import type { AuditLog } from "../audit.ts";
import { chatUploadPreviewResponse, isChatUploadPath } from "../chat-upload-preview.ts";
import type { Config } from "../config.ts";
import { checkOpenable, grantedFileResponse } from "../file-open.ts";
import { renderedHtmlResponse } from "../html-preview.ts";
import { adapterFor } from "../journal/registry.ts";
import { deliveredFilePaths } from "../journal/delivered.ts";
import { paneFileResponse } from "../pane-files.ts";
import { projectFiles } from "../project-files.ts";
import type { UploadResponse } from "../types.ts";
import { MAX_UPLOAD_BYTES, saveUpload } from "../uploads.ts";
import type { TranscriptEntry } from "../journal/types.ts";
import { deviceAuth } from "./access.ts";
import type { PaneAction, PaneRouteRequest, Route, Services } from "./context.ts";
import { json, jsonError, secure, text } from "./http.ts";

// Upload limits. Herdr's socket only carries text/keys, so a file can't be pasted into the
// terminal — instead it is saved to a host file and the client references its path in the message
// (the agent opens it by path). See saveUpload().
// Multipart wraps the file in a boundary + part headers, so a legitimately-sized file arrives a
// little over MAX_UPLOAD_BYTES on the wire. Allow a small slack for the Content-Length pre-check.
const MAX_UPLOAD_OVERHEAD = 64 * 1024; // 64 KB

const folderCache = new WeakMap<readonly TranscriptEntry[], readonly string[]>();

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
  // Each is read once per request, however many names it is asked about.
  let delivered: Promise<readonly string[]> | undefined;
  let folders: Promise<readonly string[]> | undefined;
  return {
    cwd: pane?.cwd,
    journalEntries,
    delivered: () => delivered ??= journalEntries().then((entries) => deliveredFilePaths(entries)),
    folders: () => folders ??= journalEntries().then((entries) => {
      let named = folderCache.get(entries);
      if (!named) {
        named = mentionedFolders(entries);
        folderCache.set(entries, named);
      }
      return named;
    }),
  };
}

export const filePaneActions: Record<string, PaneAction> = {
  file: {
    level: "read",
    marksSeen: false,
    async handle(services, request) {
      const { req, url } = request;
      const { cwd, journalEntries, delivered, folders } = await paneFileScope(services, request);
      const requestedPath = url.searchParams.get("path");
      const ifNoneMatch = req.headers.get("if-none-match");
      if (isChatUploadPath(services.cfg.stateDir, requestedPath))
        return secure(await chatUploadPreviewResponse(services.cfg.stateDir, requestedPath, await journalEntries(), ifNoneMatch));
      return secure(await paneFileResponse(cwd, requestedPath, { range: req.headers.get("range"), ifNoneMatch, delivered, folders, stateDir: services.cfg.stateDir }));
    },
  },
  "html-preview": {
    level: "read",
    marksSeen: false,
    async handle(services, request) {
      const { cwd, delivered, folders } = await paneFileScope(services, request);
      return secure(await renderedHtmlResponse(cwd, request.url.searchParams.get("path"),
        { delivered, folders, inlineAssets: services.cfg.htmlInlineAssets, host: request.req.headers.get("host") ?? undefined, stateDir: services.cfg.stateDir }));
    },
  },
  files: {
    level: "read",
    marksSeen: false,
    async handle(services, request) {
      const { cfg } = services;
      const { req, url, rt, paneId } = request;
      if (url.searchParams.has("inspect")) {
        const { cwd, delivered, folders } = await paneFileScope(services, request);
        // Outside the pane's folder, only a device that could mint an Open link learns whether a file
        // is there: the same answer the grant would give it (ADR 0063).
        const openable = deviceAuth(req, cfg).authorized
          ? async (path: string) => { const file = await checkOpenable(path, cfg.stateDir); return "status" in file ? null : file.path; }
          : undefined;
        try { return json(await artifactMetadata(cwd, url.searchParams.getAll("inspect"), { delivered, folders, openable }), null); }
        catch { return jsonError("At most 20 artifact paths per request.", 400, null); }
      }
      const current = rt.engine.current();
      const pane = [...current.agents, ...current.shellPanes].find((entry) => entry.paneId === paneId);
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

// Save an attached file to a host file and return its absolute path. The client then references
// that path in a message; Claude Code / Codex open files by path (the terminal can't take a pasted
// file over the socket). Any kind, up to MAX_UPLOAD_BYTES; the filename is server-generated and the
// file is never served back (ADR 0074).
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
  // reads the whole body into memory first, so a 100 MB file would be materialised just to fail
  // the size check. Multipart adds a boundary + part headers, so allow a small slack.
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + MAX_UPLOAD_OVERHEAD) {
    return secure(
      new Response(
        JSON.stringify({ ok: false, error: "File too large (max 25 MB)." } satisfies UploadResponse),
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
  try {
    const result = await saveUpload(join(cfg.stateDir, "uploads"), paneId, file);
    if (result.ok) {
      audit.record({
        action: "upload",
        paneId,
        session,
        device,
        detail: { filename: file.name, size: file.size, saved: basename(result.path) },
      });
    }
    return json(result, ae);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message } satisfies UploadResponse, ae);
  }
}

// ── Open a refused file outside the preview (ADR 0063) ──────────────
export const fileOpenRoutes: Route[] = [
  {
    // Write-level: only a device that can drive a terminal may mint a link, and only from Nenu's
    // own page (a write needs Origin). A relative path resolves against the named pane's folder.
    method: "POST",
    path: "/api/files/grant",
    access: "write",
    session: true,
    async handle({ cfg, audit, fileGrants }, { req, rt }) {
      const body = await req.json().catch(() => null) as { paneId?: unknown; path?: unknown } | null;
      let path = body?.path;
      if (typeof path === "string" && !isAbsolute(path) && typeof body?.paneId === "string") {
        const current = rt.engine.current();
        const cwd = [...current.agents, ...current.shellPanes].find((pane) => pane.paneId === body.paneId)?.cwd;
        if (cwd && isAbsolute(cwd)) path = resolve(cwd, path);
      }
      const file = await checkOpenable(path, cfg.stateDir);
      if ("status" in file) return jsonError(file.message, file.status, null);
      const device = deviceAuth(req, cfg).device;
      const token = fileGrants.issue(file.path, device);
      audit.record({ action: "file.grant", session: rt.name, device, detail: { path: file.path, size: file.size } });
      return json({ url: `/api/files/open?t=${token}`, name: file.name, size: file.size, type: file.type }, null);
    },
  },
  {
    // Read-level: a link opened in a new tab is a top-level navigation and carries no Origin. The
    // token is the authority: single-use, two minutes, bound to the granting device and the file.
    method: "GET",
    path: "/api/files/open",
    access: "read",
    session: false,
    async handle({ cfg, audit, fileGrants }, { req, url }) {
      const device = deviceAuth(req, cfg).device;
      const path = fileGrants.consume(url.searchParams.get("t"), device);
      const response = await grantedFileResponse(path, cfg.stateDir);
      if (path) audit.record({ action: "file.open", device, detail: { path, status: response.status, size: Number(response.headers.get("content-length") ?? 0) } });
      return secure(response);
    },
  },
];
