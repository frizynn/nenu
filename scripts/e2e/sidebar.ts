import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DESKTOP, launchChrome, PHONE, userCacheDir, type Browser } from "./browser.ts";
import { startTestBridge } from "./bridge.ts";
import { deskOrg, type OrgSeed } from "./scenario.ts";

// The desk's bar at every width the grip allows, and the phone's drawer: no list scrolls sideways, every
// row ends inside the bar, a long name ends in an ellipsis, a resting chat reads muted until the pointer
// rests on it, and the chats' "N updates" sits at the bar's
// own edge. A chat with a name wider than the bar stands in for the one that pushed the list sideways
// (21/10: the projects read "M" and "r Org" and "8 updates" floated past the rows). Captures each width
// and the drawer in dark and light, with Home and a project's page at the default width. Exits 1 on any failure.
//
//   bun scripts/e2e/sidebar.ts [--port 8877] [--out DIR] [--tag before|after]

const { values } = parseArgs({ options: { port: { type: "string", default: "8877" }, out: { type: "string" }, tag: { type: "string", default: "now" } } });
const port = Number(values.port);
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), `sidebar-${Date.now()}`);
const EPOCH = Date.parse("2026-10-21T15:00:00Z");
const LONG = "Fisgón: la IA se apaga y prende sola en la charla de prueba cuando el cliente vuelve a la conversación";
const WIDTHS = [220, 272, 420];

function seed(herd: Parameters<typeof deskOrg>[0], now: number): OrgSeed {
  const org = deskOrg(herd, now, { additions: 12, deletions: 3 });
  const thread = org.projects[0]!.threads.find((t) => t.id === "t-0014")!;
  org.projects[0]!.threads.push({ ...thread, id: "t-0090", title: LONG, pane_id: "", workspace_id: "", tab_id: "", updated: new Date(now - 90_000).toISOString() });
  return org;
}

/** What breaks the bar's edge: a list wider than its scroller, a row past it, a long name without its ellipsis. */
function measure(desk: boolean) {
  const broken: string[] = [];
  const scrollers = Array.from(document.querySelectorAll<HTMLElement>(".nav-scroll")).filter((el) => el.getClientRects().length);
  for (const scroller of scrollers) {
    if (scroller.scrollWidth > scroller.clientWidth) broken.push(`list ${scroller.scrollWidth}px wide in a ${scroller.clientWidth}px bar`);
    scroller.scrollLeft = 400;
    if (scroller.scrollLeft !== 0) broken.push(`list scrolls ${scroller.scrollLeft}px sideways`);
    scroller.scrollLeft = 0;
    const edge = scroller.getBoundingClientRect().right;
    for (const el of Array.from(scroller.querySelectorAll<HTMLElement>(".nav-row, .nav-label"))) {
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      if (box.right > edge + 0.5) broken.push(`"${el.textContent?.trim().slice(0, 30)}" ends ${Math.round(box.right - edge)}px past the bar`);
    }
    const long = Array.from(scroller.querySelectorAll<HTMLElement>(".nav-row-text")).find((el) => el.textContent?.startsWith("Fisgón"));
    if (!long) { if (desk) broken.push("the long name is not in the list"); }
    else if (long.scrollWidth <= long.clientWidth) broken.push("the long name shows whole, so nothing cut it to the bar");
  }
  if (!scrollers.length) broken.push("no list on screen");
  return broken;
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const failures: string[] = [];
  const shots: string[] = [];
  const bridge = await startTestBridge({ port, fake: true, epoch: EPOCH, org: seed });
  let browser: Browser | null = null;
  try {
    browser = await launchChrome();
    for (const scheme of ["dark", "light"] as const) {
      for (const width of WIDTHS) {
        const context = await browser.newContext({ ...DESKTOP, colorScheme: scheme, timezoneId: "UTC", locale: "en-US" });
        const page = await context.newPage();
        await page.clock.install({ time: bridge.now() });
        await page.addInitScript((w) => localStorage.setItem("nenu:sidebar-width:v1", String(w)), width);
        await page.goto(bridge.url + "/");
        await page.locator(".workbench-sidebar .nav-chats .nav-row >> visible=true").first().waitFor({ timeout: 30_000 });
        await page.waitForTimeout(600);
        for (const line of await page.evaluate(measure, true)) failures.push(`desk ${width}px ${scheme}: ${line}`);
        // A resting chat steps back to the muted ink, and the pointer brings the full ink back.
        const ink = (selector: string) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).color);
        const resting = ".nav-chats .nav-row:not([data-live], [aria-current]) >> visible=true";
        const [live, quiet] = [await ink(".nav-chats .nav-row[data-live] >> visible=true"), await ink(resting)];
        if (live === quiet) failures.push(`desk ${width}px ${scheme}: a resting chat reads in the live ink (${quiet})`);
        await page.locator(resting).first().hover();
        await page.waitForTimeout(300);
        const hovered = await ink(".nav-chats .nav-row:not([data-live], [aria-current]):hover");
        if (hovered !== live) failures.push(`desk ${width}px ${scheme}: the pointer leaves a resting chat at ${hovered}, not ${live}`);
        await page.mouse.move(1439, 899);
        const name = `${values.tag}-desk-${width}-${scheme}.png`;
        await page.screenshot({ path: join(outDir, name), clip: { x: 0, y: 0, width: Math.max(width, 440), height: 900 }, animations: "disabled" });
        shots.push(name);
        // The bar as a sideways swipe leaves it, where the list can scroll that way at all.
        if (width === WIDTHS[2]) {
          await page.evaluate(() => { for (const el of Array.from(document.querySelectorAll(".nav-scroll"))) el.scrollLeft = 80; }, null);
          const swiped = `${values.tag}-desk-${width}-swiped-${scheme}.png`;
          await page.screenshot({ path: join(outDir, swiped), clip: { x: 0, y: 0, width, height: 900 }, animations: "disabled" });
          shots.push(swiped);
        }
        if (width === WIDTHS[1]) {
          const full = `${values.tag}-desk-full-${scheme}.png`;
          await page.screenshot({ path: join(outDir, full), animations: "disabled" });
          shots.push(full);
          await page.goto(bridge.url + "/project/acme-shop");
          await page.locator("main >> visible=true").first().waitFor({ timeout: 30_000 });
          await page.waitForTimeout(600);
          const project = `${values.tag}-desk-project-${scheme}.png`;
          await page.screenshot({ path: join(outDir, project), animations: "disabled" });
          shots.push(project);
        }
        await context.close();
      }
      const context = await browser.newContext({ ...PHONE, colorScheme: scheme, timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      await page.clock.install({ time: bridge.now() });
      await page.goto(bridge.url + "/");
      await page.getByRole("button", { name: "Open navigation" }).first().click({ timeout: 30_000 });
      await page.locator(".nav-scroll .nav-row >> visible=true").first().waitFor({ timeout: 30_000 });
      await page.waitForTimeout(600);
      for (const line of await page.evaluate(measure, false)) failures.push(`drawer ${scheme}: ${line}`);
      const name = `${values.tag}-drawer-${scheme}.png`;
      await page.screenshot({ path: join(outDir, name), animations: "disabled" });
      shots.push(name);
      await context.close();
    }
  } finally {
    await browser?.close();
    await bridge.stop();
  }
  await writeFile(join(outDir, `${values.tag}-result.json`), JSON.stringify({ failures, shots }, null, 2));
  console.log(JSON.stringify({ out: outDir, shots: shots.length, failures }, null, 2));
  if (failures.length) process.exitCode = 1;
}

await main();
