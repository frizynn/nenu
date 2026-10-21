import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import type { FakeHerdr } from "../../bridge/test-support/fake-herdr.ts";
import { DESKTOP, launchChrome, PHONE, userCacheDir, type Browser, type Page } from "./browser.ts";
import { startTestBridge } from "./bridge.ts";
import { homeOrg, seedDemoHerd } from "./scenario.ts";

// What moves under a finger while a busy herd works, on the e2e bench with Google Chrome headless:
// a fleet of agents finishing one after another. On a phone, a tap on a thread's ‹ and on a sibling
// chip while they finish, whether they land at the first try; Escape on the Search sheet; Home left
// alone, counting the rows that move and the layout shifts. On a desk, the sidebar left alone, and the
// row a click opened, whether it stays under the pointer. Last, on each, an agent off screen starts
// asking for you: how long until it is on screen. Run it once per build to compare two.
//
//   bun scripts/e2e/calm.ts [--port 8796] [--out DIR] [--seconds 60] [--label after]

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8796" },
    out: { type: "string" },
    seconds: { type: "string", default: "60" },
    label: { type: "string", default: "run" },
  },
});
const port = Number(values.port);
const label = values.label!;
const quietMs = Number(values.seconds) * 1000;
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), `calm-${Date.now()}`);

const FLEET = Array.from({ length: 8 }, (_, i) => `w3:agent${i + 1}`);

/** One fleet agent starts and finishes every `everyMs`, in turn, until stopped. */
function churn(fake: FakeHerdr, everyMs = 1200): () => void {
  let next = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const tick = setInterval(() => {
    const pane = FLEET[next++ % FLEET.length]!;
    fake.setStatus(pane, "working");
    const done = setTimeout(() => { timers.delete(done); fake.setStatus(pane, "done"); }, everyMs / 2);
    timers.add(done);
  }, everyMs);
  return () => { clearInterval(tick); for (const timer of timers) clearTimeout(timer); };
}

/** Records every layout shift, as the audit did, from before the page's first paint. */
const LAYOUT_SHIFTS = () => {
  type Shift = PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: Array<{ node?: Node | null }> };
  const w = window as unknown as { __shifts: Array<{ value: number; sources: string[] }> };
  w.__shifts = [];
  const describe = (node?: Node | null) => !node ? "?" : node instanceof Element
    ? `${node.tagName.toLowerCase()}${typeof node.className === "string" && node.className ? "." + node.className.split(/\s+/).slice(0, 3).join(".") : ""} «${(node.textContent ?? "").trim().slice(0, 30)}»`
    : `#text «${(node.textContent ?? "").trim().slice(0, 30)}»`;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Shift[]) {
        if (!entry.hadRecentInput) w.__shifts.push({ value: entry.value, sources: (entry.sources ?? []).map((source) => describe(source.node)) });
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch { /* no layout-shift entries in this engine */ }
};

/**
 * Leaves the page alone for `ms` and samples where the rows `selector` matches sit, every 250 ms: how
 * many times a row already on screen moved, and the layout shifts in that window.
 */
async function quiet(page: Page, selector: string, ms: number): Promise<{ rows: number; moves: number; maxMovePx: number; layoutShifts: number; cls: number; shiftSources: Record<string, number> }> {
  await page.evaluate(() => { (window as unknown as { __shifts: unknown[] }).__shifts = []; }, null);
  const read = () => page.evaluate((sel: string): Record<string, number> => Object.fromEntries(Array.from(document.querySelectorAll(sel),
    (el) => [el.getAttribute("href") ?? el.textContent ?? "", Math.round(el.getBoundingClientRect().top)])), selector);
  let last: Record<string, number> = await read();
  const rows = Object.keys(last).length;
  let moves = 0;
  let maxMovePx = 0;
  for (const end = Date.now() + ms; Date.now() < end;) {
    await page.waitForTimeout(250);
    const now = await read();
    for (const [key, top] of Object.entries(now)) {
      const before = last[key];
      if (before === undefined || before === top) continue;
      moves++;
      maxMovePx = Math.max(maxMovePx, Math.abs(top - before));
    }
    last = now;
  }
  const shifts = await page.evaluate(() => (window as unknown as { __shifts: Array<{ value: number; sources: string[] }> }).__shifts, null);
  const shiftSources: Record<string, number> = {};
  for (const source of shifts.flatMap((shift) => shift.sources)) shiftSources[source] = (shiftSources[source] ?? 0) + 1;
  return { rows, moves, maxMovePx, layoutShifts: shifts.length, cls: Number(shifts.reduce((a, b) => a + b.value, 0).toFixed(4)), shiftSources };
}

