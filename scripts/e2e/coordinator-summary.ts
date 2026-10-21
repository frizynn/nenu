import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DESKTOP, launchWebkit, PHONE, userCacheDir, type Browser, type Page } from "./browser.ts";
import { startTestBridge, type TestBridge } from "./bridge.ts";
import type { DemoHerd, OrgSeed } from "./scenario.ts";

// Reports on the e2e bench: a coordinator whose threads reported in every outcome
// (a decision with three captures and its documents, a blocked one, one working, one done with an
// approved PR, one merged, an old one with no report, and a nested coordinator), with the fields
// Organizations adds (`verdict`, `summary`, `captures`, `deliverables`). The captures are mock
// screens the bench renders itself, so no real screen or client data is involved. It checks the
// library route from outside the page (what it serves and what it refuses), then that the
// coordinator's page lists only its tree (its Summary is gone, ADR 0109) and that a thread's own page
// carries its report, a capture opened large. `--quiet` seeds the same threads without the new
// fields: an Organizations that predates them.
//
//   bun scripts/e2e/coordinator-summary.ts [--quiet] [--port 8797] [--out DIR]

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8797" },
    out: { type: "string" },
    quiet: { type: "boolean", default: false },
  },
});
const port = Number(values.port);
const quiet = values.quiet === true;
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), `coordinator-summary-${Date.now()}`);
const CAPTURE_EPOCH = Date.parse("2026-10-10T14:00:00Z");
const NODE = "/project/acme/node/t-0010";
const THREAD = "/project/acme/node/t-0011";

/** A mock screen: what an agent's screenshot of its own work looks like, drawn from markup. */
interface Mock { thread: string; file: string; caption: string; width: number; height: number; html: string }

const shell = (title: string, body: string, dark = false) => `<!doctype html><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; } body { font: 15px/1.4 -apple-system, "Helvetica Neue", sans-serif; background: ${dark ? "#111" : "#f6f6f4"}; color: ${dark ? "#eee" : "#1b1b1b"}; }
  header { display: flex; align-items: center; gap: 10px; padding: 18px 18px 12px; font-weight: 700; font-size: 19px; } header i { width: 26px; height: 26px; border-radius: 8px; background: #e2572b; display: inline-block; }
  .row { display: flex; justify-content: space-between; align-items: center; padding: 12px 18px; border-top: 1px solid ${dark ? "#2a2a2a" : "#e3e3df"}; }
  .muted { color: ${dark ? "#999" : "#777"}; font-size: 13px; } .pill { padding: 3px 9px; border-radius: 99px; font-size: 12px; font-weight: 600; }
  .ok { background: #d9f2df; color: #1d6b34; } .low { background: #fde6cf; color: #8a4b0c; } .out { background: #fbd9d9; color: #8f1d1d; }
  .card { margin: 10px 14px; padding: 12px; border-radius: 14px; background: ${dark ? "#1c1c1c" : "#fff"}; box-shadow: 0 1px 2px rgb(0 0 0 / 8%); display: flex; gap: 12px; align-items: center; }
  .ph { width: 58px; height: 58px; border-radius: 10px; flex-shrink: 0; } .btn { display: block; margin: 16px 18px; padding: 14px; border-radius: 12px; background: #e2572b; color: #fff; text-align: center; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; } td, th { text-align: left; padding: 10px 14px; border-top: 1px solid #e3e3df; }
</style><header><i></i>${title}</header>${body}`;

const products = [["Yerba 1 kg", 42, "ok"], ["Café molido 500 g", 6, "low"], ["Alfajores x12", 0, "out"], ["Dulce de leche", 18, "ok"], ["Galletitas surtidas", 3, "low"], ["Mate de calabaza", 11, "ok"], ["Bombilla acero", 25, "ok"], ["Termo 1 l", 1, "low"]] as const;
const tone = (state: string) => state === "ok" ? "ok" : state === "low" ? "low" : "out";
const label = (n: number) => n === 0 ? "Sin stock" : `${n} u.`;

