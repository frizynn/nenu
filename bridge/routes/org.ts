import { libraryFileResponse, reportResponse } from "../org-library.ts";
import { answerAsk, coordinatorChoices, createProject, explainThread, listRoutines, mergeThread, moveNode, openProject, OrgValidationError, prAction, prCreate, replaceCoordinator, resolveNode, setThreadFlags, setRoutine, startNode, startOptions, toggleRoutine, validateNodeId, validateProjectSlug } from "../org-cli.ts";
import { nenuDirs } from "../uploads.ts";
import { deviceAuth } from "./access.ts";
import type { Route, Services, SessionRouteRequest } from "./context.ts";
import { json, secure } from "./http.ts";

export const orgRoutes: Route[] = [
  orgRead("/api/org/start-options", "Could not read the start options.", ({ orgRun }, project) => startOptions(orgRun, project)),
  // Read on demand (the Routines page, a chip being opened), never on a poll.
  orgRead("/api/org/routines", "Could not read the routines.", ({ orgRun }, project) => listRoutines(orgRun, project)),
  orgRead("/api/org/tasks", "Could not read the task list.", async ({ projects }, project) => ({ tasks: await projects.tasks(project) })),
  orgRead("/api/org/status", "Could not read the project's status.", async ({ projects }, project) => ({ status: await projects.status(project) })),
  orgRead("/api/org/context", "Could not read the project's context.", ({ projects }, project) => projects.context(project)),
  // Read by a node's page while it is on screen, from what the last overview read: no spawn.
  orgRead("/api/org/summary", "Could not read the summaries.", async ({ projects }, project) =>
    projects.summaries(project) ?? { threads: null, status: null, usage: null, coordinator: null }),
  // Your asks, every project's at once, from what the last refresh read: no spawn. Null when this Organizations cannot list them.
  {
    method: "GET",
    path: "/api/org/asks",
    access: "read",
    session: false,
    async handle({ projects }, { req }) {
      return json({ ok: true, ...(projects.asks() ?? { asks: null, decisions: [], answers: false }) }, req.headers.get("accept-encoding"));
    },
  },
  {
    // A picture, HTML page or PDF from the project's library (org-library.ts). Read-level, as a
    // pane's /file is: a new tab is a top-level navigation and carries no Origin.
    method: "GET",
    path: "/api/org/library",
    access: "read",
    session: false,
    async handle({ cfg, projects }, { req, url }) {
      return secure(await libraryFileResponse(projects.library(url.searchParams.get("project") ?? ""), url.searchParams.get("path"), {
        ifNoneMatch: req.headers.get("if-none-match"), inlineAssets: cfg.htmlInlineAssets, host: req.headers.get("host") ?? undefined, nenuDirs: nenuDirs(cfg.stateDir),
      }));
    },
  },
  {
    // A thread's report, named by its id, from the project's records folder (org-library.ts). Read
    // when a question's context opens, never on a poll.
    method: "GET",
    path: "/api/org/report",
    access: "read",
    session: false,
    async handle({ cfg, projects }, { url }) {
      return secure(await reportResponse(projects.report(url.searchParams.get("project") ?? "", url.searchParams.get("thread") ?? ""), { nenuDirs: nenuDirs(cfg.stateDir) }));
    },
  },
  // Read when the window that starts or replaces the coordinator opens, never on a poll.
  orgRead("/api/org/coordinator-options", "Could not read what the coordinator can run.", ({ orgRun }, project) => coordinatorChoices(orgRun, project)),
  orgWrite("/api/org/node/start", "org.node.start", "Could not start node.", async ({ orgRun }, body, rt) => {
    const started = await startNode(orgRun, rt.socketPath, {
      project: body.project, title: body.title, parent: body.parent, task: body.task, role: body.role, profile: body.profile, template: body.template,
    });
    // The audit records what ran, as validated; the task stays out of it.
    return { response: { node: { id: started.id } }, detail: started };
  }),
  orgWrite("/api/org/node/resolve", "org.node.resolve", "Could not close node.", async ({ orgRun, projects }, body, rt) => {
    // Organizations' CLI would close a coordinator under its running threads; its popup refuses, and so does Nenu.
    const refusal = projects.closeRefusal(String(body.project), String(body.id));
    if (refusal) throw new OrgValidationError(refusal);
    await resolveNode(orgRun, rt.socketPath, { project: body.project, id: body.id });
    return { response: {}, detail: { project: body.project, id: body.id } };
  }),
  // The answer is the person's words to their coordinator: it goes to Organizations, and stays out of the audit.
  orgWrite("/api/org/asks/answer", "org.asks.answer", "Could not answer.", async ({ orgRun }, body, rt) => {
    const answered = await answerAsk(orgRun, rt.socketPath, { project: body.project, coordinator: body.coordinator, line: body.line, text: body.text });
    return { response: { answered }, detail: { project: answered.project, coordinator: answered.coordinator, line: answered.line } };
  }),
  orgWrite("/api/org/node/move", "org.node.move", "Could not move node.", async ({ orgRun }, body, rt) => {
    const moved = await moveNode(orgRun, rt.socketPath, { project: body.project, id: body.id, parent: body.parent });
    return { response: { moved: { id: moved.id, parent: moved.parent } }, detail: moved };
  }),
  // The person waits on the redirect to the coordinator's chat, so the projects are re-read first.
  orgWrite("/api/org/project/open", "org.project.open", "Could not start the coordinator.", async ({ orgRun }, body, rt) => {
    const { message } = await openProject(orgRun, rt.socketPath, { project: body.project, ...launch(body) });
    return { response: { message }, detail: { project: body.project, ...launchDetail(body) } };
  }, { settle: true }),
  // The old coordinator's chat ends with its pane, so the reply waits for the re-read that shows the new one.
  orgWrite("/api/org/coordinator/replace", "org.coordinator.replace", "Could not replace the coordinator.", async ({ orgRun }, body, rt) => {
    const { message } = await replaceCoordinator(orgRun, rt.socketPath, { project: body.project, ...launch(body) });
    return { response: { message }, detail: { project: body.project, ...launchDetail(body) } };
  }, { settle: true }),
  orgWrite("/api/org/project/create", "org.project.create", "Could not create the project.", async ({ orgRun }, body) => {
    const project = await createProject(orgRun, { name: body.name, goal: body.goal, repo: body.repo });
    return { response: { project }, detail: { project: project.slug } };
  }),
  {
    // A coordinator's glyph and colour, kept by Nenu (ADR 0122): no Organizations write, so nothing is
    // re-read; the registry tells the browsers itself.
    method: "POST",
    path: "/api/org/node/mark",
    access: "write",
    session: true,
    async handle({ audit, cfg, projects }, { req, rt }: SessionRouteRequest) {
      const acceptEncoding = req.headers.get("accept-encoding");
      const body: unknown = await req.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) return json({ ok: false, error: "Request body must be a JSON object." }, acceptEncoding, 400);
      const { project, id, icon, tone } = body as Record<string, unknown>;
      try {
        const mark = await projects.setMark(validateProjectSlug(project), validateNodeId(id), { icon, tone });
        audit.record({ action: "org.node.mark", session: rt.name, device: deviceAuth(req, cfg).device, detail: { project, id, ...mark } });
        return json({ ok: true, mark: mark ?? null }, acceptEncoding);
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : "Could not change the mark." }, acceptEncoding, error instanceof OrgValidationError ? 400 : 500);
      }
    },
  },
  orgWrite("/api/org/thread/merge", "org.thread.merge", "Could not merge the pull request.", async ({ orgRun }, body) => {
    const merged = await mergeThread(orgRun, { project: body.project, id: body.id, method: body.method });
    return { response: { merged }, detail: { project: body.project, id: merged.id, pr: merged.pr } };
  }),
  orgWrite("/api/org/routine/toggle", "org.routine.toggle", "Could not change the routine.", async ({ orgRun }, body) => {
    const routines = await toggleRoutine(orgRun, { project: body.project, name: body.name, on: body.on });
    return { response: { routines }, detail: { project: body.project, name: body.name, on: body.on } };
  }),
  orgWrite("/api/org/routine/set", "org.routine.set", "Could not change the routine.", async ({ orgRun }, body) => {
    const routines = await setRoutine(orgRun, { project: body.project, name: body.name, schedule: body.schedule, events: body.events, to: body.to, parent: body.parent, prompt: body.prompt });
    // The audit names what changed, never the prompt's words.
    return { response: { routines }, detail: { project: body.project, name: body.name, fields: ["schedule", "events", "to", "parent", "prompt"].filter((key) => body[key] !== undefined) } };
  }),
  orgWrite("/api/org/thread/set", "org.thread.set", "Could not change the thread's automation.", async ({ orgRun }, body) => {
    const flags = await setThreadFlags(orgRun, { project: body.project, id: body.id, autoFixCi: body.autoFixCi, autoMerge: body.autoMerge });
    return { response: { flags }, detail: { project: body.project, ...flags } };
  }),
  // The client names the action from a closed list; Organizations writes the message the agent gets.
  orgWrite("/api/org/thread/pr-action", "org.thread.pr-action", "Could not ask the thread.", async ({ orgRun }, body) => {
    const asked = await prAction(orgRun, { project: body.project, id: body.id, action: body.action });
    return { response: { asked }, detail: { project: body.project, id: asked.id, action: asked.action, pr: asked.pr, sent: asked.sent } };
  }),
  // Spends a small model's call, so it is a write: a read-only device cannot run up the bill.
  orgWrite("/api/org/thread/explain", "org.thread.explain", "Could not explain the report.", async ({ orgRun }, body) => {
    const explained = await explainThread(orgRun, { project: body.project, id: body.id, force: body.force });
    return { response: { explained }, detail: { project: body.project, id: explained.id } };
  }),
  orgWrite("/api/org/thread/pr-create", "org.thread.pr-create", "Could not open the pull request.", async ({ orgRun }, body) => {
    const created = await prCreate(orgRun, { project: body.project, id: body.id });
    return { response: { created }, detail: { project: body.project, ...created } };
  }),
];

