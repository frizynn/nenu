import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DESKTOP, launchWebkit, PHONE, userCacheDir, type Browser, type Page } from "./browser.ts";
import { startTestBridge } from "./bridge.ts";
import type { OrgSeed } from "./scenario.ts";

// A coordinator's STATUS.md on the e2e bench (ADR 0090): a project whose root coordinator and one
// nested coordinator each keep one, with every `[state]` the template names, thread ids, links and
// the five sections, written as an agent would. It checks that the text reaches the page through
// `/api/org/summary` and never the snapshot, that the block sits in a phone's first screen on the
// project page and heads the coordinator's page, that a thread id opens its node, and captures both
// pages on a phone (folded, opened, light) and a desk. `--quiet` seeds the same project without the
// field, an Organizations that predates it: no block, the pages as before.
//
//   bun scripts/e2e/coordinator-status.ts [--quiet] [--port 8798] [--out DIR]

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8798" },
    out: { type: "string" },
    quiet: { type: "boolean", default: false },
  },
});
const port = Number(values.port);
const quiet = values.quiet === true;
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), `coordinator-status-${Date.now()}`);
const CAPTURE_EPOCH = Date.parse("2026-10-16T14:00:00Z");
const PROJECT = "/project/acme";
const NODE = "/project/acme/node/t-0010";

const ROOT_STATUS = `# Status
Objective: lanzar el checkout nuevo de Acme antes del viernes

## Asked
- [needs-decision] ¿Lista o tarjetas para el stock en el teléfono? : t-0011 dejó las dos opciones con capturas (https://github.com/acme/shop/pull/1352)
- [working] Que el pago con QR funcione en prueba : falta la clave del proveedor, t-0012 la espera
- [answered] ¿Cuánto sale el envío al interior? : $ 7.800, de 3 a 5 días
- [done] Cupones de descuento en el carrito : aprobado y en verde (https://github.com/acme/shop/pull/1351)
- [open] Revisar los textos de la landing : todavía no empezó

## Needs your decision
- Diseño del stock : lista compacta o tarjetas con foto ([comparación](https://github.com/acme/shop/pull/1352))
- Clave de prueba del proveedor de pagos : pasarla hoy o dejar el QR para la semana que viene

## In progress
- t-0010 Rediseño del checkout : cuatro de seis partes listas
- t-0013 Landing a 390 px : armando la versión para teléfono

## Done
- t-0015 Login con email (https://github.com/acme/shop/pull/1344)
- t-0001 Hotfix del login

## Decisions
- 2026-10-14 El checkout sale en partes, un PR por parte
- 2026-10-15 Los envíos cobran por zona

## Next
- Cerrar el stock apenas elijas el diseño
- Probar el pago con QR de punta a punta`;

const CHECKOUT_STATUS = `# Status
Objective: el checkout nuevo en seis partes, cada una con su PR

## Asked
- [needs-decision] Diseño del stock a 390 px : elegí lista o tarjetas, t-0011 lo termina hoy
- [working] Pago con QR : trabado por la clave de prueba (t-0012)
- [done] Cupones : PR #1351 aprobado

## Needs your decision
- Stock : lista o tarjetas (https://github.com/acme/shop/pull/1352)

## In progress
- t-0013 Landing a 390 px : en curso

## Done
- t-0014 Cupones de descuento (https://github.com/acme/shop/pull/1351)
- t-0015 Login con email (https://github.com/acme/shop/pull/1344)

## Next
- Envíos y stock`;

