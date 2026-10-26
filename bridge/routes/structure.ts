import { homedir } from "node:os";
import type { AuditLog } from "../audit.ts";
import type { HerdrClient } from "../herdr-client.ts";
import { listHomeDirs } from "../home-dirs.ts";
import { startCatalog } from "../models.ts";
import type { StateEngine } from "../state-engine.ts";
import type { ActionResponse, CreateResponse } from "../types.ts";
import { deviceAuth } from "./access.ts";
import type { PaneAction, Route } from "./context.ts";
import { json, jsonError, text } from "./http.ts";

// A tab supports rename, close, move and split (a new shell pane in it) — an action group like the pane route. The `/api/tab` POST
// below (create) is an exact match on `/api/tab`, so it never collides with this `/api/tab/<id>/<action>`.
const TAB_ACTION_ROUTE = /^\/api\/tab\/([^/]+)\/(rename|close|move|split)$/;

export const structureRoutes: Route[] = [
  // Folder names under home for the new-chat picker. Write-level: only a device that can start a
  // chat needs them, so a read-only viewer never learns the home tree.
  {
    method: "GET",
    path: "/api/dirs",
    access: "write",
    session: false,
    // The folder or file is on the machine the request names.
    machine: true,
    async handle(_ctx, { url }) {
      try {
        return json(await listHomeDirs(url.searchParams.get("path"), { hidden: url.searchParams.get("hidden") === "1" }), null);
      } catch {
        return jsonError("Directory unavailable.", 404, null);
      }
    },
  },
  // What a new chat may start on (agent-start.ts): the same list the start route checks a choice against.
  // Write-level like the folders: only a device that can start a chat reads it.
  {
    method: "GET",
    path: "/api/start/models",
    access: "write",
    session: false,
    machine: true,
    async handle({ cfg }) {
      return json(await startCatalog(cfg.journalRoots), null);
    },
  },
  // ── Structural creates: new tab / new space (each opens a fresh shell pane) ──
  {
    method: "POST",
    path: "/api/tab",
    access: "write",
    session: true,
    handle({ cfg, audit }, { req, rt }) {
      return createTab(rt.herdr, rt.engine, req, audit, deviceAuth(req, cfg).device, rt.name);
    },
  },
  {
    method: "POST",
    path: "/api/workspace",
    access: "write",
    session: true,
    handle({ cfg, audit }, { req, rt }) {
      return createWorkspace(rt.herdr, req, audit, deviceAuth(req, cfg).device, rt.name);
    },
  },
  // ── Tab actions: rename (set its label) / close (kill it + every pane in it) / move (reorder) ──
  {
    method: "POST",
    path: TAB_ACTION_ROUTE,
    access: "write",
    session: true,
    handle({ cfg, audit }, { req, rt, match }) {
      const tabId = decodeURIComponent(match![1]!);
      const action = match![2];
      const device = deviceAuth(req, cfg).device;
      if (action === "close") return closeTab(rt.herdr, rt.engine, tabId, req, audit, device, rt.name);
      if (action === "move") return moveTab(rt.herdr, rt.engine, tabId, req, audit, device, rt.name);
      if (action === "split") return splitTab(rt.herdr, rt.engine, tabId, req, audit, device, rt.name);
      return renameTab(rt.herdr, rt.engine, tabId, req, audit, device, rt.name);
    },
  },
];

export const structurePaneActions: Record<string, PaneAction> = {
  close: {
    level: "write",
    marksSeen: true,
    handle: ({ audit }, { req, rt, paneId, device }) => closePane(rt.herdr, rt.engine, paneId, req, audit, device, rt.name),
  },
  rename: {
    level: "write",
    marksSeen: true,
    handle: ({ audit }, { req, rt, paneId, device }) => renamePane(rt.herdr, rt.engine, paneId, req, audit, device, rt.name),
  },
};

// Herdr acknowledged the write even if the follow-up read fails. Do not turn a successful
// mutation into a retryable action error: retrying a close could target a reused pane id.
async function refreshStructuralState(engine: StateEngine): Promise<void> {
  try { await engine.refresh(); }
  catch (error) {
    console.warn("[state] structural action succeeded but refresh failed:", error instanceof Error ? error.message : "unknown error");
  }
}

// Close a pane ("kill the agent"). Structural op — strictly less powerful than the text/keys
// injection the bridge already allows, so it stays within the existing remote-shell threat model.
async function closePane(
  herdr: HerdrClient,
  engine: StateEngine,
  paneId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
  const ae = req.headers.get("accept-encoding");
  try {
    await herdr.closePane(paneId);
    audit.record({ action: "pane.close", paneId, session, device, detail: {} });
    await refreshStructuralState(engine);
    return json({ ok: true } satisfies ActionResponse, ae);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message } satisfies ActionResponse, ae);
  }
}

