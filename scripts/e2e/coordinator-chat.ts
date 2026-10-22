import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DESKTOP, launchChrome, PHONE, userCacheDir, type Browser, type Page } from "./browser.ts";
import { startTestBridge } from "./bridge.ts";
import { herdSeed } from "./scenario.ts";

// How many taps it takes to write to a coordinator, from Home, at 390 and 1440 px (ADR 0115): Home's
// Projects tab, the project's row, the coordinator's row, and whatever else stands before its chat's box.
// Then the back control from that chat, as far as it climbs (coordinator → project → Projects). Over
// phone-nav.ts's herd: Acme organizes coordinators (its own and Rediseño mobile run in a pane,
// Migración de stock does not), and Nenu runs only its own coordinator. Captures each screen.
// On a phone its views are the ⋯'s rows (ADR 0121): nothing stands between the title and the chat, each
// view is 2 taps from it (⋯, the row) and Chat 1 tap back, and what waits on you is counted on the ⋯.
// Exits 1 when a running coordinator takes more than 2 taps or its chat has no back to its project, or
// when a phone's chat draws a band of views, a view takes more taps, or Acme's waiting ask is not on its ⋯.
//
//   bun scripts/e2e/coordinator-chat.ts [--port 8874] [--out DIR] [--tag before|after] [--loose]
//
// --loose records without failing, to measure a build that predates the model.

const { values } = parseArgs({ options: { port: { type: "string", default: "8874" }, out: { type: "string" }, tag: { type: "string", default: "now" }, loose: { type: "boolean" } } });
const port = Number(values.port);
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), `coordinator-chat-${Date.now()}`);
const tag = values.tag;
const EPOCH = Date.parse("2026-10-21T03:30:00Z");

/** Project, its name on Home, the coordinator's row (empty for a project that opens on its own), and whether it runs in a pane. */
const TARGETS = [
  ["acme", "Acme Shop", "Project coordinator", true],
  ["acme", "Acme Shop", "Rediseño mobile", true],
  ["acme", "Acme Shop", "Migración de stock", false],
  ["nenu", "Nenu", "Project coordinator", true],
] as const;