function mocks(): Mock[] {
  const list = products.map(([name, n, state]) => `<div class="row"><div>${name}<div class="muted">SKU ${String(name.length * 137).padStart(5, "0")}</div></div><span class="pill ${tone(state)}">${label(n)}</span></div>`).join("");
  const colors = ["#c9a46b", "#6b4a2b", "#e8d3a8", "#b5651d", "#d8c3a5", "#7a9e7e", "#9aa5b1", "#5b7c99"];
  const cards = products.slice(0, 5).map(([name, n, state], i) => `<div class="card"><div class="ph" style="background:${colors[i]}"></div><div style="flex:1"><b>${name}</b><div class="muted">Depósito central</div></div><span class="pill ${tone(state)}">${label(n)}</span></div>`).join("");
  const table = `<table><tr><th>Producto</th><th>Depósito</th><th>Stock</th><th>Reposición</th></tr>${products.map(([name, n, state]) => `<tr><td>${name}</td><td>Central</td><td><span class="pill ${tone(state)}">${label(n)}</span></td><td class="muted">${n < 5 ? "Pedir hoy" : "En orden"}</td></tr>`).join("")}</table>`;
  return [
    { thread: "t-0011", file: "stock-lista.png", caption: "Opción A: lista compacta, entra todo en una pantalla", width: 390, height: 640, html: shell("Stock", list) },
    { thread: "t-0011", file: "stock-tarjetas.png", caption: "Opción B: tarjetas con foto, se leen mejor pero piden scroll", width: 390, height: 640, html: shell("Stock", cards) },
    { thread: "t-0011", file: "stock-escritorio.png", caption: "Las dos opciones en escritorio usan la misma tabla", width: 1100, height: 560, html: shell("Stock · Depósito central", table) },
    { thread: "t-0012", file: "qr-error.png", caption: "El pago con QR se corta acá: falta la clave de prueba", width: 390, height: 640, html: shell("Pagar", `<div style="padding:60px 24px;text-align:center"><div style="font-size:54px">⚠️</div><h2 style="margin:14px 0 8px">No pudimos generar el QR</h2><p class="muted">El proveedor rechazó la credencial (401). Probá de nuevo más tarde.</p></div><span class="btn">Volver al carrito</span>`) },
    { thread: "t-0014", file: "carrito-cupon.png", caption: "Cupón aplicado: el total baja de $ 48.900 a $ 41.565", width: 390, height: 640, html: shell("Carrito", `${list.split("</div></div>").slice(0, 3).join("</div></div>")}</div></div><div class="row"><b>Cupón OTOÑO15</b><span class="pill ok">−15 %</span></div><div class="row"><span class="muted">Antes</span><s class="muted">$ 48.900</s></div><div class="row"><b>Total</b><b>$ 41.565</b></div><span class="btn">Pagar</span>`) },
    { thread: "t-0014", file: "cupon-vencido.png", caption: "Un cupón vencido dice por qué y no cambia el total", width: 390, height: 640, html: shell("Carrito", `<div class="row"><b>Cupón VERANO10</b><span class="pill out">Vencido</span></div><p class="muted" style="padding:6px 18px">Este cupón venció el 31/03. El total no cambió.</p><div class="row"><b>Total</b><b>$ 48.900</b></div><span class="btn">Pagar</span>`) },
    { thread: "t-0015", file: "login-email.png", caption: "Entrar con email, en iPhone", width: 390, height: 640, html: shell("Acme", `<div style="padding:40px 22px"><h2 style="margin-bottom:6px">Entrá a tu cuenta</h2><p class="muted">Te mandamos un enlace al email.</p><div style="margin-top:22px;padding:14px;border-radius:12px;border:1px solid #ccc;background:#fff">fran@acme.test</div></div><span class="btn">Mandar enlace</span>`, true) },
    { thread: "t-0018", file: "tarifas-zona.png", caption: "Tarifas por zona: CABA $ 2.900, GBA $ 4.400, interior $ 7.800", width: 390, height: 640, html: shell("Envíos", ["CABA · 24 h · $ 2.900", "GBA · 48 h · $ 4.400", "Interior · 3 a 5 días · $ 7.800"].map((zone) => `<div class="row"><span>${zone.split(" · ").slice(0, 2).join(" · ")}</span><b>${zone.split(" · ")[2]}</b></div>`).join("")) },
  ];
}

