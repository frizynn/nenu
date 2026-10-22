import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DESKTOP, launchChrome, PHONE, userCacheDir, type Browser, type Page } from "./browser.ts";
import { startTestBridge } from "./bridge.ts";
import { herdSeed } from "./scenario.ts";

// How a phone reaches a coordinator, over projects shaped like the operator's on 2026-10-21: one
// whose running project coordinator organizes open coordinators (one nested), one whose running
// coordinator only has workers, and a quiet one. Walks Home, the drawer, the project and each
// coordinator at 390x844, counting taps from Home (2, a nested one too: it is its own row) and from
// the drawer (3), landing on its chat where it runs and on its page where it does not (ADR 0115), and
// captures every screen, plus Home at 1440. A coordinator's chat holds its views in the ⋯ and draws
// none under its title; an open view draws them as a 32px switch (ADR 0121). Exits 1 on any failure.
//
//   bun scripts/e2e/phone-nav.ts [--port 8871] [--out DIR] [--tag before|after]

const { values } = parseArgs({ options: { port: { type: "string", default: "8871" }, out: { type: "string" }, tag: { type: "string", default: "now" } } });
const port = Number(values.port);
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), `phone-nav-${Date.now()}`);
const tag = values.tag;
const EPOCH = Date.parse("2026-10-21T03:30:00Z");