function seed(_herd: unknown, now: number, projects: string): OrgSeed {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const status = (file: string, text: string, minutes: number) => quiet ? {} : { status_file: { path: join(projects, "acme", file), text, updated: ago(minutes) } };
  const node = (id: string, title: string, parent: string, role: "worker" | "coordinator", group: string, minutes: number, extra: Record<string, unknown> = {}) => ({
    id, title, parent_id: parent, role, status: group === "resolved" ? "resolved" : "open", group, group_label: group, note: "", branch: "",
    workspace_id: "", tab_id: "", pane_id: "", cwd: "", updated: ago(minutes), report_unacked: false, auto_fix_ci: false, auto_merge: false, pr: null, ...extra,
  });
  return {
    profiles: ["claude", "codex"],
    projects: [{
      slug: "acme", name: "Acme Shop", goal: "Coordinar iniciativas de Acme que requieran varios threads o PRs", status: "active",
      ...status("STATUS.md", ROOT_STATUS, 4),
      threads: [
        node("t-0001", "Hotfix del login", "root", "worker", "resolved", 900),
        node("t-0010", "Rediseño del checkout", "root", "coordinator", "idle", 3, status("checkout/STATUS.md", CHECKOUT_STATUS, 12)),
        node("t-0011", "Panel de stock a 390 px", "t-0010", "worker", "waiting-on-you", 12),
        node("t-0012", "Pago con QR", "t-0010", "worker", "idle", 40),
        node("t-0013", "Landing a 390 px", "t-0010", "worker", "working", 1),
        node("t-0014", "Cupones de descuento", "t-0010", "worker", "ready-for-review", 25),
        node("t-0015", "Login con email", "t-0010", "worker", "resolved", 600),
      ],
    }],
  };
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const shots: string[] = [];
  const failures: string[] = [];
  const bridge = await startTestBridge({ port, fake: true, epoch: CAPTURE_EPOCH, org: seed });
  let browser: Browser | null = null;
  try {
    // The files the overview names, so the bridge's stat of them has something to watch.
    const projects = join(bridge.dir, "projects");
    await mkdir(join(projects, "acme", "checkout"), { recursive: true });
    await writeFile(join(projects, "acme", "STATUS.md"), ROOT_STATUS);
    await writeFile(join(projects, "acme", "checkout", "STATUS.md"), CHECKOUT_STATUS);

    // The first read paints from the files; wait for the overview, then compare what each route carries.
    const deadline = Date.now() + 15_000;
    while ((await (await fetch(`${bridge.url}/api/org/summary?project=acme`)).json() as { threads: unknown }).threads === null) {
      if (Date.now() > deadline) throw new Error("the overview was never read");
      await Bun.sleep(200);
    }
    const snapshot = await (await fetch(`${bridge.url}/api/snapshot`)).text();
    const summary = await (await fetch(`${bridge.url}/api/org/summary?project=acme`)).json() as { status: { text: string } | null; threads: Array<{ id: string; status?: unknown }> | null };
    const wire = {
      snapshotBytes: snapshot.length,
      snapshotHasText: snapshot.includes("Objective:"),
      snapshotStamps: (snapshot.match(/"statusUpdated"/g) ?? []).length,
      summaryRoot: summary.status !== null,
      summaryThreads: summary.threads?.filter((thread) => thread.status).map((thread) => thread.id) ?? null,
    };
    if (wire.snapshotHasText) failures.push("the snapshot carries a STATUS.md's text");
    if (!quiet && (!wire.summaryRoot || wire.summaryThreads?.join() !== "t-0010")) failures.push("the summaries did not carry both STATUS.md files");
    if (quiet && (wire.summaryRoot || wire.snapshotStamps)) failures.push("an Organizations without the field produced a STATUS.md");

    browser = await launchWebkit();
    const open = async (path: string, device: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      const context = await browser!.newContext({ ...device, timezoneId: "UTC", locale: "en-US", ...extra }) as Awaited<ReturnType<Browser["newContext"]>>;
      const page = await context.newPage();
      await page.clock.install({ time: bridge.now() });
      await page.goto(bridge.url + path);
      await page.getByRole("heading", { name: path === NODE ? "Rediseño del checkout" : "Acme Shop" }).first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1200);
      return { page, context };
    };
    const shoot = async (page: Page, name: string) => {
      const path = join(outDir, `${name}${quiet ? "-quiet" : ""}.png`);
      await page.screenshot({ path, animations: "disabled" });
      shots.push(path);
    };
    /** Where the block sits on screen and what it holds, or null without one. */
    const measure = (page: Page) => page.evaluate(() => {
      const block = document.querySelector<HTMLElement>('section[aria-label="Status"]');
      if (!block) return null;
      const box = block.getBoundingClientRect();
      const regions = Array.from(document.querySelectorAll("main section[aria-label]")).map((section) => section.getAttribute("aria-label"));
      return {
        top: Math.round(box.top), bottom: Math.round(box.bottom), viewport: window.innerHeight, first: regions[0],
        chips: Array.from(block.querySelectorAll("[data-state]")).map((chip) => chip.getAttribute("data-state")),
        ids: Array.from(block.querySelectorAll("button")).map((button) => button.textContent).filter((text) => text?.startsWith("t-")),
        showAll: Array.from(block.querySelectorAll("button")).some((button) => button.textContent === "Show all"),
      };
    }, null);

    const layout: Record<string, unknown> = {};
    for (const [name, path, device] of [
      ["project-phone", PROJECT, PHONE], ["node-phone", NODE, PHONE],
      ["project-desktop", PROJECT, DESKTOP], ["node-desktop", NODE, DESKTOP],
    ] as const) {
      const { page, context } = await open(path, device);
      const block = await measure(page);
      layout[name] = block;
      await shoot(page, `status-${name}`);
      if (quiet) {
        if (block) failures.push(`${name}: a block without the field`);
        await context.close();
        continue;
      }
      if (!block) failures.push(`${name}: no Status block`);
      else {
        if (block.top >= block.viewport) failures.push(`${name}: the block starts below the first screen`);
        if (path === NODE && block.first !== "Status") failures.push(`${name}: the block does not head the page`);
      }
      if (name === "project-phone") {
        // The page scrolls inside its column, so the whole file is shot on a phone as tall as it.
        await page.setViewportSize({ width: 390, height: 1900 });
        await page.getByRole("button", { name: "Show all" }).click();
        await page.waitForTimeout(300);
        await shoot(page, "status-project-phone-open");
        await page.setViewportSize(PHONE.viewport);
      }
      if (name === "node-phone") {
        await page.getByRole("button", { name: "t-0011" }).first().click();
        await page.waitForTimeout(600);
        if (!page.url().endsWith("/project/acme/node/t-0011")) failures.push(`node-phone: a thread id opened ${page.url()}`);
      }
      await context.close();
    }
    if (!quiet) {
      const { page, context } = await open(PROJECT, { ...PHONE, colorScheme: "light" });
      await shoot(page, "status-project-phone-light");
      await context.close();
    }

    const result = { quiet, outDir, shots, wire, layout, failures };
    await writeFile(join(outDir, `coordinator-status${quiet ? "-quiet" : ""}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser?.close();
    await bridge.stop();
  }
  if (failures.length) process.exit(1);
}

await main();
