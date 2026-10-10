import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DESKTOP, launchWebkit, PHONE, userCacheDir, type Browser, type Locator, type Page } from "./browser.ts";
import { startTestBridge, type TestBridge } from "./bridge.ts";
import { demoOrg, orgTreeSeed, tickJournal, type DemoHerd, type OrgSeed } from "./scenario.ts";

// The e2e bench. Every command starts its own test bridge on a FakeHerdr (bridge.ts), so nothing
// here can reach the live service or a real terminal.
//
//   bun scripts/e2e/run.ts smoke    [--port 8797] [--out DIR]   Home screenshots, phone + desktop
//   bun scripts/e2e/run.ts project  [--port 8797] [--out DIR]   A project page, then create and start nodes
//   bun scripts/e2e/run.ts org      [--port 8797] [--out DIR]   Every view of a project's organization
//   bun scripts/e2e/run.ts tabs     [--port 8797] [--out DIR]   Close an open pane's tab, then where it lands
//   bun scripts/e2e/run.ts space    [--port 8797] [--out DIR]   The workspace page for each workspace shape
//   bun scripts/e2e/run.ts baseline [--port 8797] [--out DIR] [--seconds 60] [--sends 5]
//   bun scripts/e2e/run.ts compare A.png B.png                  share of differing pixels
//
// Output goes outside the repo: --out, else $NENU_E2E_OUT, else <user cache>/nenu-e2e/<stamp>.

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string", default: "8797" },
    out: { type: "string" },
    seconds: { type: "string", default: "60" },
    sends: { type: "string", default: "5" },
  },
});

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), stamp);
const port = Number(values.port);
// Captures render at this instant (a Saturday afternoon, UTC) whenever they are taken.
const CAPTURE_EPOCH = Date.parse("2026-10-10T14:00:00Z");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Bridge process CPU time in ms, from ps (macOS and Linux print [[dd-]hh:]mm:ss[.cc]). */
async function cpuMs(pid: number): Promise<number> {
  const out = (await new Response(Bun.spawn(["ps", "-o", "time=", "-p", String(pid)]).stdout).text()).trim();
  const [clock, days] = out.includes("-") ? [out.split("-")[1]!, Number(out.split("-")[0])] : [out, 0];
  const parts = clock.split(":").map(Number);
  const seconds = parts.reduce((acc, n) => acc * 60 + n, 0);
  return Math.round((days * 86400 + seconds) * 1000);
}

/** `/api/pane/w1%3Aworking/history?…` → `pane/:id/history`, so counts group by route. */
function route(url: string): string | null {
  const { pathname } = new URL(url);
  if (!pathname.startsWith("/api/")) return null;
  return pathname.slice(5).replace(/^pane\/[^/]+/, "pane/:id").replace(/^tab\/[^/]+/, "tab/:id");
}

function tally(urls: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const u of urls) {
    const r = route(u);
    if (r) counts[r] = (counts[r] ?? 0) + 1;
  }
  return counts;
}

const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
const perMinute = (o: Record<string, number>, ms: number) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round((v * 60_000 / ms) * 10) / 10]));
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;

async function withBench<T>(fn: (bridge: TestBridge, browser: Browser) => Promise<T>, epoch?: number, org?: (herd: DemoHerd, now: number) => OrgSeed): Promise<T> {
  const bridge = await startTestBridge({ port, fake: true, epoch, org });
  let browser: Browser | null = null;
  try {
    browser = await launchWebkit();
    return await fn(bridge, browser);
  } finally {
    await browser?.close();
    await bridge.stop();
  }
}

/** A phone page that records every /api request it makes. */
async function phonePage(browser: Browser, opts: { rawTerminal?: string } = {}) {
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  if (opts.rawTerminal) {
    // The mirror is a per-pane display pref (use-display-prefs.ts), keyed by [session, paneId].
    await page.addInitScript((scope: string) => {
      localStorage.setItem("collie:raw-terminal-scopes:v1", JSON.stringify({ [scope]: true }));
    }, JSON.stringify(["default", opts.rawTerminal]));
  }
  const requests: Array<{ url: string; at: number }> = [];
  page.on("request", (req) => requests.push({ url: req.url(), at: Date.now() }));
  return { page, requests, close: () => context.close() };
}

