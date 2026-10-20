import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DESKTOP, launchChrome, PHONE, userCacheDir, type Browser, type Page } from "./browser.ts";
import { startTestBridge } from "./bridge.ts";
import type { DemoHerd, OrgSeed } from "./scenario.ts";

// Home's projects and the desk's chats, captured with Google Chrome headless at 1440 and 390 px over
// three projects shaped like a busy herd: one with twenty open threads that all moved today (asks,
// work, reviews, pull requests in every state), one whose threads moved days and weeks ago, and a
// paused one. Captures Home, the desk's bar folded and unfolded, the fold mid-way, and the phone's Home,
// then checks that no period heading is drawn without a chat under it.
//
//   bun scripts/e2e/home-projects.ts [--port 8871] [--out DIR] [--tag before|after]

const { values } = parseArgs({ options: { port: { type: "string", default: "8871" }, out: { type: "string" }, tag: { type: "string", default: "now" } } });
const port = Number(values.port);
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), `home-projects-${Date.now()}`);
const tag = values.tag;
// A Tuesday evening, as in the operator's capture of Home.
export const EPOCH = Date.parse("2026-10-20T21:30:00Z");

export function seed(herd: DemoHerd, now: number): OrgSeed {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const bound = (paneId: string, tabId: string) => ({ workspace_id: paneId.split(":")[0]!, tab_id: tabId, pane_id: paneId });
  const pr = (number: number, extra: Record<string, unknown> = {}) => ({
    url: `https://github.com/acme/shop/pull/${number}`, state: "OPEN", review: "REVIEW_REQUIRED", checks: { passed: 6, pending: 0, failed: 0 },
    additions: 120, deletions: 30, failing: [], comment_count: 0, draft: false, mergeable: "MERGEABLE", merge_blocker: null, ...extra,
  });
  const node = (id: string, title: string, parent: string, role: "worker" | "coordinator", group: string, minutes: number, extra: Record<string, unknown> = {}) => ({
    id, title, parent_id: parent, role, can_spawn: role === "coordinator", status: group === "resolved" ? "resolved" : "open", group, group_label: group, note: "",
    branch: "", workspace_id: "", tab_id: "", pane_id: "", cwd: "", updated: ago(minutes), report_unacked: false, auto_fix_ci: false, auto_merge: false, pr: null, ...extra,
  });
  const HOUR = 60;
  const DAY = 24 * HOUR;
  const today = [
    ["Ficha de producto por canal", "working"], ["Publicaciones: revisar y vincular", "working"], ["Publicar el formulario C", "working"],
    ["Archivar y pausar en canales", "working"], ["Gastos en Inicio", "working"], ["Facturar con datos fiscales", "working"],
    ["Factura emitida afuera", "idle"], ["Opción atada a otra variante", "working"], ["Mensaje de las 24 h", "working"],
    ["Auditoría antes del release", "working"], ["Prueba de Beacon en modo local", "idle"], ["Borrar el código muerto", "ready-for-review"],
  ] as const;
  return {
    profiles: ["claude", "codex"],
    projects: [{
      slug: "acme-shop", name: "Acme Shop", goal: "Coordinar el trabajo de la tienda: frentes, agentes, revisiones y merges", status: "active",
      threads: [
        node("t-0001", "Buscador viejo", "root", "worker", "resolved", 3 * DAY),
        node("t-0010", "Coordinador de canales", "root", "coordinator", "working", 1, bound(herd.idle, "w1:t2")),
        node("t-0011", "Webhook de pagos", "t-0010", "worker", "waiting-on-you", 3, bound(herd.blocked, "w2:t1")),
        node("t-0012", "Variantes nuevas", "t-0010", "worker", "working", 0, { ...bound(herd.working, "w1:t1"), branch: "e2e-demo", pr: pr(2100) }),
        node("t-0013", "Vínculos de variantes", "t-0010", "worker", "ready-for-review", 9, { pr: pr(2097, { review: "APPROVED" }) }),
        node("t-0014", "Hotfix a producción", "t-0010", "worker", "ready-for-review", 14, { pr: pr(2095, { checks: { passed: 4, pending: 0, failed: 2 }, failing: ["e2e"] }) }),
        node("t-0015", "Borrador de permisos", "t-0010", "worker", "working", 21, { pr: pr(2093, { draft: true, state: "DRAFT" }) }),
        node("t-0016", "Precios por volumen", "root", "worker", "waiting-on-you", 26),
        ...today.map(([title, group], index) => node(`t-01${String(index).padStart(2, "0")}`, title, "t-0010", "worker", group, 30 + index * 25)),
      ],
    }, {
      slug: "docs-site", name: "Docs site", goal: "Guías y la referencia de la API", status: "active",
      threads: [
        node("t-0201", "Coordinador de docs", "root", "coordinator", "idle", 2 * DAY),
        node("t-0202", "Páginas de la API", "t-0201", "worker", "ready-for-review", 2 * DAY + 3 * HOUR),
        node("t-0203", "Guía de instalación", "t-0201", "worker", "idle", 4 * DAY),
        node("t-0204", "Ejemplos en Python", "t-0201", "worker", "idle", 11 * DAY),
        node("t-0205", "Guías viejas", "root", "worker", "resolved", 20 * DAY),
      ],
    }, {
      slug: "billing-api", name: "Billing API", goal: "Facturas, planes y webhooks", status: "paused",
      threads: [
        node("t-0301", "Exportar facturas", "root", "worker", "idle", 45 * DAY),
        node("t-0302", "Planes anuales", "root", "worker", "resolved", 60 * DAY),
      ],
    }],
  };
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const shots: string[] = [];
  const failures: string[] = [];
  const seen: Record<string, unknown> = {};
  const bridge = await startTestBridge({ port, fake: true, epoch: EPOCH, org: (herd, now) => seed(herd, now) });
  let browser: Browser | null = null;
  try {
    browser = await launchChrome();
    const open = async (device: Record<string, unknown>, scheme: "dark" | "light" = "dark") => {
      const context = await browser!.newContext({ ...device, colorScheme: scheme, timezoneId: "America/Argentina/Buenos_Aires", locale: "en-US" });
      const page = await context.newPage();
      await page.clock.install({ time: bridge.now() });
      await page.goto(bridge.url + "/");
      await page.locator('[role="tab"]:has-text("Recents")').first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1500);
      return { page, context };
    };
    const shoot = async (page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }) => {
      const path = join(outDir, `${tag}-${name}.png`);
      await page.screenshot({ path, animations: clip ? "allow" : "disabled", ...(clip ? { clip } : {}) });
      shots.push(path);
    };
    /** Period headings in the desk's chats, and how many rows each holds on screen. */
    const periods = (page: Page) => page.locator("section[aria-label=Chats] section").evaluateAll((groups) => groups.map((group) => {
      const box = group.getBoundingClientRect();
      const rows = Array.from(group.querySelectorAll("a.nav-row")).filter((row) => row.getBoundingClientRect().height > 4 && !row.closest("[inert]"));
      return { label: group.getAttribute("aria-label"), visible: box.height > 4 && !group.closest("[inert]"), rows: rows.length };
    }));

    for (const scheme of ["dark", "light"] as const) {
      const { page, context } = await open(DESKTOP, scheme);
      await shoot(page, `home-1440-${scheme}`);
      if (scheme === "dark") {
        const nav = page.getByRole("navigation", { name: "Projects and chats" });
        const box = (await nav.boundingBox())!;
        const sidebar = { x: box.x, y: box.y, width: box.width, height: box.height };
        await shoot(page, "sidebar-1440-folded", sidebar);
        const folded = await periods(page);
        seen.foldedPeriods = folded;
        for (const group of folded) if (group.visible && group.rows === 0) failures.push(`folded: "${group.label}" is drawn with no chat under it`);
        const more = nav.locator("section[aria-label=Chats] button[aria-expanded]").last();
        seen.moreLabel = await more.innerText();
        await more.click();
        await page.waitForTimeout(90);
        await shoot(page, "sidebar-1440-unfolding", sidebar);
        seen.animationsWhileUnfolding = await page.evaluate(() => document.getAnimations().length, null);
        await page.waitForTimeout(600);
        await nav.locator(".nav-scroll").evaluate((scroller) => { scroller.scrollTop = scroller.scrollHeight; });
        await page.waitForTimeout(200);
        await shoot(page, "sidebar-1440-unfolded", sidebar);
        const unfolded = await periods(page);
        seen.unfoldedPeriods = unfolded;
        for (const group of unfolded) if (group.visible && group.rows === 0) failures.push(`unfolded: "${group.label}" is drawn with no chat under it`);
        seen.lessLabel = await more.innerText();
        // Folding back runs the same motion the other way: a frame mid-way, then the bar as it was.
        await more.click();
        await page.waitForTimeout(90);
        await shoot(page, "sidebar-1440-folding", sidebar);
        await page.waitForTimeout(600);
        seen.refoldedPeriods = await periods(page);
        await more.click();
        await page.waitForTimeout(600);
        // Hover and keyboard focus on a chat, the way a mouse and Tab reach it.
        await nav.locator("section[aria-label=Chats] a.nav-row").nth(2).hover();
        await page.waitForTimeout(200);
        await shoot(page, "sidebar-1440-hover", { ...sidebar, height: Math.min(sidebar.height, 560) });
      }
      await context.close();
    }
    {
      const { page, context } = await open(PHONE);
      await shoot(page, "home-390");
      // Every word of a project's row fits a phone: a count cut to "11 worki…" reads as nothing.
      seen.cutAt390 = await page.locator("section[aria-labelledby=home-projects] .truncate").evaluateAll((spans) =>
        spans.filter((span) => span.scrollWidth > span.clientWidth + 1).map((span) => span.textContent));
      for (const text of seen.cutAt390 as string[]) failures.push(`390: "${text}" is cut`);
      await page.evaluate(() => window.scrollTo(0, 0), null);
      const tall = await browser.newContext({ ...PHONE, viewport: { width: 390, height: 1700 }, colorScheme: "dark", timezoneId: "America/Argentina/Buenos_Aires", locale: "en-US" });
      const full = await tall.newPage();
      await full.clock.install({ time: bridge.now() });
      await full.goto(bridge.url + "/");
      await full.locator('[role="tab"]:has-text("Recents")').first().waitFor({ timeout: 15_000 });
      await full.waitForTimeout(1500);
      await shoot(full, "home-390-full");
      await tall.close();
      await context.close();
    }
    {
      const context = await browser.newContext({ ...DESKTOP, viewport: { width: 1440, height: 1500 }, colorScheme: "dark", timezoneId: "America/Argentina/Buenos_Aires", locale: "en-US" });
      const page = await context.newPage();
      await page.clock.install({ time: bridge.now() });
      await page.goto(bridge.url + "/");
      await page.locator('[role="tab"]:has-text("Recents")').first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1500);
      await shoot(page, "home-1440-full");
      seen.homeText = (await page.locator("main").innerText()).split("\n").slice(0, 40);
      await context.close();
    }
  } finally {
    await browser?.close();
    await bridge.stop();
  }
  const result = { tag, shots, seen, failures };
  await writeFile(join(outDir, `${tag}-home-projects.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) await main();