/** The coordinator the person chose, by the names the client may send; org-cli.ts checks each one. */
function launch(body: Record<string, unknown>) {
  return { profile: body.profile, harness: body.harness, model: body.model, effort: body.effort };
}

/** That choice for the audit, once it passed the checks: each part a checked string or empty. */
function launchDetail(body: Record<string, unknown>) {
  const part = (value: unknown) => typeof value === "string" ? value : "";
  return { profile: part(body.profile), harness: part(body.harness), model: part(body.model), effort: part(body.effort) };
}

/**
 * A GET of one project's document for the desk's Project panel. A document this Organizations does
 * not have comes back as null with 200, so the panel degrades instead of showing an error.
 */
function orgRead(path: string, failure: string, read: (ctx: Services, project: string) => Promise<object>): Route {
  return {
    method: "GET",
    path,
    access: "read",
    session: false,
    async handle(ctx: Services, { req, url }) {
      try {
        return json({ ok: true, ...(await read(ctx, url.searchParams.get("project") ?? "")) }, req.headers.get("accept-encoding"));
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : failure },
          req.headers.get("accept-encoding"), error instanceof OrgValidationError ? 400 : 502);
      }
    },
  };
}

/**
 * A POST that runs one Organizations write for the person's tap, audits it, and re-reads the
 * projects at once so the `org` event follows the change instead of the next stat. With `settle`
 * the person waits on the change: while the write runs, what it records is read as it lands (`open`
 * records the coordinator's pane seconds before it returns), and the reply waits for the re-read,
 * so the client's next snapshot already shows the change.
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
        const run = () => write(ctx, body as Record<string, unknown>, rt);
        const { response, detail } = settle ? await ctx.projects.urgently(run) : await run();
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
