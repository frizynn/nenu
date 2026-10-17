import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DESKTOP, launchChrome, PHONE, userCacheDir, type Browser, type Page } from "./browser.ts";
import { startTestBridge, type TestBridge } from "./bridge.ts";
import type { DemoHerd, OrgSeed } from "./scenario.ts";

// A question's context on the e2e bench (ADR 0096): a project whose records folder (Organizations'
// `records` setting) is outside the projects root, as a real one can be; a coordinator whose thread
// left a long report with a table, links and captures; an ask and two decisions about the same task;
// and asks marked done while a linked task is still to do. It checks the library and report routes
// from outside the page (what they serve and refuse), then captures Your asks, the coordinator's page
// and the thread's page at 390 and 1440, with a question's context open and a row that does not close.
// The captures are mock screens the bench renders itself, so no real screen or client data is involved.
//
//   bun scripts/e2e/asks-context.ts [--port 8796] [--out DIR] [--label before|after]

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8796" },
    out: { type: "string" },
    label: { type: "string", default: "after" },
  },
});
const port = Number(values.port);
const label = values.label ?? "after";
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), `asks-context-${Date.now()}`);
const COORDINATOR = { id: "t-0020", title: "Frente de pagos" };

/** The records folder of `acme`: beside the projects root, not inside it. */
const recordsOf = (projects: string) => join(projects, "..", "records", "acme");
const libraryOf = (projects: string, thread: string) => join(recordsOf(projects), "library", thread);