// Set or clear a pane's label. Structural metadata op — strictly less powerful than the text/keys
// injection the bridge already allows, so it stays within the existing remote-shell threat model.
// The body's `label` must be a string or null; a blank string clears (so a user can wipe a label by
// saving an empty field), which we send to Herdr as `label: null`.
async function renamePane(
  herdr: HerdrClient,
  engine: StateEngine,
  paneId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
  const ae = req.headers.get("accept-encoding");
  let body: { label?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return text("bad body", 400);
  }
  if (body.label !== null && typeof body.label !== "string") return text("bad label", 400);
  const trimmed = typeof body.label === "string" ? body.label.trim() : "";
  const label = trimmed.length > 0 ? trimmed : null;
  try {
    await herdr.renamePane(paneId, label);
    audit.record({ action: "pane.rename", paneId, session, device, detail: { label } });
    await refreshStructuralState(engine);
    return json({ ok: true } satisfies ActionResponse, ae);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message } satisfies ActionResponse, ae);
  }
}

/**
 * Validate an untrusted tab-rename body's `label`. A tab label is a NON-null, NON-empty string:
 * herdr's `tab.rename` rejects `null`, and an empty string is stored literally (a blank tab chip)
 * rather than clearing to the default number — both live-verified 2026-07-19. So, unlike a pane label
 * (where a blank field clears to `null`), Nenu has no "clear" for a tab and rejects a blank label.
 * Pure + exported so the rule is unit-testable without standing up Bun.serve.
 */
export function normalizeTabLabel(
  v: unknown,
): { ok: true; label: string } | { ok: false; error: string } {
  if (typeof v !== "string") return { ok: false, error: "bad label" };
  const label = v.trim();
  if (!label) return { ok: false, error: "label required" };
  return { ok: true, label };
}

// Set a tab's label. Structural metadata op — strictly less powerful than the text/keys injection the
// bridge already allows, so it stays within the existing remote-shell threat model. A tab has no
// "clear" (see normalizeTabLabel): a blank label is a 400, not a reset to the tab number.
async function renameTab(
  herdr: HerdrClient,
  engine: StateEngine,
  tabId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
  const ae = req.headers.get("accept-encoding");
  let body: { label?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return text("bad body", 400);
  }
  const parsed = normalizeTabLabel(body.label);
  if (!parsed.ok) return text(parsed.error, 400);
  try {
    await herdr.renameTab(tabId, parsed.label);
    audit.record({ action: "tab.rename", session, device, detail: { tabId, label: parsed.label } });
    await refreshStructuralState(engine);
    return json({ ok: true } satisfies ActionResponse, ae);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message } satisfies ActionResponse, ae);
  }
}

// Close a tab, killing every pane inside it (live-verified 2026-07-19: the tab's panes disappear with
// it — see HERDR_API.md). Structural op — no more powerful than closing those panes one-by-one, which
// the bridge already allows via pane.close — so it stays within the existing remote-shell threat
// model. No body: the tab id is in the path.
async function closeTab(
  herdr: HerdrClient,
  engine: StateEngine,
  tabId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
  const ae = req.headers.get("accept-encoding");
  try {
    await herdr.closeTab(tabId);
    audit.record({ action: "tab.close", session, device, detail: { tabId } });
    await refreshStructuralState(engine);
    return json({ ok: true } satisfies ActionResponse, ae);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message } satisfies ActionResponse, ae);
  }
}

/**
 * Where Herdr's `tab.move` should put `tabId` so that it lands just before the tab `before` (null: at
 * the end), given every tab in Herdr's array order. `insert_index` counts the workspace's tabs before
 * the moved one is taken out (HERDR_API.md "Move methods"), which makes it the anchor's own index.
 * Pure + exported so the rule is unit-testable without standing up Bun.serve.
 */
export function tabInsertIndex(
  tabs: ReadonlyArray<{ tab_id: string; workspace_id: string }>,
  tabId: string,
  before: string | null,
): { ok: true; index: number } | { ok: false; error: string } {
  const tab = tabs.find((t) => t.tab_id === tabId);
  if (!tab) return { ok: false, error: `tab ${tabId} not found` };
  const order = tabs.filter((t) => t.workspace_id === tab.workspace_id).map((t) => t.tab_id);
  if (before === null) return { ok: true, index: order.length };
  const index = before === tabId ? -1 : order.indexOf(before);
  if (index < 0) return { ok: false, error: "before must be another tab in the same workspace" };
  return { ok: true, index };
}