interface Step { at: string; path: string; taps: number }

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const shots: string[] = [];
  const failures: string[] = [];
  const seen: Record<string, unknown> = {};
  const bridge = await startTestBridge({ port, fake: true, epoch: EPOCH, org: herdSeed });
  let browser: Browser | null = null;
  try {
    browser = await launchChrome();
    const open = async (device: Record<string, unknown>, path = "/", height?: number) => {
      const context = await browser!.newContext({ ...device, ...(height ? { viewport: { width: (device.viewport as { width: number }).width, height } } : {}),
        timezoneId: "America/Argentina/Buenos_Aires", locale: "en-US" });
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
    const text = async (page: Page) => (await page.locator("main").first().innerText().catch(() => "")).split("\n").filter(Boolean).slice(0, 60);

    for (const [name, device, height] of [["390", PHONE, undefined], ["390-full", PHONE, 2200], ["1440", DESKTOP, undefined]] as const) {
      const { page, context } = await open(device, "/", height);
      await shoot(page, `home-${name}`);
      if (name === "390") seen.homeText = await text(page);
      await context.close();
    }

    // The drawer, as ☰ opens it.
    {
      const { page, context } = await open(PHONE);
      await page.getByRole("button", { name: "Open navigation" }).first().click().catch(() => failures.push("no ☰ on Home"));
      await page.waitForTimeout(800);
      await shoot(page, "drawer-390");
      seen.drawerText = (await page.locator("[role=dialog]").first().innerText().catch(() => "")).split("\n").filter(Boolean).slice(0, 60);
      await context.close();
    }

    // Each coordinator, reached from Home and from the drawer: where each tap lands, and how many it took.
    // One that runs is reached on its chat; one that does not, on its page (/project/<slug>/node/<id>).
    const walks: Record<string, Step[]> = {};
    // The project, its coordinator's row (empty where the project opens on its own coordinator's chat),
    // the rows a person taps on the way (none: a nested coordinator is its own row on the project), and
    // where it lands.
    const targets: ReadonlyArray<readonly [string, string, string, readonly string[], string]> = [
      ["acme", "Acme Shop", "Project coordinator", [], "/pane/w2%3Acodex"], ["acme", "Acme Shop", "Migración de stock", [], "/project/acme/node/t-0101"],
      ["acme", "Acme Shop", "Rediseño mobile", [], "/pane/w1%3Aidle"], ["acme", "Acme Shop", "Checkout", [], "/project/acme/node/t-0105"], ["nenu", "Nenu", "", [], "/pane/w1%3Aworking"],
    ];
    const reached = (path: string, landing: string) => path.split("?")[0] === landing;
    for (const [slug, project, coordinator, through, node] of targets) {
      const name = coordinator || `${project} coordinator`;
      const steps: Step[] = [];
      // From Home: its Projects tab, the project's row, then the coordinator's row.
      {
        const { page, context } = await open(PHONE);
        let taps = 0;
        const tab = page.getByRole("tab", { name: "Projects" });
        if (await tab.count() && (await tab.first().getAttribute("aria-selected")) !== "true") { await tab.first().click(); taps++; await page.waitForTimeout(500); }
        const row = page.locator("[role=tabpanel] a, section[aria-labelledby=home-projects] a").filter({ hasText: project }).first();
        if (await row.count()) { await row.click(); taps++; await page.waitForTimeout(2500); }
        steps.push({ at: "home → project", path: here(page), taps });
        for (const title of coordinator ? [...through, coordinator] : []) {
          const entry = page.locator(".desk-card-open", { hasText: title }).first();
          if (await entry.count()) { await entry.click(); taps++; await page.waitForTimeout(2500); }
          steps.push({ at: `home → ${title}`, path: here(page), taps });
        }
        if (!reached(here(page), node) || taps > 2 + through.length) failures.push(`home: ${name} took ${taps} taps and landed on ${here(page)}`);
        await shoot(page, `reach-${slug}-${(coordinator || "own").split(" ")[0]!.toLowerCase()}-home-390`);
        await context.close();
      }
      // From the drawer: ☰, unfold the project, the coordinator's row. A nested one is reached from its
      // parent's page, measured above; the drawer's walk is recorded as skipped.
      if (through.length > 0) steps.push({ at: "drawer: skip, nested", path: "", taps: 0 });
      else {
        const { page, context } = await open(PHONE);
        let taps = 0;
        await page.getByRole("button", { name: "Open navigation" }).first().click(); taps++;
        await page.waitForTimeout(800);
        const drawer = page.getByRole("navigation", { name: "Projects and chats" });
        const unfold = drawer.getByRole("button", { name: `${project} tasks` });
        if (await unfold.count() && (await unfold.first().getAttribute("aria-expanded")) !== "true") { await unfold.first().click(); taps++; await page.waitForTimeout(500); }
        const label = coordinator === "Project coordinator" || !coordinator ? "Coordinator" : coordinator;
        await shoot(page, `drawer-${slug}-390`);
        const link = drawer.locator(`section[aria-label="${project}"] a`).filter({ hasText: new RegExp(`^${label}`) }).first();
        if (await link.count()) { await link.click(); taps++; await page.waitForTimeout(2500); }
        steps.push({ at: `drawer → ${name}`, path: here(page), taps });
        if (!reached(here(page), node) || taps > 3) failures.push(`drawer: ${name} took ${taps} taps and landed on ${here(page)}`);
        await context.close();
      }
      walks[name] = steps;
    }
    // The project, a coordinator's chat and the page of one that does not run, as a phone draws them.
    for (const [name, path] of [["project-acme", "/project/acme"], ["coordinator-root", "/project/acme/node/root"], ["coordinator-migracion", "/project/acme/node/t-0101"],
      ["coordinator-rediseno", "/pane/w1%3Aidle?view=status"]] as const) {
      const { page, context } = await open(PHONE, path);
      await shoot(page, `${name}-390`);
      seen[`${name}Text`] = await text(page);
      if (path.startsWith("/pane/")) {
        const chrome = await page.locator("[data-chat-chrome] [role=tablist][aria-label='Project']").count();
        const open = await page.locator("[role=tablist][aria-label='Project']").first().boundingBox().catch(() => null);
        seen[`${name}Views`] = { inChrome: chrome, switchPx: open && Math.round(open.height) };
        if (chrome > 0) failures.push(`${name}: the chat draws its views under its title`);
        if (path.includes("view=") && (!open || open.height > 32)) failures.push(`${name}: the open view's switch is ${open ? Math.round(open.height) : "missing"}px`);
        // What a finger reaches on its Chat: the px down the tab's centre that land on it (44 on a coarse pointer).
        const reach = await page.evaluate(() => {
          const tab = document.querySelector<HTMLElement>("[role=tablist][aria-label='Project'] [role=tab]");
          if (!tab) return 0;
          const box = tab.getBoundingClientRect();
          let px = 0;
          for (let y = Math.floor(box.top) - 12; y <= box.bottom + 12; y++) if (document.elementFromPoint(box.left + box.width / 2, y)?.closest("[role=tab]") === tab) px++;
          return px;
        }, null);
        seen[`${name}Views`] = { ...(seen[`${name}Views`] as object), chatTargetPx: reach };
        if (path.includes("view=") && reach < 44) failures.push(`${name}: the open view's Chat takes a finger over ${reach}px`);
      }
      await context.close();
    }
    seen.walks = walks;
  } finally {
    await browser?.close();
    await bridge.stop();
  }
  const result = { tag, shots, seen, failures };
  await writeFile(join(outDir, `${tag}-phone-nav.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (failures.length) process.exit(1);
}

if (import.meta.main) await main();