interface Walk { device: string; coordinator: string; taps: number; path: string; composer: boolean; menu: string | null; band: number; steps: string[]; back: string[] }
interface View { view: string; taps: number; overlayTop: number | null; backToChat: number; composer: boolean }

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const shots: string[] = [];
  const failures: string[] = [];
  const walks: Walk[] = [];
  const views: View[] = [];
  const bridge = await startTestBridge({ port, fake: true, epoch: EPOCH, org: herdSeed });
  let browser: Browser | null = null;
  try {
    browser = await launchChrome();
    const open = async (device: Record<string, unknown>, path = "/") => {
      const context = await browser!.newContext({ ...device, timezoneId: "America/Argentina/Buenos_Aires", locale: "en-US" });
      const page = await context.newPage();
      await page.clock.install({ time: bridge.now() });
      await page.goto(bridge.url + path);
      await page.waitForTimeout(2500);
      return { page, context };
    };
    const shoot = async (page: Page, name: string) => {
      const path = join(outDir, `${tag}-${name}.png`);
      await page.screenshot({ path, animations: "disabled" });
      shots.push(path);
    };
    const here = (page: Page) => { const url = new URL(page.url()); return url.pathname + url.search; };
    const settle = (page: Page) => page.waitForTimeout(2000);
    const composer = (page: Page) => page.getByPlaceholder(/Ask the coordinator/).first().isVisible().catch(() => false);

    for (const [device, size] of [[PHONE, "390"], [DESKTOP, "1440"]] as const) {
      for (const [slug, project, title, live] of TARGETS) {
        const { page, context } = await open(device);
        const steps: string[] = [];
        let taps = 0;
        const tap = async (what: string, run: () => Promise<void>) => { await run(); taps++; await settle(page); steps.push(`${what} → ${here(page)}`); };
        const tab = page.getByRole("tab", { name: "Projects" });
        if (await tab.count() && (await tab.first().getAttribute("aria-selected")) !== "true") await tap("Projects tab", () => tab.first().click());
        const row = page.locator("[role=tabpanel] a").filter({ hasText: project }).first();
        if (await row.count()) await tap(project, () => row.click());
        // A project that opens on its own coordinator's chat is already there.
        if (!here(page).startsWith("/pane/")) {
          const entry = page.locator(".coord-open, .task-main").filter({ hasText: title }).first();
          if (await entry.count()) await tap(title, () => entry.click());
        }
        // The page in between, where there is one: its Open chat.
        if (!here(page).startsWith("/pane/")) {
          const chat = page.getByRole("button", { name: /^Open chat$/ }).first();
          if (await chat.count() && await chat.isVisible()) await tap("Open chat", () => chat.click());
        }
        const menu = page.getByRole("button", { name: /^Conversation actions/ }).first();
        const walk: Walk = { device: size, coordinator: `${project} · ${title}`, taps, path: here(page), composer: await composer(page),
          menu: await menu.count() ? await menu.getAttribute("aria-label") : null, band: await bandHeight(page), steps, back: [] };
        const name = `${slug}-${title.split(" ")[0]!.toLowerCase()}-${size}`;
        await shoot(page, `reach-${name}`);
        // The back control, climbing: the chat's parent, then the project's.
        for (let n = 0; n < 2; n++) {
          const back = page.locator('header [aria-label^="Back to"]').first();
          if (!(await back.count()) || !(await back.isVisible())) { walk.back.push("no back control"); break; }
          const label = await back.getAttribute("aria-label");
          await back.click();
          await settle(page);
          walk.back.push(`${label} → ${here(page)}`);
        }
        walks.push(walk);
        if (live && (!walk.composer || taps > 2)) failures.push(`${size}: ${walk.coordinator} took ${taps} taps, composer ${walk.composer}, at ${walk.path}`);
        if (live && size === "390" && walk.band > 0) failures.push(`390: ${walk.coordinator}'s chat draws ${walk.band}px of views under its title`);
        // Acme's own coordinator holds the herd's one waiting ask.
        if (live && size === "390" && slug === "acme" && title === "Project coordinator" && !walk.menu?.includes("1 waiting on you")) failures.push(`390: ${walk.coordinator}'s ⋯ reads "${walk.menu}"`);
        // A phone's project that opens on its own coordinator's chat is that chat: its back goes Home.
        const up = size === "390" && taps === 1 ? "Back to Home" : `/project/${slug}`;
        if (live && !walk.back[0]?.includes(up)) failures.push(`${size}: ${walk.coordinator}'s back went ${walk.back[0]}`);
        await context.close();
      }
    }

    // What each screen draws: the project, a coordinator's chat with its panel or its phone tabs.
    for (const [device, size] of [[PHONE, "390"], [DESKTOP, "1440"]] as const) {
      const { page, context } = await open(device, "/project/acme");
      await shoot(page, `project-acme-${size}`);
      const fold = page.getByRole("button", { name: /^Show Rediseño mobile threads$/ }).first();
      if (await fold.count()) { await fold.click(); await page.waitForTimeout(600); await shoot(page, `project-acme-unfolded-${size}`); }
      const entry = page.locator(".coord-open, .task-main").filter({ hasText: "Rediseño mobile" }).first();
      if (await entry.count()) await entry.click();
      await settle(page);
      if (!here(page).startsWith("/pane/")) {
        const chat = page.getByRole("button", { name: /^Open chat$/ }).first();
        if (await chat.count()) { await chat.click(); await settle(page); }
      }
      await shoot(page, `chat-rediseno-${size}`);
      if (size === "390") {
        // Each view from the chat: the ⋯, its row; then the small switch's Chat, back to the box.
        for (const view of ["Threads", "PRs", "Status"]) {
          let taps = 0;
          await page.getByRole("button", { name: /^Conversation actions/ }).first().click(); taps++;
          await page.waitForTimeout(400);
          if (view === "Threads") await shoot(page, `chat-rediseno-menu-${size}`);
          await page.getByRole("dialog", { name: "Conversation actions" }).getByRole("button", { name: new RegExp(`^${view}`) }).click(); taps++;
          await page.waitForTimeout(800);
          await shoot(page, `chat-rediseno-${view.toLowerCase()}-${size}`);
          const overlay = await page.locator(".project-overlay").first().boundingBox();
          await page.getByRole("tablist", { name: "Project" }).getByRole("tab", { name: "Chat" }).click();
          await page.waitForTimeout(800);
          const entry: View = { view, taps, overlayTop: overlay && Math.round(overlay.y), backToChat: 1, composer: await composer(page) };
          views.push(entry);
          if (taps > 2 || overlay === null || !entry.composer) failures.push(`390: ${view} took ${taps} taps, overlay ${overlay ? "shown" : "missing"}, back to the box ${entry.composer}`);
        }
      }
      await context.close();
    }
  } finally {
    await browser?.close();
    await bridge.stop();
  }
  const result = { tag, walks, views, shots, failures };
  await writeFile(join(outDir, `${tag}-coordinator-chat.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ tag, walks, views, failures }, null, 2));
  if (failures.length && !values.loose) process.exit(1);
}

/** The px a chat's views take between its header and the next strip: 0 where the ⋯ holds them. */
async function bandHeight(page: Page): Promise<number> {
  const band = page.locator("[data-chat-chrome] [role=tablist][aria-label='Project']").first();
  const box = await band.count() ? await band.boundingBox() : null;
  return box ? Math.round(box.height) : 0;
}

if (import.meta.main) await main();