/** A one-page PDF that says `text`, with a correct cross-reference table. */
function pdf(text: string): Buffer {
  const stream = `BT /F1 20 Tf 60 760 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const at = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return at;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

const library = (projects: string, thread: string, file: string) => join(projects, "acme", "library", thread, file);

function seed(herd: DemoHerd, now: number, projects: string): OrgSeed {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const shots = mocks();
  const captures = (thread: string) => shots.filter((shot) => shot.thread === thread).map((shot) => ({ path: library(projects, thread, shot.file), caption: shot.caption }));
  const report = (thread: string, verdict: string, summary: string, deliverables: Array<[string, "html" | "pdf"]> = []) => quiet ? {} : {
    verdict, summary, captures: captures(thread), deliverables: deliverables.map(([file, kind]) => ({ path: library(projects, thread, file), kind })),
  };
  const pr = (number: number, extra: Record<string, unknown>) => ({
    url: `https://github.com/acme/shop/pull/${number}`, state: "OPEN", review: "REVIEW_REQUIRED", checks: { passed: 6, pending: 0, failed: 0 },
    additions: 120 + number, deletions: 14, failing: [], comment_count: 0, draft: false, mergeable: "MERGEABLE", merge_blocker: null, actions: [], ...extra,
  });
  const node = (id: string, title: string, parent: string, role: "worker" | "coordinator", group: string, minutes: number, extra: Record<string, unknown> = {}) => ({
    id, title, parent_id: parent, role, status: group === "resolved" ? "resolved" : "open", group, group_label: group, note: "", branch: "",
    workspace_id: "", tab_id: "", pane_id: "", cwd: "", updated: ago(minutes), report_unacked: false, auto_fix_ci: false, auto_merge: false, pr: null, ...extra,
  });
  return {
    profiles: ["claude", "codex"],
    projects: [{
      slug: "acme", name: "Acme Shop", goal: "Coordinar iniciativas de Acme que requieran varios threads o PRs", status: "active",
      threads: [
        node("t-0001", "Hotfix login", "root", "worker", "idle", 300),
        node("t-0010", "Rediseño del checkout", "root", "coordinator", "idle", 3, report("t-0010", "needs-decision",
          "El checkout nuevo va en seis partes. Cupones y login ya están; envíos avanza. El pago con QR está trabado por una clave, y el panel de stock espera que elijas entre dos diseños.",
          [["plan.html", "html"]])),
        node("t-0011", "Panel de stock a 390 px", "t-0010", "worker", "idle", 12, report("t-0011", "needs-decision",
          "Hay dos formas de mostrar el stock en el teléfono. La lista entra en una pantalla; las tarjetas se leen mejor pero piden scroll. Las dos funcionan igual en escritorio. Elegí una y la termino hoy.",
          [["comparacion.html", "html"], ["comparacion.pdf", "pdf"]])),
        node("t-0012", "Pago con QR", "t-0010", "worker", "idle", 40, report("t-0012", "blocked",
          "Falta la clave de prueba del proveedor de pagos. Sin ella no puedo probar el pago de punta a punta. Si me la pasás, lo cierro en una hora.")),
        node("t-0013", "Landing a 390 px", "t-0010", "worker", "working", 0, { workspace_id: herd.working.split(":")[0], tab_id: "w1:t1", pane_id: herd.working }),
        node("t-0014", "Cupones de descuento", "t-0010", "worker", "ready-for-review", 25, {
          ...report("t-0014", "done", "Los cupones se aplican en el carrito y el total se recalcula. Un cupón vencido avisa por qué. Probado con 12 casos; el PR está aprobado y en verde."),
          pr: pr(1351, { review: "APPROVED" }),
        }),
        node("t-0015", "Login con email", "t-0010", "worker", "resolved", 600, {
          ...report("t-0015", "done", "Entrar con email funciona en iPhone y en escritorio. Ya está mergeado."),
          pr: pr(1344, { state: "MERGED", review: "APPROVED" }),
        }),
        node("t-0016", "Auditar estilos", "t-0010", "worker", "resolved", 900),
        node("t-0017", "Envíos", "t-0010", "coordinator", "working", 5),
        node("t-0018", "Tarifas por zona", "t-0017", "worker", "ready-for-review", 18, {
          ...report("t-0018", "done", "Las tarifas salen de una tabla por zona y se ven antes de pagar. Faltan dos checks que siguen corriendo."),
          pr: pr(1356, { checks: { passed: 4, pending: 2, failed: 0 } }),
        }),
      ],
    }],
  };
}

/** Render the mock screens into the library and write the documents beside them. */
async function writeLibrary(browser: Browser, projects: string): Promise<void> {
  const context = await browser.newContext({ deviceScaleFactor: 1, colorScheme: "light" });
  const page = await context.newPage() as Page & { setContent(html: string): Promise<void> };
  for (const shot of mocks()) {
    await mkdir(join(projects, "acme", "library", shot.thread), { recursive: true });
    await page.setViewportSize({ width: shot.width, height: shot.height });
    await page.setContent(shot.html);
    await page.screenshot({ path: library(projects, shot.thread, shot.file) });
  }
  await context.close();
  await mkdir(join(projects, "acme", "library", "t-0010"), { recursive: true });
  await writeFile(library(projects, "t-0011", "comparacion.html"), `<!doctype html><meta charset="utf-8"><title>Stock: dos opciones</title>
<style>body{font:16px/1.5 -apple-system,sans-serif;margin:24px;max-width:960px} .two{display:flex;gap:16px;flex-wrap:wrap} img{width:300px;border-radius:12px;border:1px solid #ddd}</style>
<h1>Panel de stock: dos opciones</h1><p>La lista entra en una pantalla. Las tarjetas se leen mejor pero piden scroll.</p>
<div class="two"><figure><img src="stock-lista.png"><figcaption>Opción A</figcaption></figure><figure><img src="stock-tarjetas.png"><figcaption>Opción B</figcaption></figure></div>`);
  await writeFile(library(projects, "t-0011", "comparacion.pdf"), pdf("Panel de stock: dos opciones"));
  await writeFile(library(projects, "t-0011", "notas.md"), "# Notas\n\nLas dos opciones comparten la tabla de escritorio.\n");
  await writeFile(library(projects, "t-0010", "plan.html"), `<!doctype html><meta charset="utf-8"><title>Plan</title><h1>Rediseño del checkout</h1><ol><li>Cupones</li><li>Login</li><li>Envíos</li><li>Pago con QR</li><li>Stock</li><li>Landing</li></ol>`);
}

