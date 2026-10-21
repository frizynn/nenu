import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { launchWebkit, PHONE, userCacheDir, type Page } from "./browser.ts";
import { startTestBridge } from "./bridge.ts";
import { demoOrg, type DemoHerd } from "./scenario.ts";

// The back control from every way into a thread, a coordinator and a project (useGoBack in
// web/src/lib/motion.ts), in WebKit at 390 x 844 with an iPhone's user agent. Each walk starts in a
// fresh tab, goes from one screen into another the way a person would, takes the app's ‹ and writes
// where it landed, beside where it should: the screen it came from, with its filter and scroll, or
// for a screen nothing in the app opened (a link), its parent once, with the history no longer.
// Also the system's Back from the same place, and #208's walk, which must end at the entry + 2.
//
//   bun scripts/e2e/origin.ts [--port 8812] [--out DIR] [--label before|after]

const { values } = parseArgs({ options: { port: { type: "string", default: "8812" }, out: { type: "string" }, label: { type: "string", default: "after" } } });
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), `origin-${Date.now()}`);
const label = values.label!;

const link = (kind: string, text: string, extra: Record<string, unknown> = {}) =>
  ({ kind, text, target: text, thread: "", title: "", state: "", pr: "", pr_state: "", ...extra });
const ROOT = { id: "root", title: "" };
const LANDING = link("thread", "t-0012", { thread: "t-0012", title: "Landing a 390 px", state: "working" });

/** demoOrg with enough asks to scroll, the last ones linked to the Landing thread. */
function seed(herd: DemoHerd, now: number) {
  const org = demoOrg(herd, now);
  const ask = (line: number, text: string, links: unknown[] = []) =>
    ({ project: "acme", coordinator: ROOT, line, state: "working", text, answer: "en curso", links, confirmed: "", mismatch: "" });
  const asks = Array.from({ length: 24 }, (_, n) => ask(n + 5, `Pedido número ${n + 1} para Acme`, n >= 20 ? [LANDING] : []));
  return { ...org, asks };
}

interface Row { entry: string; from: string; opened: string; back: string; expected: string; ok: boolean; lenBefore: number; lenAfter: number; scroll?: { before: number; after: number } }

const rows: Row[] = [];
const shots: string[] = [];
await mkdir(outDir, { recursive: true });
const bridge = await startTestBridge({ port: Number(values.port), fake: true, org: seed });
const browser = await launchWebkit();
const here = (page: Page) => page.evaluate(() => location.pathname + location.search, null);
const length = (page: Page) => page.evaluate(() => history.length, null);
/** Where the page's scroller stands (PageBody's `main`): the page scrolls inside its column. */
const scrolled = (page: Page) => page.evaluate(() => document.querySelector("main.page-body")?.scrollTop ?? -1, null);
const settle = (page: Page) => page.waitForTimeout(1000);
const tapBack = async (page: Page) => {
  await page.locator('header [aria-label^="Back to"] >> visible=true').first().click({ timeout: 5000 });
  await settle(page);
};