/** A finger on the centre of `selector`'s first match: lands wherever it lands, as a tap does. */
async function tap(page: Page, selector: string): Promise<string | null> {
  const box = await page.locator(selector).first().boundingBox({ timeout: 5000 });
  if (!box) return null;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  // What the finger touches first, the toast or the control.
  const hit = await page.evaluate(([px, py]) => {
    const el = document.elementFromPoint(px!, py!);
    return el?.closest("[data-notification-viewport]") ? "notification" : el?.closest("a,button")?.getAttribute("aria-label") ?? el?.textContent?.trim().slice(0, 40) ?? null;
  }, [x, y]);
  await page.touchscreen.tap(x, y);
  return hit;
}

/**
 * The first fleet agent with no row on screen starts asking for you: how many ms until a link to it is
 * inside the viewport (null: not within 5 s). Nothing on screen may move to show it, which `quiet` counts.
 */
async function needsYouOffScreen(page: Page, fake: FakeHerdr, selector: string): Promise<{ paneId: string; visibleMs: number | null }> {
  const onScreen = (sel: string) => page.evaluate((s: string) => Array.from(document.querySelectorAll(s), (el) => {
    const box = el.getBoundingClientRect();
    return box.height > 0 && box.top >= 0 && box.bottom <= window.innerHeight ? el.getAttribute("href") ?? "" : "";
  }).filter(Boolean), sel);
  const shown = await onScreen(selector);
  const paneId = FLEET.find((id) => !shown.some((href) => href.startsWith(`/pane/${encodeURIComponent(id)}`))) ?? FLEET[0]!;
  const href = `/pane/${encodeURIComponent(paneId)}`;
  fake.setStatus(paneId, "blocked");
  const t0 = Date.now();
  while (Date.now() - t0 < 5000) {
    if ((await onScreen(`a[href^="${href}"]`)).length) return { paneId, visibleMs: Date.now() - t0 };
    await page.waitForTimeout(100);
  }
  return { paneId, visibleMs: null };
}

const toastShown = (page: Page) => page.locator("[data-notification-viewport] [role=status], [data-notification-viewport] [role=alert]").count();

