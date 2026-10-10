import { createProject, listTemplates, mergeThread, OrgValidationError, resolveNode, setThreadFlags, startFromTemplate } from "../org-cli.ts";
import { deviceAuth } from "./access.ts";
import type { Route, Services, SessionRouteRequest } from "./context.ts";
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
    async handle({ cfg, audit, orgRun, projects }, { req, rt }) {
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
        void projects.invalidate();
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
    async handle({ cfg, audit, orgRun, projects }, { req, rt }) {
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
        void projects.invalidate();
        return json({ ok: true }, acceptEncoding);
      } catch (error) {
        return json({
          ok: false,
          error: error instanceof Error ? error.message : "Could not close node.",
        }, acceptEncoding, error instanceof OrgValidationError ? 400 : 502);
      }
    },
  },
  orgWrite("/api/org/project/create", "org.project.create", "Could not create the project.", async ({ orgRun }, body) => {
    const project = await createProject(orgRun, { name: body.name, goal: body.goal, repo: body.repo });
    return { response: { project }, detail: { project: project.slug } };
  }),
  orgWrite("/api/org/thread/merge", "org.thread.merge", "Could not merge the pull request.", async ({ orgRun }, body) => {
    const merged = await mergeThread(orgRun, { project: body.project, id: body.id, method: body.method });
    return { response: { merged }, detail: { project: body.project, id: merged.id, pr: merged.pr } };
  }),
  orgWrite("/api/org/thread/set", "org.thread.set", "Could not change the thread's automation.", async ({ orgRun }, body) => {
    const flags = await setThreadFlags(orgRun, { project: body.project, id: body.id, autoFixCi: body.autoFixCi, autoMerge: body.autoMerge });
    return { response: { flags }, detail: { project: body.project, ...flags } };
  }),
];

/**
 * A POST that runs one Organizations write for the person's tap, audits it, and re-reads the
 * projects at once so the `org` event follows the change instead of the next stat.
 */
function orgWrite(
  path: string,
  action: string,
  failure: string,
  write: (ctx: Services, body: Record<string, unknown>) => Promise<{ response: Record<string, unknown>; detail: Record<string, unknown> }>,
): Route {
  return {
    method: "POST",
    path,
    access: "write",
    session: true,
    async handle(ctx: Services, { req, rt }: SessionRouteRequest) {
      const acceptEncoding = req.headers.get("accept-encoding");
      const body: unknown = await req.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json({ ok: false, error: "Request body must be a JSON object." }, acceptEncoding, 400);
      }
      try {
        const { response, detail } = await write(ctx, body as Record<string, unknown>);
        ctx.audit.record({ action, session: rt.name, device: deviceAuth(req, ctx.cfg).device, detail });
        void ctx.projects.invalidate();
        return json({ ok: true, ...response }, acceptEncoding);
      } catch (error) {
        return json({
          ok: false,
          error: error instanceof Error ? error.message : failure,
        }, acceptEncoding, error instanceof OrgValidationError ? 400 : 502);
      }
    },
  };
}
