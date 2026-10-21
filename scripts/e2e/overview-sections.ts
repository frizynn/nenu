import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DESKTOP, launchChrome, PHONE, userCacheDir, type Page } from "./browser.ts";
import { startTestBridge } from "./bridge.ts";
import type { DemoHerd, OrgSeed } from "./scenario.ts";

// A coordinator's chat panel, the way awam-org's Mi Cúcula looked on 2026-10-21: work three levels
// deep (its own threads, two coordinators under it, one more under one of those), 16 finished, two
// questions waiting on you whose task the tracker does not have. At 1440×900 the desk's Overview, at
// 390×844 the phone's Status tab. Measures how far down the first running thread sits, how many open
// rows the panel lists, any text closer than 10 px to its card's edge and any "missing" chip; then
// folds, hides and reorders sections, reloads to see the device kept them, and resets.
// Exits 1 when a check fails, unless --loose (to measure a build that predates the sections).
//
//   bun scripts/e2e/overview-sections.ts [--port 8876] [--out DIR] [--tag before|after] [--loose]

const { values } = parseArgs({ options: { port: { type: "string", default: "8876" }, out: { type: "string" }, tag: { type: "string", default: "now" }, loose: { type: "boolean" } } });
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), `overview-sections-${Date.now()}`);
const tag = values.tag;
const EPOCH = Date.parse("2026-10-21T22:30:00Z");
/** Open nodes under Mi Cúcula: its own 3, QA facturación and its 3, Rediseño productos and its 4. */
const OPEN_ROWS = 12;

function seed(herd: DemoHerd, now: number, projects: string): OrgSeed {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const bound = (paneId: string, tab: string) => ({ workspace_id: paneId.split(":")[0]!, tab_id: tab, pane_id: paneId });
  const node = (id: number, title: string, parent: string, role: "worker" | "coordinator", group: string, minutes: number, extra: Record<string, unknown> = {}) => ({
    id: `t-${String(id).padStart(4, "0")}`, title, parent_id: parent, role, status: group === "resolved" ? "resolved" : "open", group, group_label: group,
    note: "", branch: "", workspace_id: "", tab_id: "", pane_id: "", cwd: "", updated: ago(minutes), report_unacked: false, auto_fix_ci: false, auto_merge: false, pr: null, ...extra,
  });
  const cucula = { id: "t-0274", title: "Coordinador Mi Cúcula" };
  const missing = (task: string) => ({ kind: "task", text: `task:${task}`, target: task, thread: "", title: "", state: "missing", pr: "", pr_state: "" });
  const ask = (line: number, state: string, text: string, answer: string, task: string) =>
    ({ project: "awam", coordinator: cucula, line, state, text, answer, links: [missing(task)], confirmed: "", mismatch: "", actions: ["answer"] });
  return {
    profiles: ["claude", "codex"],
    answers: true,
    asks: [
      ask(4, "needs-decision", "Seguridad de avisos y captcha del portal de socios", "cuentas de Fran", "seguridad-avisos"),
      ask(5, "needs-decision", "Lanzar el arreglo de stock flex (task stock-flex)", "recomiendo sí y ya", "stock-flex"),
    ],
    projects: [{
      slug: "awam", name: "AWAM", goal: "Comercios de AWAM", status: "active",
      threads: [
        node(274, cucula.title, "root", "coordinator", "idle", 3, {
          ...bound(herd.idle, "w1:t2"),
          status_file: { path: join(projects, "awam", "nodes/t-0274/STATUS.md"), text: "# Status\nObjective: que Mi Cúcula venda por Mercado Libre y Tiendanube sin cargar stock dos veces\n", updated: ago(40),
            objective: "que Mi Cúcula venda por Mercado Libre y Tiendanube sin cargar stock dos veces" },
        }),
        ...Array.from({ length: 16 }, (_, n) => node(400 + n, `Tarea cerrada ${n + 1}`, "t-0274", "worker", "resolved", 600 + n * 60)),
        node(502, "awa1040 stock flex full ml", "t-0274", "worker", "ready-for-review", 25),
        node(506, "Corregir stock tocando número", "t-0274", "worker", "working", 1, bound(herd.working, "w1:t1")),
        node(512, "Flex control envíos", "t-0274", "worker", "idle", 90),
        node(508, "QA facturación y ventas", "t-0274", "coordinator", "idle", 12),
        node(538, "Lote de facturación", "t-0508", "worker", "working", 2),
        node(548, "TN despachadas y facturar en lote", "t-0508", "worker", "working", 4),
        node(549, "PDF de la factura", "t-0508", "worker", "idle", 50),
        node(528, "Rediseño productos", "t-0274", "coordinator", "idle", 30),
        node(532, "Nuevo producto con índice", "t-0528", "worker", "ready-for-review", 18),
        node(542, "Publicar multicanal", "t-0528", "worker", "idle", 70),
        node(560, "Fotos de producto", "t-0528", "coordinator", "idle", 20),
        node(561, "Recorte de fotos", "t-0560", "worker", "working", 5),
        // A coordinator with nothing open under it: its panel says so, inside its card's margin.
        node(300, "Coordinador Herdr Org", "root", "coordinator", "idle", 8, bound(herd.codex, "w2:t1")),
        ...Array.from({ length: 4 }, (_, n) => node(310 + n, `Hecha ${n + 1}`, "t-0300", "worker", "resolved", 900 + n * 30)),
      ],
    }],
  };
}