async function run(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const bridge = await startTestBridge({
    port, fake: true, org: (herd, now) => homeOrg(herd, now, { additions: 64, deletions: 12 }),
    seed: async (fake, ctx) => {
      const herd = await seedDemoHerd(fake, ctx);
      fake.addWorkspace("w3", "fleet").addTab("w3:t1", "agents");
      for (const [i, paneId] of FLEET.entries()) {
        fake.addPane({ paneId, workspaceId: "w3", tabId: "w3:t1", agent: "claude", label: `Fleet agent ${i + 1}`, cwd: ctx.cwd, lines: ["❯ Demo task", "", "● On it."] });
      }
      return herd;
    },
  });
  const herd = bridge.herd!;
  const fake = bridge.fake!;
  let browser: Browser | null = null;
  const out: Record<string, unknown> = { label, quietSeconds: quietMs / 1000 };
  const shoot = (page: Page, name: string) => page.screenshot({ path: join(outDir, `${label}-${name}.png`) });
  try {
    browser = await launchChrome();
    const context = await browser.newContext({ ...PHONE, timezoneId: "UTC", locale: "en-US" });
    const page = await context.newPage();
    await page.addInitScript(LAYOUT_SHIFTS, null);
    const chat = `/pane/${encodeURIComponent(herd.working)}`;
    let stop = churn(fake);
    try {
      // A thread in a project: its ‹ goes up, and its views switch beside it (sibling chips before 1.23.0,
      // Chat · Threads · PRs under the header since, the ⋯'s rows since 1.42.0, its toast-prone corner).
      const taps: Array<Record<string, unknown>> = [];
      const views = 'header button[aria-label^="Conversation actions"]';
      for (const [name, selector] of [["back", 'header a[aria-label^="Back to"]'], ["chip", views]] as const) {
        await page.goto(bridge.url + chat);
        await page.locator("textarea").first().waitFor({ timeout: 15_000 });
        // Wait for the fleet to be finishing, so a phone that raises a toast has one up.
        await page.waitForTimeout(3500);
        const toasts = await toastShown(page);
        if (name === "back") await shoot(page, "phone-chat-while-agents-finish");
        const hit = await tap(page, selector);
        // The ⋯ opens its menu; the view is its Threads row.
        if (selector === views && hit !== "notification") { await page.waitForTimeout(400); await tap(page, '[role="dialog"][aria-label="Conversation actions"] button:has-text("Threads")'); }
        await page.waitForTimeout(1200);
        // A tab of the thread's band switches in place, and since 1.23.0 it says so in the query.
        const landed = new URL(page.url()).pathname + new URL(page.url()).search;
        taps.push({ name, toastUp: toasts > 0, touched: hit, landed, firstTry: landed !== chat && hit !== "notification" });
      }
      out.phoneTaps = taps;

      await page.goto(bridge.url + "/");
      await page.locator('[role="tab"]:has-text("Recents")').first().waitFor({ timeout: 15_000 });
      await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Search" }).click();
      await page.waitForTimeout(600);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(600);
      out.searchOpenAfterEscape = await page.getByRole("dialog", { name: "Search" }).count() > 0;
      await shoot(page, "phone-search-after-escape");
      if (out.searchOpenAfterEscape) await page.getByRole("dialog", { name: "Search" }).getByRole("button", { name: "Close" }).click();

      await page.goto(bridge.url + "/");
      await page.locator('[role="tab"]:has-text("Recents")').first().waitFor({ timeout: 15_000 });
      // Home opens on Projects (ADR 0110); the sessions this measures are Recents'.
      await page.getByRole("tab", { name: "Recents" }).first().click();
      await page.waitForTimeout(1500);
      out.phoneHomeQuiet = await quiet(page, '#home-list a[href^="/pane/"]', quietMs);
      await shoot(page, "phone-home");
      stop();
      out.phoneNeedsYouOffScreen = await needsYouOffScreen(page, fake, '#home-list a[href^="/pane/"]');
      await shoot(page, "phone-home-needs-you");
      stop = churn(fake);
      await context.close();

      const desk = await browser.newContext({ ...DESKTOP, timezoneId: "UTC", locale: "en-US" });
      const deskPage = await desk.newPage();
      await deskPage.addInitScript(LAYOUT_SHIFTS, null);
      await deskPage.goto(bridge.url + `/pane/${encodeURIComponent(herd.codex)}`);
      await deskPage.locator(".nav-desk a.nav-row").first().waitFor({ timeout: 15_000 });
      await deskPage.waitForTimeout(1500);
      out.deskSidebarQuiet = await quiet(deskPage, ".nav-chats a.nav-row", quietMs);
      // A click on a fleet chat's row: does that row stay under the pointer once its chat opens?
      const row = deskPage.locator('.nav-chats a.nav-row:has-text("Fleet agent 3")').first();
      const before = (await row.boundingBox())?.y ?? null;
      await row.click();
      await deskPage.waitForTimeout(1500);
      const after = (await row.boundingBox())?.y ?? null;
      out.deskClickedRow = { before, after, movedPx: before !== null && after !== null ? Math.round(Math.abs(after - before)) : null };
      await shoot(deskPage, "desk-sidebar");
      // The phone's agent asks still; the next one off the bar's screen asks too.
      stop();
      out.deskNeedsYouOffScreen = await needsYouOffScreen(deskPage, fake, ".nav-chats a.nav-row");
      await shoot(deskPage, "desk-needs-you");
      await desk.close();
    } finally {
      stop();
    }
    out.unexpectedWrites = fake.writes().map((call) => call.method);
  } finally {
    await browser?.close();
    await bridge.stop();
  }
  await writeFile(join(outDir, `${label}.json`), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

await run();