/** What the library route serves and refuses, asked from outside the page as a phone's new tab would. */
async function checkLibrary(bridge: TestBridge, projects: string) {
  const ask = async (path: string, project = "acme") => {
    const response = await fetch(`${bridge.url}/api/org/library?project=${project}&path=${encodeURIComponent(path)}`);
    await response.arrayBuffer();
    return { path: path.replace(projects, "<projects>"), project, status: response.status, type: response.headers.get("content-type"), csp: response.headers.get("content-security-policy") };
  };
  const served = await Promise.all([
    ...mocks().map((shot) => ask(library(projects, shot.thread, shot.file))),
    ask(library(projects, "t-0011", "comparacion.html")),
    ask(library(projects, "t-0011", "comparacion.pdf")),
  ]);
  const refused = await Promise.all([
    ask(library(projects, "t-0011", "notas.md")),
    ask(join(projects, "acme", "PROJECT.md")),
    ask(join(projects, "acme", "library", "..", "PROJECT.md")),
    ask(join(projects, "acme", "library", "t-0011", "..", "..", "PROJECT.png")),
    ask("/etc/passwd"),
    ask(library(projects, "t-0011", "stock-lista.png"), "other"),
  ]);
  const summary = await (await fetch(`${bridge.url}/api/org/summary?project=acme`)).json() as { threads: unknown[] | null };
  return { served, refused, summaries: summary.threads?.length ?? null };
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const shots: string[] = [];
  const failures: string[] = [];
  const bridge = await startTestBridge({ port, fake: true, epoch: CAPTURE_EPOCH, org: seed });
  let browser: Browser | null = null;
  try {
    browser = await launchWebkit();
    const projects = join(bridge.dir, "projects");
    await writeLibrary(browser, projects);
    const library = await checkLibrary(bridge, projects);
    if (!quiet && library.served.some((entry) => entry.status !== 200)) failures.push("the library refused a file inside it");
    if (library.refused.some((entry) => entry.status !== 404)) failures.push("the library served a file it must refuse");

    const open = async (path: string, device: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      const context = await browser!.newContext({ ...device, timezoneId: "UTC", locale: "en-US", ...extra }) as Awaited<ReturnType<Browser["newContext"]>>;
      const page = await context.newPage();
      await page.clock.install({ time: bridge.now() });
      await page.goto(bridge.url + path);
      await page.locator("main").getByText(path === NODE ? "Rediseño del checkout" : "Panel de stock a 390 px").first().waitFor({ timeout: 15_000 }).catch(async (error: unknown) => {
        await page.screenshot({ path: join(outDir, "stuck.png") });
        throw error;
      });
      await page.waitForTimeout(1200);
      return { page, context };
    };
    const shoot = async (page: Page, name: string) => {
      const path = join(outDir, `${name}${quiet ? "-quiet" : ""}.png`);
      await page.screenshot({ path, animations: "disabled" });
      shots.push(path);
    };

    // The coordinator's page lists its live work as the tree, never its threads' reports (ADR 0109).
    for (const [name, device] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
      const { page, context } = await open(NODE, device);
      if (await page.getByRole("tab", { name: "Summary" }).count()) failures.push(`${name}: the coordinator page still offers a Summary`);
      if (await page.locator("main article").count()) failures.push(`${name}: the coordinator page draws report cards`);
      await shoot(page, `coordinator-${name}`);
      await context.close();
    }
    // A thread's own page carries its report: its words, its captures (opened large) and its documents.
    for (const [name, device] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
      const { page, context } = await open(THREAD, device);
      await shoot(page, `report-${name}`);
      if (name === "phone" && !quiet) {
        await page.getByRole("button", { name: /^Open Opción A/ }).click();
        await page.getByRole("dialog", { name: /^Opción A/ }).waitFor({ timeout: 5000 });
        await page.waitForTimeout(600);
        await shoot(page, "capture-open-phone");
      }
      await context.close();
    }
    const result = { quiet, outDir, shots, library, failures };
    await writeFile(join(outDir, `coordinator-summary${quiet ? "-quiet" : ""}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser?.close();
    await bridge.stop();
  }
  if (failures.length) process.exit(1);
}

await main();