interface Measure { device: string; rows: number; firstWorkingTop: number | null; viewport: number; nothingRunning: boolean; missingChips: number; tight: string[] }

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const shots: string[] = [];
  const failures: string[] = [];
  const measures: Measure[] = [];
  const check = (ok: boolean, what: string) => { if (!ok) failures.push(what); };
  const bridge = await startTestBridge({ port: Number(values.port), fake: true, epoch: EPOCH, org: seed });
  const browser = await launchChrome().catch(async (error: unknown) => { await bridge.stop(); throw error; });
  const herd = bridge.herd!;
  const shoot = async (page: Page, name: string) => {
    await page.waitForTimeout(400);
    const path = join(outDir, `${tag}-${name}.png`);
    await page.screenshot({ path, animations: "disabled" });
    shots.push(path);
  };
  const measure = (page: Page, device: string, scope: string) => page.evaluate(({ scope, device }) => {
    const root = document.querySelector(scope) ?? document.body;
    const rows = root.querySelectorAll(".overview-work, .overview-thread").length;
    const working = Array.from(root.querySelectorAll<HTMLElement>("[data-node-state=working]")).find((mark) => mark.closest("li"));
    const box = root.getBoundingClientRect();
    // Text that sits within 10 px of its card's left edge: a row that lost its card's padding.
    const tight: string[] = [];
    for (const card of Array.from(root.querySelectorAll<HTMLElement>(".overview-card"))) {
      const edge = card.getBoundingClientRect().left;
      const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (!text.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(text);
        const rect = range.getBoundingClientRect();
        if (rect.width > 0 && rect.left - edge < 10) tight.push(text.textContent.trim().slice(0, 40));
      }
    }
    return {
      device, rows, viewport: window.innerHeight,
      firstWorkingTop: working ? Math.round(working.getBoundingClientRect().top - box.top) : null,
      nothingRunning: (root.textContent ?? "").includes("Nothing running"),
      missingChips: Array.from(root.querySelectorAll("[aria-label=Links] li")).filter((chip) => /missing/.test(chip.textContent ?? "")).length,
      tight,
    };
  }, { scope, device });
  const sectionOrder = (page: Page, scope: string) => page.locator(`${scope} section.overview-card`).evaluateAll((cards) => cards.map((card) => card.getAttribute("aria-label")));

  try {
    // A desk: the coordinator's chat with its panel on Overview.
    for (const scheme of ["dark", "light"] as const) {
      const context = await browser.newContext({ ...DESKTOP, colorScheme: scheme, timezoneId: "America/Argentina/Buenos_Aires", locale: "en-US" });
      const page = await context.newPage();
      await page.clock.install({ time: bridge.now() });
      await page.goto(bridge.url + `/pane/${encodeURIComponent(herd.idle)}`);
      await page.getByRole("textbox").first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(2500);
      const panel = "[aria-label='Session panel']";
      await shoot(page, `desk-overview-${scheme}`);
      if (scheme === "light") { await context.close(); continue; }
      // The coordinator with nothing open: "Nothing running" sits inside its card's margin.
      await page.goto(bridge.url + `/pane/${encodeURIComponent(herd.codex)}`);
      await page.getByRole("textbox").first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(2500);
      await shoot(page, "desk-idle-coordinator");
      const idle = await measure(page, "desk 1440, nothing open", panel);
      measures.push(idle);
      check(idle.nothingRunning, "the coordinator with nothing open does not say Nothing running");
      check(idle.tight.length === 0, `desk text against its card's edge, nothing open: ${idle.tight.join(" | ")}`);
      await page.goto(bridge.url + `/pane/${encodeURIComponent(herd.idle)}`);
      await page.getByRole("textbox").first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(2500);
      const m = await measure(page, "desk 1440", panel);
      measures.push(m);
      check(m.rows === OPEN_ROWS, `desk lists ${m.rows} open rows, not ${OPEN_ROWS}`);
      check(m.firstWorkingTop !== null && m.firstWorkingTop < m.viewport - 100, `desk: the first running thread is at ${m.firstWorkingTop} px, below the fold`);
      check(!m.nothingRunning, "desk says Nothing running");
      check(m.missingChips === 0, `desk draws ${m.missingChips} missing chips`);
      check(m.tight.length === 0, `desk text against its card's edge: ${m.tight.join(" | ")}`);

      const threads = page.locator(`${panel} section[aria-label=Threads] .panel-section-toggle`);
      if (await threads.count()) {
        // Fold Threads, then reload: the device keeps it folded.
        await threads.click();
        await page.waitForTimeout(300);
        await shoot(page, "desk-threads-folded");
        await page.reload();
        await page.getByRole("textbox").first().waitFor({ timeout: 15_000 });
        await page.waitForTimeout(2000);
        check(await threads.getAttribute("aria-expanded") === "false", "Threads did not stay folded after a reload");
        await threads.click();
        // Arrange: Changes to the top, This coordinator hidden; a reload keeps both.
        await page.locator(panel).getByRole("button", { name: /^Arrange/ }).click();
        await shoot(page, "desk-arranging");
        const up = page.locator(panel).getByRole("button", { name: "Move Changes up" });
        while (await up.getAttribute("disabled") === null) await up.click();
        await page.locator(panel).getByRole("button", { name: "Hide This coordinator" }).click();
        await page.locator(panel).getByRole("button", { name: "Done" }).click();
        await page.reload();
        await page.getByRole("textbox").first().waitFor({ timeout: 15_000 });
        await page.waitForTimeout(2000);
        const order = await sectionOrder(page, panel);
        await shoot(page, "desk-arranged");
        check(order[0] === "Changes", `after a reload the first section is ${order[0]}, not Changes`);
        check(!order.includes("This coordinator"), "This coordinator is still drawn after hiding it");
        check(await page.locator(panel).getByRole("button", { name: /Arrange · 1 hidden/ }).count() === 1, "Arrange does not say 1 hidden");
        await page.locator(panel).getByRole("button", { name: /^Arrange/ }).click();
        await page.locator(panel).getByRole("button", { name: "Reset" }).click();
        await page.locator(panel).getByRole("button", { name: "Done" }).click();
        const reset = await sectionOrder(page, panel);
        check(reset[0] === "Threads" && reset.includes("This coordinator"), `after Reset the order is ${reset.join(", ")}`);
      } else {
        check(false, "no foldable Threads section");
      }
      await context.close();
    }

    // A phone: the coordinator's Status tab.
    const context = await browser.newContext({ ...PHONE, timezoneId: "America/Argentina/Buenos_Aires", locale: "en-US" });
    const page = await context.newPage();
    await page.clock.install({ time: bridge.now() });
    await page.goto(bridge.url + `/pane/${encodeURIComponent(herd.idle)}?view=status`);
    await page.waitForTimeout(3000);
    await shoot(page, "phone-status");
    const m = await measure(page, "phone 390", ".project-overlay");
    measures.push(m);
    check(m.missingChips === 0, `phone draws ${m.missingChips} missing chips`);
    check(m.tight.length === 0, `phone text against its card's edge: ${m.tight.join(" | ")}`);
    await page.goto(bridge.url + `/pane/${encodeURIComponent(herd.idle)}?view=threads`);
    await page.waitForTimeout(2000);
    await shoot(page, "phone-threads");
    await context.close();
  } finally {
    await browser.close();
    await bridge.stop();
  }
  const report = { tag, measures, failures, shots };
  await writeFile(join(outDir, `${tag}-report.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ measures, failures }, null, 2));
  console.log(shots.join("\n"));
  if (failures.length && !values.loose) process.exit(1);
}

await main();