// Move a tab within its workspace: the body names the tab it should now sit before (`before`, null
// for the end), so a drop resolves against Herdr's order at the moment of the write rather than an
// index the browser computed from a snapshot that may be a poll old. Structural metadata op, like a
// rename — strictly less powerful than the text/keys injection the bridge already allows.
async function moveTab(
  herdr: HerdrClient,
  engine: StateEngine,
  tabId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
  const ae = req.headers.get("accept-encoding");
  let body: { before?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return text("bad body", 400);
  }
  const before = body.before;
  if (before !== null && typeof before !== "string") return text("bad before", 400);
  try {
    const target = tabInsertIndex(await herdr.listTabs(), tabId, before);
    if (!target.ok) return json({ ok: false, error: target.error } satisfies ActionResponse, ae);
    await herdr.moveTab(tabId, target.index);
    audit.record({ action: "tab.move", session, device, detail: { tabId, before, insertIndex: target.index } });
    await refreshStructuralState(engine);
    return json({ ok: true } satisfies ActionResponse, ae);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message } satisfies ActionResponse, ae);
  }
}

// Create a new tab in a workspace, opening a fresh shell pane (you then launch your own agent in
// it). Structural — no more privilege than typing into an existing pane (you can already spawn a
// shell that way). `cwd` omitted => inherits the workspace dir. session.* stays unexposed.
async function createTab(
  herdr: HerdrClient,
  engine: StateEngine,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
  let body: { workspaceId?: string; label?: string; cwd?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return text("bad body", 400);
  }
  const workspaceId = body.workspaceId?.trim();
  const ae = req.headers.get("accept-encoding");
  if (!workspaceId) return json({ ok: false, error: "workspaceId required" } satisfies CreateResponse, ae);
  try {
    const created = await herdr.createTab(workspaceId, { label: body.label, cwd: body.cwd });
    const label =
      engine.current().workspaces.find((w) => w.workspaceId === created.workspaceId)?.label ??
      created.workspaceId;
    audit.record({
      action: "tab.create",
      paneId: created.paneId,
      session,
      device,
      detail: { workspaceId, label: body.label, cwd: body.cwd },
    });
    return json({
      ok: true,
      pane: { ...created, workspaceLabel: label },
    } satisfies CreateResponse, ae);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message } satisfies CreateResponse, ae);
  }
}

// Open a fresh shell pane in an existing tab, beside its largest pane (tab-split.ts). `cwd` omitted =
// the pane it splits from's folder. Same structural-only threat model as createTab.
async function splitTab(
  herdr: HerdrClient,
  engine: StateEngine,
  tabId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return text("bad body", 400);
  }
  const ae = req.headers.get("accept-encoding");
  const asked = typeof body === "object" && body !== null && "cwd" in body ? body.cwd : undefined;
  const snapshot = engine.current();
  const inTab = [...snapshot.agents, ...snapshot.shellPanes].find((p) => p.tabId === tabId);
  if (!inTab) return json({ ok: false, error: "That tab is gone." } satisfies CreateResponse, ae);
  const cwd = typeof asked === "string" && asked.trim() ? asked.trim() : undefined;
  try {
    const created = await herdr.splitTab(inTab.paneId, { cwd });
    audit.record({ action: "pane.split", paneId: created.paneId, session, device, detail: { tabId, cwd } });
    return json({ ok: true, pane: { ...created, workspaceLabel: inTab.workspaceLabel } } satisfies CreateResponse, ae);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message } satisfies CreateResponse, ae);
  }
}

// Create a new workspace ("space") with a fresh shell pane. `cwd` defaults to the user's home dir
// when the client doesn't specify one (typing a path on a phone is painful) — it's a shell, so you
// can cd from there. Same structural-only threat model as createTab.
async function createWorkspace(
  herdr: HerdrClient,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
  let body: { cwd?: string; label?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return text("bad body", 400);
  }
  const cwd = body.cwd?.trim() || homedir();
  const ae = req.headers.get("accept-encoding");
  try {
    const created = await herdr.createWorkspace({ cwd, label: body.label });
    audit.record({
      action: "workspace.create",
      paneId: created.paneId,
      session,
      device,
      detail: { label: body.label, cwd },
    });
    return json({
      ok: true,
      pane: {
        paneId: created.paneId,
        workspaceId: created.workspaceId,
        workspaceLabel: created.workspaceLabel ?? created.workspaceId,
        tabId: created.tabId,
        cwd: created.cwd,
      },
    } satisfies CreateResponse, ae);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message } satisfies CreateResponse, ae);
  }
}