const shell = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; } body { font: 15px/1.4 -apple-system, "Helvetica Neue", sans-serif; background: #f6f6f4; color: #1b1b1b; }
  header { display: flex; align-items: center; gap: 10px; padding: 18px 18px 12px; font-weight: 700; font-size: 19px; } header i { width: 26px; height: 26px; border-radius: 8px; background: #2b6be2; display: inline-block; }
  .row { display: flex; justify-content: space-between; align-items: center; padding: 12px 18px; border-top: 1px solid #e3e3df; }
  .muted { color: #777; font-size: 13px; } .btn { display: block; margin: 16px 18px; padding: 14px; border-radius: 12px; background: #2b6be2; color: #fff; text-align: center; font-weight: 700; }
  .tag { padding: 3px 9px; border-radius: 99px; font-size: 12px; font-weight: 600; background: #dfe9fb; color: #1d3f8f; }
</style><header><i></i>${title}</header>${body}`;

const plan = (rows: Array<[string, string]>, footer: string) =>
  rows.map(([left, right]) => `<div class="row"><span>${left}</span><b>${right}</b></div>`).join("") + `<p class="muted" style="padding:10px 18px">${footer}</p><span class="btn">Pagar</span>`;

const MOCKS = [
  { file: "hoy-390.png", caption: "Hoy: el listado muestra la cuota y no el total", width: 390, height: 640,
    html: shell("Zapatilla urbana", plan([["Precio", "$ 89.900"], ["6 cuotas de", "$ 14.983"]], "El total con interés recién aparece en el checkout.")) },
  { file: "opcion-a-390.png", caption: "Opción A: el total final visible desde el listado", width: 390, height: 640,
    html: shell("Zapatilla urbana", plan([["Precio", "$ 89.900"], ["6 cuotas de", "$ 14.983"], ["Total en cuotas", "$ 89.900"]], "<span class=tag>Sin interés</span>")) },
  { file: "opcion-b-390.png", caption: "Opción B: el total sólo en el checkout, con aviso", width: 390, height: 640,
    html: shell("Checkout", plan([["Subtotal", "$ 89.900"], ["Interés", "$ 0"], ["Total", "$ 89.900"]], "Te avisamos el total antes de confirmar.")) },
  { file: "opcion-a-1366.png", caption: "Opción A en escritorio", width: 1100, height: 560,
    html: shell("Zapatilla urbana · Acme", plan([["Precio", "$ 89.900"], ["6 cuotas de", "$ 14.983"], ["Total en cuotas", "$ 89.900"], ["Envío", "Gratis"]], "Mismo bloque que en el teléfono.")) },
];

const REPORT = `Status: needs-decision

## Summary
Propuestas listas para ACM-12: cómo mostrar el total cuando el cliente paga en cuotas.
Recomiendo A, "el total final visible desde el listado". Bocetos probados y números medidos.
Falta decidir A, B o C, y si avisamos a los 412 pedidos de ayer.

## Report
**La pregunta.** Cuando un cliente elige cuotas, ¿ve el total final desde el listado, sólo en el checkout, o lo elige el comercio?

**Hoy.** El listado muestra la cuota y no el total. El total con interés recién aparece en el último paso.

**Medido en producción, sólo lectura, últimos 30 días:**
- 1.240 carritos abandonados en el paso de pago, 38 % más que con un solo pago.
- 412 pedidos de ayer se cobraron con el total viejo.
- 3 comercios tienen cuotas con interés; los demás, sin interés.

**Opciones:**

| | A · Total desde el listado (recomendada) | B · Total en el checkout | C · Elige el comercio |
| --- | --- | --- | --- |
| Abandono esperado en pago | −20 % | −8 % | −8 a −20 % |
| Pantallas que cambian | 3 | 1 | 4 |
| Tamaño | Mediano | Chico | Grande |

Por qué A: el cliente ve lo que va a pagar antes de elegir, y B deja el susto para el final.

**Links.**
- Bocetos: [abrir el tablero](https://boards.example.com/acme/cuotas)
- Tarea: [ACM-12](https://tracker.example.com/issues/12)

**Para decidir.**
1. A, B o C.
2. ¿Avisamos a los 412 pedidos de ayer o los dejamos?

## Captures
${MOCKS.map((mock) => `- ${mock.file} - ${mock.caption}`).join("\n")}

## Next
Elegir A, B o C
Decidir el aviso a los 412 pedidos
`;

const link = (kind: string, text: string, extra: Record<string, unknown> = {}) =>
  ({ kind, text, target: text, thread: "", title: "", state: "", pr: "", pr_state: "", ...extra });
const ask = (line: number, state: string, text: string, answer: string, extra: Record<string, unknown> = {}) =>
  ({ project: "acme", coordinator: COORDINATOR, line, state, text, answer, links: [], confirmed: "", mismatch: "", ...extra });
const decision = (line: number, text: string, links: unknown[]) =>
  ({ project: "acme", coordinator: COORDINATOR, line, text, links, actions: ["answer"] });

const TASK_12 = link("task", "task:ACM-12", { target: "ACM-12", title: "Cuotas: el cliente no ve el total final hasta el checkout", state: "todo" });
const ASKS = [
  ask(5, "needs-decision", "ACM-12 total en cuotas que no se ve hasta el checkout", "3 opciones con bocetos y números, recomendada A", {
    links: [link("thread", "t-0021", { thread: "t-0021", title: "ACM-12 propuestas del total en cuotas", state: "resolved" }), TASK_12],
    confirmed: "in-progress", actions: ["answer"] }),
  ask(6, "done", "Cupones en el carrito", "mergeado", {
    links: [link("pr", "https://github.com/acme/shop/pull/1360", { thread: "t-0022", title: "Cupones en el carrito", state: "merged", pr: "https://github.com/acme/shop/pull/1360", pr_state: "merged" }),
      link("task", "task:ACM-9", { target: "ACM-9", title: "Cupones: aplicar el descuento en el checkout", state: "todo" })],
    confirmed: "in-progress", mismatch: "a linked task is still to do" }),
  ask(7, "done", "Volver a correr las evals de cobros", "corridas, sin cambios", {
    links: [link("thread", "t-0023", { thread: "t-0023", title: "Evals de cobros", state: "resolved" }),
      link("task", "task:ACM-15", { target: "ACM-15", title: "Evals de cobros con el proveedor nuevo", state: "todo" })],
    confirmed: "in-progress", mismatch: "a linked task is still to do" }),
  ask(8, "done", "Resumen de qué andaba mal", "tabla de 4 problemas"),
];
const DECISIONS = [
  decision(14, "ACM-12 cuotas: A total visible desde el listado (recomendada), B sólo en el checkout, o C que elija el comercio", [link("page", "https://boards.example.com/acme/cuotas")]),
  decision(15, "ACM-12 412 pedidos de ayer cobrados con el total viejo: avisarles (recomendada) o dejarlos", [link("page", "https://tracker.example.com/issues/12")]),
  decision(16, "ACM-20 proveedor de respaldo: esperar como hoy (recomendada) o saltar a los 30 s", [link("page", "https://tracker.example.com/issues/20")]),
];

const STATUS = `# Status
Objective: cobros de Acme: cuotas, cupones y proveedor de respaldo

## Asked
- [needs-decision] ACM-12 total en cuotas que no se ve hasta el checkout : 3 opciones con bocetos y números, recomendada A (t-0021, task:ACM-12)
- [done] Cupones en el carrito : mergeado (https://github.com/acme/shop/pull/1360, task:ACM-9)
- [done] Volver a correr las evals de cobros : corridas, sin cambios (t-0023, task:ACM-15)
- [done] Resumen de qué andaba mal : tabla de 4 problemas

## Needs your decision
${DECISIONS.map((row) => `- ${row.text}`).join("\n")}`;

function seed(herd: DemoHerd, now: number, projects: string): OrgSeed {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const records = recordsOf(projects);
  const node = (id: string, title: string, parent: string, role: "worker" | "coordinator", group: string, minutes: number, extra: Record<string, unknown> = {}) => ({
    id, title, parent_id: parent, role, status: group === "resolved" ? "resolved" : "open", group, group_label: group, note: "", branch: "",
    workspace_id: "", tab_id: "", pane_id: "", cwd: "", updated: ago(minutes), report_unacked: false, auto_fix_ci: false, auto_merge: false, pr: null,
    library: join(records, "library", id), report: null, ...extra,
  });
  const fileAsks = ASKS.map(({ project: _project, coordinator: _coordinator, ...rest }) => rest);
  return {
    profiles: ["claude", "codex"],
    asks: ASKS,
    decisions: DECISIONS,
    projects: [{
      slug: "acme", name: "Acme Shop", goal: "Cobros y checkout de Acme", status: "active",
      threads: [
        node("t-0020", COORDINATOR.title, "root", "coordinator", "idle", 4, {
          can_spawn: true, workspace_id: herd.idle.split(":")[0], tab_id: "w1:t1", pane_id: herd.idle,
          status_file: { path: join(records, "nodes", "t-0020", "STATUS.md"), text: STATUS, updated: ago(6),
            objective: "cobros de Acme: cuotas, cupones y proveedor de respaldo", asks: fileAsks, needs_decision: DECISIONS.map((row) => row.text) },
        }),
        node("t-0021", "ACM-12 propuestas del total en cuotas", "t-0020", "worker", "resolved", 50, {
          verdict: "needs-decision", report: join(records, "threads", "t-0021.md"),
          summary: REPORT.split("## Summary\n")[1]!.split("\n\n")[0],
          captures: MOCKS.map((mock) => ({ path: join(libraryOf(projects, "t-0021"), mock.file), caption: mock.caption })),
          deliverables: [{ path: join(libraryOf(projects, "t-0021"), "tablero.html"), kind: "html" }],
        }),
        node("t-0022", "Cupones en el carrito", "t-0020", "worker", "resolved", 300, { verdict: "done", report: join(records, "threads", "t-0022.md"), summary: "Cupones aplicados en el carrito, PR mergeado." }),
        node("t-0023", "Evals de cobros", "t-0020", "worker", "resolved", 500, { verdict: "done", report: join(records, "threads", "t-0023.md"), summary: "Evals corridas, sin cambios." }),
      ],
    }],
  };
}

/** Render the mock screens and write the reports into the records folder, with a link and a stray file to refuse. */
async function writeRecords(browser: Browser, projects: string): Promise<void> {
  const records = recordsOf(projects);
  const library = libraryOf(projects, "t-0021");
  await mkdir(library, { recursive: true });
  await mkdir(join(records, "threads"), { recursive: true });
  const context = await browser.newContext({ deviceScaleFactor: 1, colorScheme: "light" });
  const page = await context.newPage() as Page & { setContent(html: string): Promise<void> };
  for (const mock of MOCKS) {
    await page.setViewportSize({ width: mock.width, height: mock.height });
    await page.setContent(mock.html);
    await page.screenshot({ path: join(library, mock.file) });
  }
  await context.close();
  await writeFile(join(library, "tablero.html"), `<!doctype html><meta charset="utf-8"><title>Cuotas</title><h1>Cuotas: tres opciones</h1>`);
  await writeFile(join(records, "threads", "t-0021.md"), REPORT);
  await writeFile(join(records, "threads", "t-0022.md"), "Status: done\n\n## Summary\nCupones aplicados en el carrito, PR mergeado.\n");
  await writeFile(join(records, "threads", "t-0023.md"), "Status: done\n\n## Summary\nEvals corridas, sin cambios.\n");
  // Outside the library, and a link inside it that leads out: both refused.
  await writeFile(join(records, "secreto.png"), "not a picture");
  await symlink(join(records, "secreto.png"), join(library, "atajo.png")).catch(() => undefined);
}

/** What the library and report routes serve and refuse, asked from outside the page. */
async function checkRoutes(bridge: TestBridge, projects: string) {
  const library = libraryOf(projects, "t-0021");
  const records = recordsOf(projects);
  const get = async (path: string) => {
    const response = await fetch(`${bridge.url}${path}`);
    const body = await response.text();
    return { path: path.replaceAll(encodeURIComponent(projects), "<projects>").replaceAll(projects, "<projects>"), status: response.status, type: response.headers.get("content-type"), bytes: body.length };
  };
  const file = (path: string) => get(`/api/org/library?project=acme&path=${encodeURIComponent(path)}`);
  const served = await Promise.all([...MOCKS.map((mock) => file(join(library, mock.file))), get("/api/org/report?project=acme&thread=t-0021")]);
  const refused = await Promise.all([
    file(join(records, "secreto.png")),
    file(join(library, "..", "..", "secreto.png")),
    file(join(library, "atajo.png")),
    file(join(projects, "acme", "PROJECT.md")),
    get("/api/org/report?project=acme&thread=..%2F..%2Fsecreto"),
    get("/api/org/report?project=acme&thread=t-0099"),
    get("/api/org/report?project=other&thread=t-0021"),
  ]);
  return { served, refused };
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const shots: string[] = [];
  const failures: string[] = [];
  const bridge = await startTestBridge({ port, fake: true, org: seed });
  let browser: Browser | null = null;
  try {
    browser = await launchChrome();
    const projects = join(bridge.dir, "projects");
    await writeRecords(browser, projects);
    const deadline = Date.now() + 15_000;
    while ((await (await fetch(`${bridge.url}/api/org/summary?project=acme`)).json() as { threads: unknown }).threads === null) {
      if (Date.now() > deadline) throw new Error("the overview was never read");
      await Bun.sleep(200);
    }
    const routes = await checkRoutes(bridge, projects);
    if (label === "after") {
      if (routes.served.some((entry) => entry.status !== 200)) failures.push("a file in the records folder was refused");
      if (routes.refused.some((entry) => entry.status !== 404)) failures.push("a route served what it must refuse");
    }

    const open = async (path: string, device: Record<string, unknown>, heading: string | RegExp) => {
      const context = await browser!.newContext({ ...device, timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      await page.goto(bridge.url + path);
      await page.getByRole("heading", { name: heading }).first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1500);
      return { page, context };
    };
    const shoot = async (page: Page, name: string) => {
      const path = join(outDir, `${label}-${name}.png`);
      await page.screenshot({ path, animations: "disabled" });
      shots.push(path);
    };
    const TALL_PHONE = { ...PHONE, viewport: { width: 390, height: 2400 } };
    const TALL_DESKTOP = { ...DESKTOP, viewport: { width: 1440, height: 1800 } };
    const pages: Record<string, unknown> = {};

    for (const [width, device] of [["390", TALL_PHONE], ["1440", TALL_DESKTOP]] as const) {
      {
        const { page, context } = await open("/asks", device, "Your asks");
        pages[`asks-${width}`] = { rows: await page.locator("main li").count() };
        await shoot(page, `asks-${width}`);
        const context_ = page.getByRole("button", { name: /^Context/ }).first();
        if (await context_.count()) {
          await context_.click();
          // A phone draws a table as one card per row (1.25.0); either way its first row's label shows.
          await page.getByText("Abandono esperado en pago").first().waitFor({ timeout: 10_000 }).catch(() => failures.push(`asks-${width}: the context shows no table`));
          await page.waitForTimeout(1200);
          const images = await page.locator('[aria-label="Captures"] img').evaluateAll((list) => list.map((image) => (image as HTMLImageElement).naturalWidth));
          pages[`asks-${width}-context`] = { images };
          if (!images.length || images.some((value) => value === 0)) failures.push(`asks-${width}: a capture in the context did not load`);
          await shoot(page, `asks-${width}-context`);
        } else if (label === "after") failures.push(`asks-${width}: no Context`);
        await context.close();
      }
      {
        const { page, context } = await open(`/project/acme/node/${COORDINATOR.id}`, device, COORDINATOR.title);
        await shoot(page, `coordinator-${width}`);
        const unclosed = page.locator('section[aria-label="Does not close"]').first();
        if (await unclosed.count()) {
          await unclosed.scrollIntoViewIfNeeded();
          const text = await unclosed.innerText();
          pages[`coordinator-${width}`] = { unclosed: text.slice(0, 400) };
          if (label === "after" && !/ACM-9/.test(text)) failures.push(`coordinator-${width}: Does not close does not name the open task`);
        }
        await context.close();
      }
      {
        const { page, context } = await open("/project/acme/node/t-0021", device, /ACM-12 propuestas/);
        const images = await page.locator('[aria-label="Captures"] img').evaluateAll((list) => list.map((image) => (image as HTMLImageElement).naturalWidth));
        pages[`thread-${width}`] = { images };
        if (label === "after" && (!images.length || images.some((value) => value === 0))) failures.push(`thread-${width}: a capture did not load`);
        await shoot(page, `thread-${width}`);
        await context.close();
      }
    }

    const result = { label, outDir, shots, routes, pages, failures };
    await writeFile(join(outDir, `asks-context-${label}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser?.close();
    await bridge.stop();
  }
  if (failures.length) process.exit(1);
}

await main();
