import { createProject, mergeThread, openProject, OrgValidationError, resolveNode, setThreadFlags, startNode, startOptions } from "../org-cli.ts";
import { deviceAuth } from "./access.ts";
import type { Route, Services, SessionRouteRequest } from "./context.ts";
import { json } from "./http.ts";

export const orgRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/org/start-options",
    access: "read",
    session: false,
    async handle({ orgRun }, { req, url }) {
      try {
        const options = await startOptions(orgRun, url.searchParams.get("project") ?? "");
        return json({ ok: true, ...options }, req.headers.get("accept-encoding"));
      } catch (error) {
        return json({
          ok: false,
          error: error instanceof Error ? error.message : "Could not read the start options.",
        }, req.headers.get("accept-encoding"), error instanceof OrgValidationError ? 400 : 502);
      }
    },
  },
  orgWrite("/api/org/node/start", "org.node.start", "Could not start node.", async ({ orgRun }, body, rt) => {
    const node = await startNode(orgRun, rt.socketPath, {
      project: body.project, title: body.title, parent: body.parent, task: body.task, role: body.role, profile: body.profile, template: body.template,
    });
    return { response: { node }, detail: { project: body.project, id: node.id, role: body.role, parent: body.parent, profile: body.profile, template: body.template, title: body.title } };
  }),
  orgWrite("/api/org/node/resolve", "org.node.resolve", "Could not close node.", async ({ orgRun }, body, rt) => {
    await resolveNode(orgRun, rt.socketPath, { project: body.project, id: body.id });
    return { response: {}, detail: { project: body.project, id: body.id } };
  }),
  // The person waits on the redirect to the coordinator's chat, so the projects are re-read first.
  orgWrite("/api/org/project/open", "org.project.open", "Could not start the coordinator.", async ({ orgRun }, body, rt) => {
    await openProject(orgRun, rt.socketPath, { project: body.project });
    return { response: {}, detail: { project: body.project } };
  }, { settle: true }),
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
 * projects at once so the `org` event follows the change instead of the next stat. With `settle`
 * the reply waits for that re-read, so the client's next snapshot already shows the change.
 */
function orgWrite(
  path: string,
  action: string,
  failure: string,
  write: (ctx: Services, body: Record<string, unknown>, rt: SessionRouteRequest["rt"]) => Promise<{ response: Record<string, unknown>; detail: Record<string, unknown> }>,
  { settle = false } = {},
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
        const { response, detail } = await write(ctx, body as Record<string, unknown>, rt);
        ctx.audit.record({ action, session: rt.name, device: deviceAuth(req, ctx.cfg).device, detail });
        if (settle) await ctx.projects.invalidate();
        else void ctx.projects.invalidate();
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