async function smoke(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const result = await withBench(async (bridge, browser) => {
    const shots: string[] = [];
    for (const [name, device] of [["home-phone", PHONE], ["home-desktop", DESKTOP]] as const) {
      const context = await browser.newContext({ ...device, timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      await page.clock.install({ time: bridge.now() });
      await page.goto(bridge.url + "/");
      await page.getByText("Working Claude").first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1500);
      const path = join(outDir, `${name}.png`);
      await page.screenshot({ path, animations: "disabled" });
      shots.push(path);
      await context.close();
    }
    // The temp registry is empty; a project here means the operator's real one leaked in.
    const { projects } = await fetch(`${bridge.url}/api/snapshot`).then((r) => r.json() as Promise<{ projects?: unknown[] }>);
    return { shots, projects: projects?.length ?? 0, herdrCalls: bridge.fake!.counts(), unexpectedWrites: bridge.fake!.writes() };
  }, CAPTURE_EPOCH);
  await writeFile(join(outDir, "smoke.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (result.unexpectedWrites.length || result.projects) process.exit(1);
}

/**
 * The project page of a project whose coordinator is not running, on a phone and a desk; then the
 * person creates a coordinator under the project root, a thread under that coordinator, and starts
 * the project coordinator. Organizations is fake-org.ts, so the run reports the exact argv Nenu ran.
 */
async function project(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const result = await withBench(async (bridge, browser) => {
    const shots: string[] = [];
    const shoot = async (page: Page, name: string) => {
      const path = join(outDir, `${name}.png`);
      await page.screenshot({ path, animations: "disabled" });
      shots.push(path);
    };
    const openProject = async (device: typeof PHONE | typeof DESKTOP) => {
      const context = await browser.newContext({ ...device, timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      await page.clock.install({ time: bridge.now() });
      await page.goto(bridge.url + "/project/awam");
      await page.locator('main >> text="Panel depósito"').waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1500);
      return { page, close: () => context.close() };
    };
    const calledWith = async (verb: string) => {
      for (let i = 0; i < 100; i++) {
        if ((await bridge.orgCalls()).some((argv) => argv[0] === verb)) return;
        await sleep(100);
      }
      throw new Error(`Organizations was never asked to ${verb}`);
    };

    // Both pages first, so neither capture shows what the flows below create.
    for (const [name, device] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
      const { page, close } = await openProject(device);
      await shoot(page, `project-${name}`);
      await close();
    }
    let flowError: string | null = null;
    for (const [name, device] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
      const { page, close } = await openProject(device);
      try {
        if (name === "desktop") {
          await page.getByRole("button", { name: "New coordinator" }).click({ timeout: 5000 });
          await page.getByLabel("Title", { exact: true }).fill("Pagos y facturación");
          await page.getByLabel("Task", { exact: true }).fill("Coordinate the billing work: invoices, receipts and the payment provider.");
          await shoot(page, "new-coordinator-desktop");
          await page.getByRole("button", { name: "Create coordinator" }).click();
          await page.locator('main >> text="Pagos y facturación"').waitFor({ timeout: 15_000 });
          await page.waitForTimeout(500);
          await shoot(page, "project-created-desktop");
          await page.getByRole("button", { name: "Start coordinator" }).click();
          await calledWith("open");
        } else {
          await page.getByRole("button", { name: "New thread" }).click({ timeout: 5000 });
          await page.getByLabel("Title", { exact: true }).fill("Ajustar checkout");
          // A select's accessible name carries its chosen option, so its label is matched loosely.
          await page.getByLabel("Parent").selectOption("t-0010");
          await page.getByLabel("Task", { exact: true }).fill("Make the checkout fit a 390 px screen.");
          await shoot(page, "new-thread-phone");
          await page.getByRole("button", { name: "Create thread" }).click();
          await page.locator('main >> text="Ajustar checkout"').waitFor({ timeout: 15_000 });
          await page.waitForTimeout(500);
          await shoot(page, "project-created-phone");
        }
      } catch (error) {
        flowError ??= `${name}: ${(error as Error).message.split("\n")[0]}`;
        await shoot(page, `failed-${name}`);
      }
      await close();
    }
    return { shots, flowError, orgCalls: await bridge.orgCalls(), unexpectedWrites: bridge.fake!.writes() };
  }, CAPTURE_EPOCH, demoOrg);
  await writeFile(join(outDir, "project.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (result.flowError || result.unexpectedWrites.length) process.exit(1);
}

/**
 * Every place Nenu draws a project's organization, on a project shaped like a long-running one
 * (scenario.ts `orgTreeSeed`): the project page with its coordinator stopped, then with it running
 * the desk's side panel and the sidebar, and the phone's Threads tab. Each with History closed, then
 * open.
 */
async function org(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const shots: string[] = [];
  const shoot = async (page: Page, name: string) => {
    const path = join(outDir, `${name}.png`);
    await page.screenshot({ path, animations: "disabled" });
    shots.push(path);
  };
  const TALL_PHONE = { ...PHONE, viewport: { width: 390, height: 1800 } };
  const open = async (browser: Browser, bridge: TestBridge, device: typeof PHONE | typeof TALL_PHONE | typeof DESKTOP, path: string, ready: string) => {
    const context = await browser.newContext({ ...device, timezoneId: "UTC", locale: "en-US" });
    const page = await context.newPage();
    await page.clock.install({ time: bridge.now() });
    await page.goto(bridge.url + path);
    await page.locator(ready).first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(1500);
    return { page, close: () => context.close() };
  };
  const history = (scope: Locator) => scope.getByText(/^(History|Resolved)\b/).first();

  await withBench(async (bridge, browser) => {
    for (const [name, device] of [["phone", TALL_PHONE], ["desktop", DESKTOP]] as const) {
      const { page, close } = await open(browser, bridge, device, "/project/awam", 'main >> text="Panel depósito"');
      await shoot(page, `page-${name}`);
      await history(page.locator("main")).click({ timeout: 5000 });
      await page.waitForTimeout(300);
      await shoot(page, `page-history-${name}`);
      if (name === "desktop") {
        await history(page.locator('nav[aria-label="Projects and chats"]')).click({ timeout: 5000 });
        await page.waitForTimeout(300);
        await shoot(page, "sidebar-history-desktop");
      }
      await close();
    }
  }, CAPTURE_EPOCH, (herd, now) => orgTreeSeed(herd, now));

  let flowError: string | null = null;
  let orgCalls: string[][] = [];
  await withBench(async (bridge, browser) => {
    const coordinator = `/pane/${encodeURIComponent(bridge.herd!.codex)}`;
    const calledWith = async (...argv: string[]) => {
      for (let i = 0; i < 100; i++) {
        if ((await bridge.orgCalls()).some((call) => argv.every((arg, index) => call[index] === arg))) return;
        await sleep(100);
      }
      throw new Error(`Organizations was never asked to ${argv.join(" ")}`);
    };
    {
      const { page, close } = await open(browser, bridge, DESKTOP, coordinator, 'aside[aria-label="Project"] >> text="Panel depósito"');
      const panel = page.locator('aside[aria-label="Project"]');
      await shoot(page, "panel-desktop");
      await history(panel).click({ timeout: 5000 });
      await page.waitForTimeout(300);
      await shoot(page, "panel-history-desktop");
      // Each node's actions: a coordinator with open work refuses to close, a thread closes, the coordinator is replaced.
      try {
        await panel.getByRole("button", { name: "Close Rediseño mobile" }).click({ timeout: 5000 });
        await page.getByRole("dialog", { name: "Close its work first" }).waitFor({ timeout: 5000 });
        await shoot(page, "close-refused-desktop");
        await page.getByRole("button", { name: "OK" }).click();
        await panel.getByRole("button", { name: "Close Hotfix login" }).click({ timeout: 5000 });
        await page.getByRole("dialog", { name: "Close this thread?" }).getByRole("button", { name: "Close thread" }).click({ timeout: 5000 });
        await calledWith("node", "resolve", "awam", "t-0108", "--close-view");
        await panel.getByRole("button", { name: "Replace coordinator" }).click({ timeout: 5000 });
        const dialog = page.getByRole("dialog", { name: "Replace the coordinator?" });
        await dialog.getByLabel("New one runs on").selectOption("claude");
        await shoot(page, "replace-desktop");
        await dialog.getByRole("button", { name: "Replace" }).click();
        await calledWith("coordinator", "replace", "awam", "--profile=claude");
        await page.waitForTimeout(500);
        await shoot(page, "after-actions-desktop");
      } catch (error) {
        flowError ??= `desktop: ${(error as Error).message.split("\n")[0]}`;
        await shoot(page, "failed-desktop");
      }
      await close();
    }
    {
      const { page, close } = await open(browser, bridge, TALL_PHONE, coordinator, 'role=tab[name=/Threads/]');
      await page.getByRole("tab", { name: /Threads/ }).click();
      await page.locator('.project-overlay >> text="Panel depósito"').first().waitFor({ timeout: 5000 });
      await page.waitForTimeout(300);
      await shoot(page, "threads-phone");
      await history(page.locator(".project-overlay")).click({ timeout: 5000 });
      await page.waitForTimeout(300);
      await shoot(page, "threads-history-phone");
      // A resolved node opens its detail inside Nenu, not its coordinator's chat.
      try {
        await page.locator(".project-overlay").getByRole("button", { name: /^Mergear PRs restantes Coordinator/ }).click({ timeout: 5000 });
        await page.locator('main >> text="Coordinator under"').first().waitFor({ timeout: 5000 });
        await page.waitForTimeout(300);
        await shoot(page, "node-detail-phone");
      } catch (error) {
        flowError ??= `phone: ${(error as Error).message.split("\n")[0]}`;
        await shoot(page, "failed-phone");
      }
      await close();
    }
    orgCalls = await bridge.orgCalls();
  }, CAPTURE_EPOCH, (herd, now) => orgTreeSeed(herd, now, { coordinator: true }));

  const writes = orgCalls.filter((argv) => argv[0] !== "overview" && argv[1] !== "list");
  const result = { shots, flowError, orgWrites: writes };
  await writeFile(join(outDir, "org.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (flowError) process.exit(1);
}

/**
 * Closing what is on screen, on a phone and a desk: the open pane's tab from Nenu (its actions
 * sheet) and from Herdr (the fake closes it while the page shows it), the open pane beside a
 * sibling, and the tab a space view is filtered to. The demo's `nenu` space holds `redesign`
 * (working) then `review` (idle); throwaway tabs go after them, so `review` is where a close lands.
 * Then the first tab closes (lands on the next one) and the only tab of `api` closes (lands Home).
 */
async function tabs(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const result = await withBench(async (bridge, browser) => {
    const fake = bridge.fake!;
    const herd = bridge.herd!;
    const cases: Array<{ name: string; expected: string; landed: string }> = [];
    const pathname = (page: Page) => page.evaluate(() => decodeURIComponent(location.pathname), null);
    // A chip's last child is its label; a status dot's screen-reader text comes before it.
    const activeTab = (page: Page) => page.evaluate(() => document.querySelector('[data-workbench-navigation-band="tabs"] button[aria-current="true"]')?.lastChild?.textContent ?? "", null);
    const sheetClose = (band: "tabs" | "panes", row: "Close tab" | "Close pane") => async (page: Page) => {
      await page.locator(`[data-workbench-navigation-band="${band}"] button[aria-current="true"]`).click();
      await page.getByRole("button", { name: row, exact: true }).click({ timeout: 5000 });
      await page.getByRole("button", { name: /^Tap again to close/ }).click({ timeout: 5000 });
    };
    const inHerdr = (tabId: string) => async () => fake.closeTab(tabId);

    const run = async (name: string, device: typeof PHONE | typeof DESKTOP, path: string, close: (page: Page) => Promise<void>, expected: string, read = pathname) => {
      const context = await browser.newContext({ ...device, timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      await page.clock.install({ time: bridge.now() });
      await page.goto(bridge.url + path);
      await page.locator('[data-workbench-navigation-band="tabs"] button[aria-current="true"]').waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1000);
      await close(page);
      for (let i = 0; i < 100 && (await read(page)) !== expected; i++) await sleep(100);
      // Settle: a second hop (a stale snapshot bouncing Home) would land within a poll.
      await page.waitForTimeout(2500);
      cases.push({ name, expected, landed: await read(page) });
      await page.screenshot({ path: join(outDir, `${name}.png`), animations: "disabled" });
      await context.close();
    };
    // Adding a pane emits no event, so wait for the bridge's next poll to list it before opening it.
    const scratchTab = async (n: number) => {
      const tabId = `w1:t${n}`;
      const paneId = `w1:scratch${n}`;
      fake.addTab(tabId, `scratch ${n}`).addPane({ paneId, workspaceId: "w1", tabId, agent: null, label: `Scratch ${n}`, cwd: bridge.dir });
      for (let i = 0; i < 150; i++) {
        const snap = await fetch(`${bridge.url}/api/snapshot`).then((r) => r.json() as Promise<{ shellPanes: Array<{ paneId: string }> }>);
        if (snap.shellPanes.some((p) => p.paneId === paneId)) return { tabId, path: `/pane/${encodeURIComponent(paneId)}` };
        await sleep(100);
      }
      throw new Error(`the bridge never listed ${paneId}`);
    };

    const review = `/pane/${herd.idle}`;
    let n = 3;
    for (const [device, deviceName] of [[PHONE, "phone"], [DESKTOP, "desktop"]] as const) {
      const nenu = await scratchTab(n++);
      await run(`last-tab-nenu-${deviceName}`, device, nenu.path, sheetClose("tabs", "Close tab"), review);
      const herdr = await scratchTab(n++);
      await run(`last-tab-herdr-${deviceName}`, device, herdr.path, inHerdr(herdr.tabId), review);
    }
    // `server` holds Blocked Claude, Codex and a shell: closing the shell keeps you in the tab.
    await run("sibling-pane-nenu-phone", PHONE, `/pane/${encodeURIComponent(herd.shell)}`, sheetClose("panes", "Close pane"), `/pane/${herd.blocked}`);
    await scratchTab(n);
    await run("space-tab-nenu-phone", PHONE, "/space/w1", async (page) => {
      await page.getByRole("button", { name: `scratch ${n}`, exact: true }).click({ timeout: 5000 });
      await sheetClose("tabs", "Close tab")(page);
    }, "review", activeTab);
    await run("first-tab-herdr-phone", PHONE, `/pane/${encodeURIComponent(herd.working)}`, inHerdr("w1:t1"), review);
    await run("only-tab-nenu-desktop", DESKTOP, `/pane/${encodeURIComponent(herd.blocked)}`, sheetClose("tabs", "Close tab"), "/");
    const closes = fake.writes().filter((c) => c.method.endsWith(".close")).map((c) => `${c.method} ${String(c.params.tab_id ?? c.params.pane_id)}`);
    return { cases, failed: cases.filter((c) => c.landed !== c.expected).map((c) => c.name), closes };
  }, CAPTURE_EPOCH);
  await writeFile(join(outDir, "tabs.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (result.failed.length) process.exit(1);
}

/**
 * The workspace page, on a phone and a desk, for each shape a workspace takes: `nenu` (two tabs of
 * one agent each), `api` (one tab holding two agents and a shell) and `psag`, added here as Herdr
 * names an unlabelled tab: one tab called "1" holding one agent. Then a pane's own tab bar, which
 * shares the page's tabs.
 */
async function space(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const result = await withBench(async (bridge, browser) => {
    const fake = bridge.fake!;
    fake.addWorkspace("w3", "psag").addTab("w3:t1", "1")
      .addPane({ paneId: "w3:solo", workspaceId: "w3", tabId: "w3:t1", agent: "claude", label: "T-76 Mejoras", cwd: join(bridge.dir, "psag") });
    for (let i = 0; i < 150; i++) {
      const snap = await fetch(`${bridge.url}/api/snapshot`).then((r) => r.json() as Promise<{ agents: Array<{ paneId: string }> }>);
      if (snap.agents.some((p) => p.paneId === "w3:solo")) break;
      await sleep(100);
    }
    const shots: string[] = [];
    const landed: Array<{ name: string; expected: string; landed: string }> = [];
    const tabBar = '[data-workbench-navigation-band="tabs"] button[aria-current="true"]';
    // A workspace of one pane opens straight onto it; the others stay on their page.
    const cases = [
      ["nenu", "/space/w1", "/space/w1", 'main >> text="nenu"'],
      ["api", "/space/w2", "/space/w2", 'main >> text="api"'],
      ["psag", "/space/w3", "/pane/w3:solo", tabBar],
      ["pane-tabs", `/pane/${encodeURIComponent(bridge.herd!.idle)}`, `/pane/${bridge.herd!.idle}`, tabBar],
    ] as const;
    for (const [deviceName, device] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
      for (const [label, path, expected, ready] of cases) {
        const context = await browser.newContext({ ...device, timezoneId: "UTC", locale: "en-US" });
        const page = await context.newPage();
        await page.clock.install({ time: bridge.now() });
        await page.goto(bridge.url + path);
        await page.locator(ready).first().waitFor({ timeout: 15_000 });
        await page.waitForTimeout(1500);
        const name = `${label}-${deviceName}`;
        landed.push({ name, expected, landed: await page.evaluate(() => decodeURIComponent(location.pathname), null) });
        const shot = join(outDir, `space-${name}.png`);
        await page.screenshot({ path: shot, animations: "disabled" });
        shots.push(shot);
        await context.close();
      }
    }
    return { shots, landed, failed: landed.filter((c) => c.landed !== c.expected).map((c) => c.name), unexpectedWrites: fake.writes() };
  }, CAPTURE_EPOCH);
  await writeFile(join(outDir, "space.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (result.failed.length || result.unexpectedWrites.length) process.exit(1);
}

async function baseline(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const windowMs = Number(values.seconds) * 1000;
  const sends = Number(values.sends);

  const report = await withBench(async (bridge, browser) => {
    const fake = bridge.fake!;
    const herd = bridge.herd!;
    const stopJournal = tickJournal(herd.journals.get(herd.working)!, bridge.now);
    const out: Record<string, unknown> = {
      measuredAt: new Date().toISOString(),
      against: "FakeHerdr (bridge/test-support/fake-herdr.ts), demo herd in scripts/e2e/scenario.ts",
      browser: "WebKit (playwright-core 1.60.0, webkit-2287), iPhone viewport 390x844",
      windowSeconds: windowMs / 1000,
    };

    // 1. Socket calls the bridge makes on its own, with no browser attached.
    await sleep(3000);
    fake.resetCounts();
    let cpu0 = await cpuMs(bridge.pid);
    await sleep(windowMs);
    const idleCalls = fake.counts();
    out.noClients = {
      herdrCallsPerMinute: perMinute(idleCalls, windowMs),
      socketCallsPerPoll: Math.round((sum(idleCalls) / Math.max(1, idleCalls["session.snapshot"] ?? 0)) * 10) / 10,
      bridgeCpuPercent: Math.round(((await cpuMs(bridge.pid)) - cpu0) / windowMs * 1000) / 10,
    };

    // 2. One phone per view, measured over the same window after a warm-up.
    const views: Array<[string, string, { rawTerminal?: string }]> = [
      ["home", "/", {}],
      ["chatWorking", `/pane/${encodeURIComponent(herd.working)}`, {}],
      ["mirrorWorking", `/pane/${encodeURIComponent(herd.working)}`, { rawTerminal: herd.working }],
      ["dialogOnScreen", `/pane/${encodeURIComponent(herd.blocked)}`, {}],
    ];
    const perView: Record<string, unknown> = {};
    for (const [name, path, opts] of views) {
      const phone = await phonePage(browser, opts);
      await phone.page.goto(bridge.url + path);
      await sleep(5000);
      const from = Date.now();
      fake.resetCounts();
      cpu0 = await cpuMs(bridge.pid);
      await sleep(windowMs);
      const http = tally(phone.requests.filter((r) => r.at >= from).map((r) => r.url));
      perView[name] = {
        httpRequestsPerMinute: Math.round(sum(http) * 60_000 / windowMs),
        byRoute: perMinute(http, windowMs),
        herdrCallsPerMinute: perMinute(fake.counts(), windowMs),
        bridgeCpuPercent: Math.round(((await cpuMs(bridge.pid)) - cpu0) / windowMs * 1000) / 10,
      };
      await phone.close();
    }
    out.perPhone = perView;

    // 3. Tap Send to Enter on the idle Claude pane: the guarded reply's full client choreography.
    {
      const phone = await phonePage(browser);
      await phone.page.goto(bridge.url + `/pane/${encodeURIComponent(herd.idle)}`);
      const box = phone.page.getByPlaceholder("Type a reply…").first();
      await box.waitFor({ timeout: 15_000 });
      await sleep(2000);
      const samples: Array<{ tapToEnterMs: number; httpTrips: number; byRoute: Record<string, number> }> = [];
      for (let i = 0; i < sends; i++) {
        const text = `baseline send ${i + 1}`;
        await box.fill(text);
        const before = fake.submitted.length;
        const t0 = Date.now();
        await phone.page.getByRole("button", { name: "Send", exact: true }).click();
        while (fake.submitted.length === before && Date.now() - t0 < 15_000) await sleep(5);
        const enter = fake.submitted[before];
        if (!enter || enter.text !== text) throw new Error(`send ${i + 1} never reached Enter (saw ${JSON.stringify(enter)})`);
        const trips = tally(phone.requests.filter((r) => r.at >= t0 && r.at <= enter.at).map((r) => r.url));
        samples.push({ tapToEnterMs: enter.at - t0, httpTrips: sum(trips), byRoute: trips });
        await sleep(1500);
      }
      const ms = samples.map((s) => s.tapToEnterMs);
      out.send = { pane: "claude idle", runs: sends, p50Ms: pct(ms, 0.5), maxMs: Math.max(...ms), samples };
      await phone.close();
    }

    // 4. Answer the permission dialog from the pane view: HTTP trips from the tap to the key.
    {
      const phone = await phonePage(browser);
      await phone.page.goto(bridge.url + `/pane/${encodeURIComponent(herd.blocked)}`);
      const yes = phone.page.getByRole("button", { name: /^1\.?\s*Yes$|^Yes$/ }).first();
      await yes.waitFor({ timeout: 15_000 });
      await sleep(2000);
      const t0 = Date.now();
      await yes.click();
      while (fake.answered.length === 0 && Date.now() - t0 < 15_000) await sleep(5);
      const answer = fake.answered[0];
      if (!answer) throw new Error("the dialog answer never reached the fake terminal");
      await sleep(2000);
      const toKey = tally(phone.requests.filter((r) => r.at >= t0 && r.at <= answer.at).map((r) => r.url));
      const settled = tally(phone.requests.filter((r) => r.at >= t0).map((r) => r.url));
      out.dialogAnswer = {
        key: answer.key, tapToKeyMs: answer.at - t0,
        httpTripsToKey: sum(toKey), byRouteToKey: toKey,
        httpTripsWithin2sAfter: sum(settled), byRouteWithin2sAfter: settled,
      };
      await phone.close();
    }

    stopJournal();
    // The only writes this run drives: the sends on the idle pane and the dialog key on the blocked one.
    const expected = new Set([`pane.send_text ${herd.idle}`, `pane.send_keys ${herd.idle}`, `pane.send_keys ${herd.blocked}`]);
    out.unexpectedWrites = fake.writes().filter((c) => !expected.has(`${c.method} ${String(c.params.pane_id)}`));
    return out;
  });

  const file = join(outDir, "baseline.json");
  await writeFile(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`\n[e2e] baseline written to ${file}`);
}

/** Share of differing pixels between two same-size PNGs, decoded by WebKit itself. */
async function compare(a: string, b: string): Promise<void> {
  const browser = await launchWebkit();
  try {
    const page = await (await browser.newContext({})).newPage();
    const toUrl = async (p: string) => `data:image/png;base64,${Buffer.from(await Bun.file(p).arrayBuffer()).toString("base64")}`;
    const result = await page.evaluate(async ([ua, ub]: string[]) => {
      const load = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
      });
      const [ia, ib] = await Promise.all([load(ua!), load(ub!)]);
      if (ia.width !== ib.width || ia.height !== ib.height) return { sameSize: false, differing: 1 };
      const pixels = (img: HTMLImageElement) => {
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, c.width, c.height).data;
      };
      const pa = pixels(ia), pb = pixels(ib);
      let diff = 0;
      for (let i = 0; i < pa.length; i += 4) {
        if (Math.abs(pa[i]! - pb[i]!) + Math.abs(pa[i + 1]! - pb[i + 1]!) + Math.abs(pa[i + 2]! - pb[i + 2]!) > 24) diff++;
      }
      return { sameSize: true, differing: diff / (pa.length / 4) };
    }, [await toUrl(a), await toUrl(b)]);
    console.log(JSON.stringify({ a, b, ...result, differingPercent: Math.round(result.differing * 10000) / 100 }));
  } finally {
    await browser.close();
  }
}

const command = positionals[0];
if (command === "smoke") await smoke();
else if (command === "project") await project();
else if (command === "org") await org();
else if (command === "tabs") await tabs();
else if (command === "space") await space();
else if (command === "baseline") await baseline();
else if (command === "compare" && positionals[2]) await compare(positionals[1]!, positionals[2]);
else {
  console.error("usage: bun scripts/e2e/run.ts smoke|project|org|tabs|space|baseline [--port 8797] [--out DIR] | compare A.png B.png");
  process.exit(2);
}