try {
  const herd = bridge.herd!;
  const pane = (id: string) => `/pane/${encodeURIComponent(id)}`;
  /** One walk in a fresh tab: `start` opens the first screen, `go` moves into the next, then ‹ (or the system's Back). */
  const walk = async (entry: string, start: string, go: (page: Page) => Promise<void>, expected: string | RegExp, opts: { system?: boolean; scroll?: number } = {}) => {
    const context = await browser.newContext({ ...PHONE, reducedMotion: "no-preference", timezoneId: "UTC", locale: "en-US" });
    const page = await context.newPage();
    try {
      await page.goto(bridge.url + start);
      await page.locator("header").first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(2500);
      let scrollBefore: number | undefined;
      if (opts.scroll) {
        await page.evaluate((y: number) => { document.querySelector("main.page-body")!.scrollTop = y; }, opts.scroll);
        await page.waitForTimeout(400);
        scrollBefore = await scrolled(page);
      }
      const from = await here(page);
      // Where the page stood at the tap itself: a click scrolls its target into view first.
      await page.evaluate(() => addEventListener("click", () => {
        (window as unknown as { __tapScroll: number }).__tapScroll = document.querySelector("main.page-body")?.scrollTop ?? -1;
      }, { capture: true, once: true }), null);
      await go(page);
      if (opts.scroll) scrollBefore = await page.evaluate(() => (window as unknown as { __tapScroll: number }).__tapScroll, null);
      await settle(page);
      const opened = await here(page);
      const lenBefore = await length(page);
      const name = `${label}-${String(rows.length + 1).padStart(2, "0")}-${entry.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
      await page.screenshot({ path: join(outDir, `${name}-opened.png`) });
      if (opts.system) {
        await page.evaluate(() => history.back(), null);
        await page.waitForTimeout(1500);
      } else await tapBack(page);
      const back = await here(page);
      const lenAfter = await length(page);
      const shot = join(outDir, `${name}-back.png`);
      await page.screenshot({ path: shot });
      shots.push(shot);
      const ok = typeof expected === "string" ? back === expected : expected.test(back);
      rows.push({ entry, from, opened, back, expected: String(expected), ok, lenBefore, lenAfter,
        ...(scrollBefore !== undefined ? { scroll: { before: scrollBefore, after: await scrolled(page) } } : {}) });
    } catch (error) {
      rows.push({ entry, from: start, opened: "?", back: `error: ${(error as Error).message.split("\n")[0]}`, expected: String(expected), ok: false, lenBefore: 0, lenAfter: 0 });
    } finally {
      await context.close();
    }
  };
  const click = (selector: string) => async (page: Page) => { await page.locator(`${selector} >> visible=true`).first().click({ timeout: 5000 }); };
  // Home opens on its Projects tab (ADR 0110); a session's row is under Recents.
  const fromRecents = (selector: string) => async (page: Page) => {
    await page.getByRole("tab", { name: "Recents" }).first().click({ timeout: 5000 });
    await click(selector)(page);
  };
  const toProject = async (page: Page) => {
    await page.getByRole("button", { name: "Open navigation" }).first().click({ timeout: 5000 });
    // The drawer's own row: Home's Projects tab under it links the same project.
    await click('nav[aria-label="Projects and chats"] a[href="/project/acme"]')(page);
  };

  // Threads.
  await walk("Home → thread (Recents)", "/", fromRecents(`a[href="${pane(herd.working)}"]`), "/");
  await walk("Coordinator → Threads → thread", `${pane(herd.idle)}?view=threads`, async (page) => {
    await page.locator(".project-overlay").getByText("Landing a 390 px").first().click({ timeout: 5000 });
  }, `${pane(herd.idle)}?view=threads`);
  await walk("Your asks (filtered, scrolled) → thread", "/asks?project=acme", click('a[href="/project/acme/node/t-0012"]'), "/asks?project=acme", { scroll: 600 });
  await walk("Your asks → thread, system Back", "/asks?project=acme", click('a[href="/project/acme/node/t-0012"]'), "/asks?project=acme", { system: true });
  await walk("Thread page → Open chat", "/project/acme/node/t-0012", async (page) => {
    await page.getByRole("button", { name: "Open chat" }).click({ timeout: 5000 });
  }, "/project/acme/node/t-0012");
  await walk("Search → thread", "/", async (page) => {
    await page.getByRole("button", { name: "Search" }).first().click({ timeout: 5000 });
    await page.locator('input[aria-label="Search projects and chats"] >> visible=true').first().fill("Landing", { timeout: 5000 });
    await page.waitForTimeout(800);
    // The match is marked inside the result, so its text is not one node.
    await page.locator('[role="listbox"] >> text=/Landing/ >> visible=true').first().click({ timeout: 5000 });
  }, "/");
  await walk("Link (fresh tab) → thread", "/", async (page) => {
    await page.goto(bridge.url + pane(herd.working));
    await page.locator("header").first().waitFor({ timeout: 15_000 });
  }, new RegExp(`^${pane(herd.idle).replace(/[%]/g, "%")}`));
  // Coordinators.
  await walk("Home → coordinator (Recents)", "/", fromRecents(`a[href="${pane(herd.idle)}"]`), "/");
  await walk("Project → coordinator", "/project/acme", click('main >> text="Rediseño mobile"'), "/project/acme");
  await walk("Your asks → coordinator", "/asks?project=acme", click('a[href="/project/acme/node/root"]'), "/asks?project=acme");
  // Projects.
  await walk("Home → project", "/", toProject, "/");
  await walk("Settings → Home → project, system Back", "/settings", async (page) => {
    await tapBack(page);
    await toProject(page);
  }, "/", { system: true });

  // #208: Home → project → coordinator → Threads → ‹ → ‹ ends at the entry + 2.
  const context = await browser.newContext({ ...PHONE, reducedMotion: "no-preference", timezoneId: "UTC", locale: "en-US" });
  const page = await context.newPage();
  await page.goto(bridge.url + "/");
  await page.locator('a[href="/project/acme"]').first().waitFor({ state: "attached", timeout: 15_000 });
  await page.waitForTimeout(1500);
  const entry = await length(page);
  await toProject(page);
  await settle(page);
  await click('main >> text="Rediseño mobile"')(page);
  await settle(page);
  await page.getByRole("tab", { name: /^Threads/ }).click({ timeout: 5000 });
  await settle(page);
  await tapBack(page);
  const first = await here(page);
  await tapBack(page);
  const second = await here(page);
  const issue208 = { entry, end: await length(page), entriesAdded: (await length(page)) - entry, path: [first, second] };
  await context.close();

  const table = ["| Entré desde | Abrí | ‹ me llevó a | Esperado | OK | history.length |", "|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.entry} (${r.from}) | ${r.opened} | ${r.back}${r.scroll ? ` (scroll ${r.scroll.before} → ${r.scroll.after})` : ""} | ${r.expected} | ${r.ok ? "sí" : "no"} | ${r.lenBefore} → ${r.lenAfter} |`)].join("\n");
  const result = { label, browser: "WebKit, iPhone 390x844", rows, issue208, shots };
  await writeFile(join(outDir, `origin-${label}.json`), JSON.stringify(result, null, 2));
  await writeFile(join(outDir, `origin-${label}.md`), `${table}\n\n#208: entrada ${issue208.entry}, final ${issue208.end} (+${issue208.entriesAdded}), ${issue208.path.join(" → ")}\n`);
  console.log(table);
  console.log("#208", JSON.stringify(issue208));
  console.log("out", outDir);
} finally {
  await browser.close();
  await bridge.stop();
}
