import { listTemplates, OrgValidationError, resolveNode, startFromTemplate } from "../org-cli.ts";
import { deviceAuth } from "./access.ts";
import type { Route } from "./context.ts";
import { json } from "./http.ts";

export const orgRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/org/templates",
    access: "read",
    session: false,
    async handle({ orgRun }, { req, url }) {
      try {
        const templates = await listTemplates(orgRun, url.searchParams.get("project") ?? "");
        return json({ ok: true, templates }, req.headers.get("accept-encoding"));
      } catch (error) {
        return json({
          ok: false,
          error: error instanceof Error ? error.message : "Could not list templates.",
        }, req.headers.get("accept-encoding"), error instanceof OrgValidationError ? 400 : 502);
      }
    },
  },
  {
    method: "POST",
    path: "/api/org/node/start",
    access: "write",
    session: true,
    async handle({ cfg, audit, orgRun }, { req, rt }) {
      const acceptEncoding = req.headers.get("accept-encoding");
      const body: unknown = await req.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json({ ok: false, error: "Request body must be a JSON object." }, acceptEncoding, 400);
      }
      const project = "project" in body ? body.project : undefined;
      const template = "template" in body ? body.template : undefined;
      const title = "title" in body ? body.title : undefined;
      const parent = "parent" in body ? body.parent : undefined;
      const task = "task" in body ? body.task : undefined;
      if (
        typeof project !== "string" || typeof template !== "string" || typeof title !== "string" ||
        typeof parent !== "string" || typeof task !== "string"
      ) {
        return json({ ok: false, error: "Project, template, title, parent, and task must be text." }, acceptEncoding, 400);
      }
      try {
        const node = await startFromTemplate(orgRun, rt.socketPath, { project, template, title, parent, task });
        audit.record({
          action: "org.node.start",
          session: rt.name,
          device: deviceAuth(req, cfg).device,
          detail: { project, template, title, parent },
        });
        return json({ ok: true, node }, acceptEncoding);
      } catch (error) {
        return json({
          ok: false,
          error: error instanceof Error ? error.message : "Could not start node.",
        }, acceptEncoding, error instanceof OrgValidationError ? 400 : 502);
      }
    },
  },
  {
    method: "POST",
    path: "/api/org/node/resolve",
    access: "write",
    session: true,
    async handle({ cfg, audit, orgRun }, { req, rt }) {
      const acceptEncoding = req.headers.get("accept-encoding");
      const body: unknown = await req.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json({ ok: false, error: "Request body must be a JSON object." }, acceptEncoding, 400);
      }
      const project = "project" in body ? body.project : undefined;
      const id = "id" in body ? body.id : undefined;
      if (typeof project !== "string" || typeof id !== "string") {
        return json({ ok: false, error: "Project and node ID must be text." }, acceptEncoding, 400);
      }
      try {
        await resolveNode(orgRun, rt.socketPath, { project, id });
        audit.record({
          action: "org.node.resolve",
          session: rt.name,
          device: deviceAuth(req, cfg).device,
          detail: { project, id },
        });
        return json({ ok: true }, acceptEncoding);
      } catch (error) {
        return json({
          ok: false,
          error: error instanceof Error ? error.message : "Could not close node.",
        }, acceptEncoding, error instanceof OrgValidationError ? 400 : 502);
      }
    },
  },
];
