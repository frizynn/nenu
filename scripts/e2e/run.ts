import { writeFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { CLAUDE_HOOK_PATH, CLAUDE_HOOK_TOKEN_FILE, CLAUDE_HOOK_TOKEN_HEADER } from "../../bridge/claude-hooks.ts";
import { browsersCache, DESKTOP, launchEngine, launchWebkit, PHONE, userCacheDir, type Browser, type Context, type Locator, type Page } from "./browser.ts";
import { startTestBridge, type TestBridge } from "./bridge.ts";
import { filesBench } from "./files.ts";
import { inlineImagesBench } from "./inline-images.ts";
import { pasteImageBench } from "./paste-image.ts";
import { appendJournal, demoOrg, deskOrg, diffOrg, growDiffRepo, homeOrg, needsYouSeed, orgTreeSeed, projectChatSeed, seedDiffRepo, tickJournal, tickWorkingTurn, writeChatJournal, writeJournal, writeLongJournal, type DemoHerd, type OrgSeed } from "./scenario.ts";

// The e2e bench. Every command starts its own test bridge on a FakeHerdr (bridge.ts), so nothing
// here can reach the live service or a real terminal.
//
//   bun scripts/e2e/run.ts smoke    [--port 8797] [--out DIR]   Home screenshots, phone + desktop
//   bun scripts/e2e/run.ts project  [--port 8797] [--out DIR]   A project page, then create and start nodes
//   bun scripts/e2e/run.ts org      [--port 8797] [--out DIR]   Every view of a project's organization
//   bun scripts/e2e/run.ts threads  [--port 8797] [--out DIR] [--seconds 60]  A coordinator's chat: tabs, panel, DOM and React renders
//   bun scripts/e2e/run.ts needs-you [--port 8797] [--out DIR]  Two threads that need you: a dialog, and an agent waiting for a reply
//   bun scripts/e2e/run.ts tabs     [--port 8797] [--out DIR]   Close an open pane's tab, then where it lands
//   bun scripts/e2e/run.ts workspace [--port 8797] [--out DIR]  Open each workspace from every way in, then where it lands
//   bun scripts/e2e/run.ts workspace-rows [--port 8797] [--out DIR]  A workspace's row in every list, phone and desk: folds, where a row that opens directly lands
//   bun scripts/e2e/run.ts layout   [--port 8797] [--out DIR]   Every page at 1280/1440/1920 (sidebar open, folded), 900 and 390
//   bun scripts/e2e/run.ts stop     [--port 8797] [--out DIR]   Stop a working Claude, then what the queue holds
//   bun scripts/e2e/run.ts processes [--port 8797] [--out DIR]  A working Claude's background work: chip, list, details, ⋯
//   bun scripts/e2e/run.ts stop-state [--port 8797] [--out DIR] Stop from the session file, under a custom statusline
//   bun scripts/e2e/run.ts baseline [--port 8797] [--out DIR] [--seconds 60] [--sends 5]
//   bun scripts/e2e/run.ts artifacts [--port 8797] [--out DIR]  Artifacts and files: delivered, published, images in and out of the folder
//   bun scripts/e2e/run.ts files    [--port 8797] [--out DIR]   Every file a chat hands over, followed: taps, new tabs, lists, Open, refusals
//   bun scripts/e2e/run.ts home     [--port 8797] [--out DIR] [--seconds 60]  A busy Home, calm then asked: captures, each list, requests per minute
//   bun scripts/e2e/run.ts inspector [--before] [--port 8797] [--out DIR]  A session's Inspector on a desk: tabs, fold, Overview, requests per tab
//   bun scripts/e2e/run.ts terminal [--before] [--port 8797] [--out DIR]  The desk's Terminal tab, the + menu, watch reads
//   bun scripts/e2e/run.ts motion   [--before] [--port 8797] [--out DIR] [--seconds 60]  Page transitions frame by frame, tap to content, transitions while quiet
//   bun scripts/e2e/run.ts back     [--port 8797] [--out DIR]   Into a project's threads and back, two projects: history length, motion, Back from Home
//   bun scripts/e2e/run.ts surface  [--port 8797] [--out DIR] [--seconds 60]  Surfaces and project marks on every screen, idle CPU, memory and DOM
//   bun scripts/e2e/run.ts sidebar  [--port 8797] [--out DIR] [--seconds 60]  The desk's bar, Routines, Needs you, an agent finishing elsewhere; idle CPU
//   bun scripts/e2e/run.ts idle     [--port 8797] [--out DIR] [--seconds 60]  Only sidebar's idle cost, to alternate two builds of web/dist
//   bun scripts/e2e/run.ts chips    [--before] [--port 8797] [--out DIR] [--seconds 60]  The row above the composer: each chip's panel, phone and desk, idle CPU
//   bun scripts/e2e/run.ts chip-line [--port 8797] [--out DIR]  The chips under the box and Stop in it: seven moments, phone and desk, nothing above the box
//   bun scripts/e2e/run.ts composer [--port 8797] [--out DIR]   Around the box: every chip's panel, a long branch, another machine, finished work; what opening a panel moves
//   bun scripts/e2e/run.ts chat     [--port 8797] [--out DIR] [--seconds 60]  A finished conversation, folded and open; a long one's DOM, idle CPU and memory
//   bun scripts/e2e/run.ts scroll   [--port 8797] [--out DIR]   A long chat read on a phone: what moves the line being read with no touch
//   bun scripts/e2e/run.ts reading  [--port 8797] [--out DIR]   Tables, nested lists, the way back and the model picker, phone and desk
//   bun scripts/e2e/run.ts pin      [--port 8797] [--out DIR]   The box stays put on a phone: drags, keyboard, scrollers; WebKit and Chromium
//   bun scripts/e2e/run.ts at-rest  [--port 8797] [--out DIR]   A conversation that ended its turn on Home: never Needs you, beside a real dialog
//   bun scripts/e2e/run.ts inline-images [--before] [--port 8797] [--out DIR]  Two pictures between a message's words: composer, terminal, conversation
//   bun scripts/e2e/run.ts paste-image [--port 8797] [--out DIR]  Pictures pasted and picked between words, keyboard down and up: the draft spans the box
//   bun scripts/e2e/run.ts phone-scroll [--port 8797] [--out DIR]  Every phone screen and two sheets: one box scrolls, drags move nothing else, the end shows
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
    before: { type: "boolean", default: false },
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

async function withBench<T>(fn: (bridge: TestBridge, browser: Browser) => Promise<T>, epoch?: number, org?: (herd: DemoHerd, now: number) => OrgSeed, repo?: (dir: string) => void): Promise<T> {
  const bridge = await startTestBridge({ port, fake: true, epoch, org, repo });
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
      await page.goto(bridge.url + "/project/acme");
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
          await page.getByRole("dialog", { name: "Start the coordinator" }).getByRole("button", { name: "Start" }).click({ timeout: 5000 });
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
      const { page, close } = await open(browser, bridge, device, "/project/acme", 'main >> text="Panel depósito"');
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
        await calledWith("node", "resolve", "acme", "t-0108", "--close-view");
        await panel.getByRole("button", { name: "Replace coordinator" }).click({ timeout: 5000 });
        const dialog = page.getByRole("dialog", { name: "Replace the coordinator?" });
        await dialog.getByRole("radio", { name: "Claude Code" }).click({ timeout: 5000 });
        await shoot(page, "replace-desktop");
        await dialog.getByRole("button", { name: "Replace" }).click();
        await calledWith("coordinator", "replace", "acme", "--harness=claude");
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
 * Counts React commits and the components each one rendered, through the hook React DevTools uses
 * (a production build calls it too). A component counts when it mounted or performed work; a
 * subtree React bailed out of keeps its old children and is not walked.
 */
function countRenders(): void {
  const stats = { commits: 0, renders: 0 };
  const components = new Set([0, 1, 11, 14, 15]); // function, class, forwardRef, memo, simple memo
  type Fiber = { tag: number; flags: number; alternate: Fiber | null; child: Fiber | null; sibling: Fiber | null };
  const walk = (first: Fiber | null) => {
    for (let fiber = first; fiber; fiber = fiber.sibling) {
      const before = fiber.alternate;
      if (components.has(fiber.tag) && (before === null || (fiber.flags & 1) !== 0)) stats.renders++;
      if (fiber.child && before?.child !== fiber.child) walk(fiber.child);
    }
  };
  Object.assign(window, {
    __nenuRenders: stats,
    __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      supportsFiber: true, renderers: new Map(), inject: () => 1, checkDCE: () => {}, setStrictMode: () => {},
      onCommitFiberUnmount: () => {}, onPostCommitFiberRoot: () => {},
      onCommitFiberRoot: (_id: number, root: { current: Fiber }) => { stats.commits++; walk(root.current.child); },
    },
  });
}

/**
 * A project coordinator's chat (scenario.ts `projectChatSeed`): the phone's Chat, Threads and PRs
 * tabs at 390x844 and the desk at 1440x900 beside the project panel and without it, captured on the
 * pinned clock. Then the phone's Chat tab measured on the real clock, twice: DOM elements, and the
 * React commits and component renders over `--seconds` of polling.
 */
async function threads(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const shots: string[] = [];
  const windowMs = Number(values.seconds) * 1000;
  const result = await withBench(async (bridge, browser) => {
    const coordinator = `/pane/${encodeURIComponent(bridge.herd!.working)}`;
    const open = async (device: typeof PHONE | typeof DESKTOP, opts: { pinned: boolean; counted?: boolean }) => {
      const context = await browser.newContext({ ...device, timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      if (opts.counted) await page.addInitScript(countRenders, null);
      if (opts.pinned) await page.clock.install({ time: bridge.now() });
      const requests: string[] = [];
      page.on("request", (req) => requests.push(req.url()));
      await page.goto(bridge.url + coordinator);
      await page.getByPlaceholder("Ask the coordinator…").waitFor({ timeout: 15_000 });
      await page.waitForTimeout(2000);
      return { page, requests, close: () => context.close() };
    };
    const shoot = async (page: Page, name: string) => {
      const path = join(outDir, `${name}.png`);
      await page.screenshot({ path, animations: "disabled" });
      shots.push(path);
    };
    const cards = (page: Page) => page.locator('section[aria-label="Threads"] article').count();

    const seen: Record<string, unknown> = {};
    {
      const { page, close } = await open(PHONE, { pinned: true });
      seen.phoneChatCards = await cards(page);
      await shoot(page, "phone-chat");
      for (const tab of ["Threads", "PRs"] as const) {
        await page.getByRole("tab", { name: new RegExp(`^${tab}`) }).click();
        await page.locator(".project-overlay").waitFor({ timeout: 5000 });
        await page.waitForTimeout(300);
        seen[`phone${tab}Rows`] = await page.locator(".project-overlay .task-main").count();
        await shoot(page, `phone-${tab.toLowerCase()}`);
      }
      await close();
    }
    {
      const { page, close } = await open(DESKTOP, { pinned: true });
      seen.desktopPanelCards = await cards(page);
      await shoot(page, "desktop-panel");
      await page.getByRole("button", { name: "Hide session panel" }).click();
      await page.waitForTimeout(500);
      seen.desktopNoPanelCards = await cards(page);
      await shoot(page, "desktop-no-panel");
      await close();
    }

    const runs = [];
    for (let run = 1; run <= 2; run++) {
      const { page, requests, close } = await open(PHONE, { pinned: false, counted: true });
      const dom = await page.evaluate(() => ({
        document: document.getElementsByTagName("*").length,
        thread: document.querySelector(".chat-thread")?.getElementsByTagName("*").length ?? 0,
      }), null);
      const from = requests.length;
      await page.evaluate(() => Object.assign((window as unknown as { __nenuRenders: object }).__nenuRenders, { commits: 0, renders: 0 }), null);
      await page.waitForTimeout(windowMs);
      const react = await page.evaluate(() => ({ ...(window as unknown as { __nenuRenders: { commits: number; renders: number } }).__nenuRenders }), null);
      const byRoute = tally(requests.slice(from));
      const polls = byRoute.snapshot ?? 0;
      runs.push({ run, cards: await cards(page), dom, seconds: windowMs / 1000, ...react, byRoute,
        rendersPerCommit: react.commits ? Math.round(react.renders / react.commits) : 0,
        rendersPerSnapshot: polls ? Math.round(react.renders / polls) : null });
      await close();
    }
    return { shots, seen, runs, unexpectedWrites: bridge.fake!.writes() };
  }, CAPTURE_EPOCH, (herd, now) => projectChatSeed(herd, now));
  await writeFile(join(outDir, "threads.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (result.unexpectedWrites.length) process.exit(1);
}

/**
 * Closing what is on screen, on a phone and a desk: the open pane's tab from Nenu (its actions
 * sheet) and from Herdr (the fake closes it while the page shows it), and the open pane beside a
 * sibling. The demo's `nenu` space holds `redesign`
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
    const sheetClose = (band: "tabs" | "panes", row: "Close tab" | "Close pane") => async (page: Page) => {
      await page.locator(`[data-workbench-navigation-band="${band}"] button[aria-current="true"]`).click();
      await page.getByRole("button", { name: row, exact: true }).click({ timeout: 5000 });
      // The row asks first: its confirmation's button carries the row's name and ignores taps for
      // its first 500 ms (action-sheet-rows.tsx), so a double tap closes nothing.
      await page.getByRole("heading", { name: /^Close “/ }).waitFor({ timeout: 5000 });
      await page.waitForTimeout(700);
      await page.getByRole("button", { name: row, exact: true }).click({ timeout: 5000 });
    };
    const inHerdr = (tabId: string) => async () => fake.closeTab(tabId);

    const run = async (name: string, device: typeof PHONE | typeof DESKTOP, path: string, close: (page: Page) => Promise<void>, expected: string) => {
      const context = await browser.newContext({ ...device, timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      await page.clock.install({ time: bridge.now() });
      await page.goto(bridge.url + path);
      await page.locator('[data-workbench-navigation-band="tabs"] button[aria-current="true"]').waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1000);
      await close(page);
      for (let i = 0; i < 100 && (await pathname(page)) !== expected; i++) await sleep(100);
      // Settle: a second hop (a stale snapshot bouncing Home) would land within a poll.
      await page.waitForTimeout(2500);
      cases.push({ name, expected, landed: await pathname(page) });
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
 * Opening a workspace from every way in, on a desk and a phone: the sidebar row, search (⌘K on the
 * desk), the folded rail, the phone's Browse, and a `/space/:id` link from an older Nenu. Each must
 * land on the pane the workspace opens on (lib/spaces.ts workspaceEntry): `api` on its blocked
 * agent, `nenu` on the first pane of Herdr's active tab, `docs` (one pane) on it, and `ops` on
 * the vpn shell the operator had open last.
 */
async function workspace(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const result = await withBench(async (bridge, browser) => {
    const fake = bridge.fake!;
    const herd = bridge.herd!;
    await addDocs(bridge);
    await addOps(bridge);
    const expected: Record<string, string> = { nenu: `/pane/${herd.working}`, api: `/pane/${herd.blocked}`, docs: "/pane/w3:solo", ops: "/pane/w4:vpn" };
    const ids: Record<string, string> = { nenu: "w1", api: "w2", docs: "w3", ops: "w4" };
    const pathname = (page: Page) => page.evaluate(() => decodeURIComponent(location.pathname), null);
    const landed: Array<{ entry: string; workspace: string; expected: string; landed: string }> = [];
    const shots: string[] = [];
    const row = (scope: string, name: string) => `${scope} section[aria-label="${name}"] a.nav-row`;
    type Entry = (page: Page, name: string) => Promise<void>;
    const entries: Record<"desktop" | "phone", Array<[string, Entry]>> = {
      desktop: [
        ["sidebar", (page, name) => page.locator(row('aside[aria-label="Workspace sidebar"]', name)).click()],
        ["search", async (page, name) => {
          await page.keyboard.press("Meta+k");
          await page.getByRole("searchbox").fill(name);
          await page.locator(row('aside[aria-label="Workspace sidebar"]', name)).click();
        }],
        ["rail", async (page, name) => {
          // The fold persists, so it is set once and the page reloads onto the rail.
          await page.evaluate(() => localStorage.setItem("nenu:sidebar-collapsed:v1", "1"), null);
          await page.goto(`${bridge.url}/`);
          await page.locator(`nav[aria-label="Collapsed sidebar"] a[aria-label="${name}"]`).click();
        }],
        ["old-link", (page, name) => page.goto(`${bridge.url}/space/${ids[name]}`).then(() => undefined)],
      ],
      phone: [
        ["search-tree", async (page, name) => {
          await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Search" }).click();
          await page.locator(row("[role=dialog]", name)).click();
        }],
        ["search", async (page, name) => {
          await page.getByRole("button", { name: "Search" }).click();
          await page.getByRole("searchbox").fill(name);
          await page.locator(row("[role=dialog]", name)).click();
        }],
        ["old-link", (page, name) => page.goto(`${bridge.url}/space/${ids[name]}`).then(() => undefined)],
      ],
    };

    for (const [deviceName, device] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
      const context = await browser.newContext({ ...device, timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      await page.clock.install({ time: bridge.now() });
      // The operator had ops' vpn shell open, so the bridge holds it as the pane last seen there.
      await page.goto(`${bridge.url}/pane/${encodeURIComponent("w4:vpn")}`);
      await page.locator('[data-workbench-navigation-band="tabs"]').first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1500);
      for (const [entry, open] of entries[deviceName]) {
        for (const name of Object.keys(expected)) {
          await page.goto(`${bridge.url}/`);
          await page.locator("h1").first().waitFor({ timeout: 15_000 });
          await page.waitForTimeout(300);
          let at = "";
          try {
            await open(page, name);
            for (let i = 0; i < 100 && (at = await pathname(page)) !== expected[name]; i++) await sleep(100);
          } catch (error) {
            at = `error: ${(error as Error).message.split("\n")[0]}`;
          }
          landed.push({ entry: `${deviceName}/${entry}`, workspace: name, expected: expected[name]!, landed: at });
          if (name === "ops" && entry === entries[deviceName][0]![0]) {
            await page.locator('[data-workbench-navigation-band="tabs"]').first().waitFor({ timeout: 15_000 });
            await page.waitForTimeout(1200);
            const shot = join(outDir, `ops-${deviceName}.png`);
            await page.screenshot({ path: shot, animations: "disabled" });
            shots.push(shot);
          }
        }
      }
      await context.close();
    }
    return { shots, landed, failed: landed.filter((c) => c.landed !== c.expected), unexpectedWrites: fake.writes() };
  }, CAPTURE_EPOCH);
  await writeFile(join(outDir, "workspace.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, landed: result.landed.length }, null, 2));
  if (result.failed.length || result.unexpectedWrites.length) process.exit(1);
}

/** A workspace of one unlabelled tab holding one agent. */
async function addDocs(bridge: TestBridge): Promise<void> {
  bridge.fake!.addWorkspace("w3", "docs").addTab("w3:t1", "1")
    .addPane({ paneId: "w3:solo", workspaceId: "w3", tabId: "w3:t1", agent: "claude", label: "Docs refresh", cwd: join(bridge.dir, "docs") });
  for (let i = 0; i < 150; i++) {
    const snap = await fetch(`${bridge.url}/api/snapshot`).then((r) => r.json() as Promise<{ agents: Array<{ paneId: string }> }>);
    if (snap.agents.some((p) => p.paneId === "w3:solo")) return;
    await sleep(100);
  }
  throw new Error("the bridge never listed docs");
}

/** A workspace of two tabs with a session in each, one of them finished: two sessions, so its row unfolds. */
async function addPair(bridge: TestBridge): Promise<void> {
  bridge.fake!.addWorkspace("w5", "pair").addTab("w5:t1", "1").addTab("w5:t2", "2")
    .addPane({ paneId: "w5:lead", workspaceId: "w5", tabId: "w5:t1", agent: "claude", label: "Pair lead", cwd: join(bridge.dir, "pair") })
    .addPane({ paneId: "w5:done", workspaceId: "w5", tabId: "w5:t2", agent: "claude", label: "Pair review", cwd: join(bridge.dir, "pair") });
  bridge.fake!.setStatus("w5:done", "done");
  for (let i = 0; i < 150; i++) {
    const snap = await fetch(`${bridge.url}/api/snapshot`).then((r) => r.json() as Promise<{ agents: Array<{ paneId: string }> }>);
    if (snap.agents.some((p) => p.paneId === "w5:done")) return;
    await sleep(100);
  }
  throw new Error("the bridge never listed pair");
}

/** A workspace of three tabs: one agent, one shell, and four agents split in one tab, each in another state. */
async function addCrew(bridge: TestBridge): Promise<void> {
  const fake = bridge.fake!;
  const cwd = join(bridge.dir, "crew");
  fake.addWorkspace("w6", "crew").addTab("w6:t1", "lead").addTab("w6:t2", "server").addTab("w6:t3", "workers");
  const pane = (paneId: string, tabId: string, agent: "claude" | "codex" | null, label: string) => fake.addPane({ paneId, workspaceId: "w6", tabId, agent, label, cwd });
  pane("w6:lead", "w6:t1", "claude", "Crew lead");
  pane("w6:server", "w6:t2", null, "Dev server");
  pane("w6:checkout", "w6:t3", "claude", "Checkout flow");
  pane("w6:payments", "w6:t3", "codex", "Payment retries after a declined card");
  pane("w6:invoice", "w6:t3", "claude", "Invoice export");
  pane("w6:search", "w6:t3", "claude", "Search index");
  const reported = async (paneId: string, status: string) => {
    for (let i = 0; i < 150; i++) {
      const snap = await fetch(`${bridge.url}/api/snapshot`).then((r) => r.json() as Promise<{ agents: Array<{ paneId: string; status: string }> }>);
      if (snap.agents.some((p) => p.paneId === paneId && p.status === status)) return;
      await sleep(100);
    }
    throw new Error(`the bridge never reported ${paneId} ${status}`);
  };
  // The bridge reports done only for a finish it saw after it first saw the pane (ADR 0071).
  await reported("w6:search", "idle");
  fake.setStatus("w6:checkout", "working");
  fake.setStatus("w6:payments", "done");
  fake.setStatus("w6:invoice", "blocked");
  await reported("w6:payments", "done");
}

/**
 * A workspace's row in every list that draws one, against nenu (two tabs, two sessions), api (one tab
 * split in three), docs (one tab, one pane), ops (one session, a shell in a second tab), pair (two
 * tabs, a session in each) and crew (an agent's tab, a shell's tab and a tab of four agents): the
 * phone's drawer, its Search sheet and Home's Workspaces at 390, the desk's Search and Home's
 * Workspaces at 1440, dark and light, each whole and nenu's and pair's rows alone, folded and open.
 * crew is captured folded, open, and open with its tab of four open, each with how wide the titles
 * under it are. Then which rows offer a fold, and where a tap on each kind of row lands.
 */
async function workspaceRows(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const result = await withBench(async (bridge, browser) => {
    await addDocs(bridge);
    await addOps(bridge);
    await addPair(bridge);
    await addCrew(bridge);
    const names = ["nenu", "api", "docs", "ops", "pair", "crew"];
    const shots: string[] = [];
    const folds: Array<{ view: string; workspace: string; fold: boolean }> = [];
    const landed: Array<{ view: string; workspace: string; landed: string }> = [];
    const titles: Array<{ view: string; state: string; title: string; width: number; cut: boolean }> = [];
    const pathname = (page: Page) => page.evaluate(() => decodeURIComponent(location.pathname), null);
    const homeList = async (page: Page) => {
      await page.getByRole("tab", { name: "Workspaces" }).click();
      await page.locator("#home-list li").first().waitFor({ timeout: 15_000 });
    };
    // Each view: how to reach it from Home, where its rows sit, and a workspace's row in it.
    // `fold` is a workspace's own chevron; `cell` the box a session's title gets, its first child the title.
    const tree = (scope: string) => ({
      row: (name: string) => `${scope} section[aria-label="${name}"]`,
      link: (name: string) => `${scope} section[aria-label="${name}"] a.nav-row`,
      fold: (name: string) => `${scope} section[aria-label="${name}"] > .nav-project > [aria-expanded]`,
      cell: "a.nav-pane .nav-pane-text",
    });
    // A Home row is named "<workspace>, <state>, <count>", whether it folds or opens.
    const home = {
      row: (name: string) => `#home-list > ul > li:has(> [aria-label^="${name},"])`,
      link: (name: string) => `#home-list > ul > li > [aria-label^="${name},"]`,
      fold: (name: string) => `#home-list > ul > li > button[aria-label^="${name},"]`,
      cell: "a > span.col-start-2:not(.row-start-2)",
    };
    type View = { row: (name: string) => string; link: (name: string) => string; fold: (name: string) => string; cell: string };
    const views: Record<"phone" | "desktop", Array<[string, (page: Page) => Promise<void>, View]>> = {
      phone: [
        ["drawer", (page) => page.getByRole("button", { name: "Open navigation" }).click(), tree("[role=dialog]")],
        ["search", (page) => page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Search" }).click(), tree("[role=dialog]")],
        ["home", homeList, home],
      ],
      desktop: [
        ["search", (page) => page.getByRole("navigation", { name: "Projects and chats" }).getByRole("button", { name: /^Search/ }).click(), tree('aside[aria-label="Workspace sidebar"]')],
        ["home", homeList, home],
      ],
    };
    for (const [deviceName, device] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
      for (const scheme of ["dark", "light"] as const) {
        const context = await browser.newContext({ ...device, colorScheme: scheme, timezoneId: "UTC", locale: "en-US" });
        const page = await context.newPage();
        await page.clock.install({ time: bridge.now() });
        for (const [view, reach, at] of views[deviceName]) {
          const enter = async () => {
            await page.goto(`${bridge.url}/`);
            await page.getByRole("tab", { name: "Recents" }).first().waitFor({ timeout: 15_000 });
            await page.waitForTimeout(1200);
            await reach(page);
            await page.locator(at.row("docs")).first().waitFor({ timeout: 15_000 });
            await page.waitForTimeout(600);
          };
          await enter();
          const shot = join(outDir, `${view}-${deviceName}-${scheme}.png`);
          await page.screenshot({ path: shot, animations: "disabled" });
          const nenu = join(outDir, `${view}-${deviceName}-${scheme}-nenu.png`);
          await page.locator(at.row("nenu")).first().screenshot({ path: nenu, animations: "disabled" });
          shots.push(shot, nenu);
          // Set a fold open or shut, whatever the view started it as; a fold the build lacks is left alone.
          const fold = async (selector: string, open: boolean) => {
            const toggle = page.locator(selector).first();
            if (await toggle.count() && await toggle.getAttribute("aria-expanded") !== String(open)) await toggle.click();
            await page.waitForTimeout(300);
          };
          const workers = `${at.row("crew")} [aria-expanded][aria-label^="workers,"]`;
          // Workspaces with no tab of several panes, open: these must not move.
          for (const name of ["nenu", "pair"]) {
            await fold(at.fold(name), true);
            const open = join(outDir, `${view}-${deviceName}-${scheme}-${name}-open.png`);
            await page.locator(at.row(name)).first().screenshot({ path: open, animations: "disabled" });
            shots.push(open);
            await fold(at.fold(name), false);
          }
          for (const [state, wsOpen, tabOpen] of [["folded", false, false], ["open", true, false], ["tab-open", true, true]] as const) {
            await fold(at.fold("crew"), wsOpen);
            if (wsOpen) await fold(workers, tabOpen);
            await page.locator(at.row("crew")).first().scrollIntoViewIfNeeded();
            const whole = join(outDir, `${view}-${deviceName}-${scheme}-crew-${state}.png`);
            await page.screenshot({ path: whole, animations: "disabled" });
            const row = join(outDir, `${view}-${deviceName}-${scheme}-crew-${state}-row.png`);
            await page.locator(at.row("crew")).first().screenshot({ path: row, animations: "disabled" });
            shots.push(whole, row);
            if (scheme === "dark" && wsOpen) {
              const cells = await page.locator(`${at.row("crew")} ${at.cell}`).evaluateAll((els) => els.map((el) => {
                const title = el.firstElementChild as HTMLElement;
                return { title: title.textContent ?? "", width: Math.round(el.getBoundingClientRect().width), cut: title.scrollWidth > title.clientWidth };
              }));
              titles.push(...cells.map((cell) => ({ view: `${deviceName}/${view}`, state, ...cell })));
            }
          }
          await fold(at.fold("crew"), false);
          if (scheme === "light") continue;
          for (const name of names) folds.push({ view: `${deviceName}/${view}`, workspace: name, fold: await page.locator(`${at.row(name)} [aria-expanded]`).count() > 0 });
          for (const name of ["docs", "api", "ops"]) {
            if (name !== "docs") await enter();
            await page.locator(at.link(name)).first().click();
            await page.waitForTimeout(1500);
            landed.push({ view: `${deviceName}/${view}`, workspace: name, landed: await pathname(page) });
            const tapped = join(outDir, `${view}-${deviceName}-${scheme}-${name}-tapped.png`);
            await page.screenshot({ path: tapped, animations: "disabled" });
            shots.push(tapped);
          }
          // Each kind of row under crew: an agent's tab, a shell's tab, the tab of four, a pane in that tab.
          for (const [kind, title] of [["agent", "Crew lead"], ["shell", "Dev server"], ["tab", "workers"], ["in-tab", "Invoice export"]] as const) {
            await enter();
            await fold(at.fold("crew"), true);
            if (kind === "in-tab") await fold(workers, true);
            let landedAt = "";
            try {
              if (kind === "tab") {
                const toggle = page.locator(workers).first();
                const before = await toggle.getAttribute("aria-expanded", { timeout: 3000 });
                await toggle.click();
                await page.waitForTimeout(600);
                landedAt = `${await pathname(page)} (expanded ${before} -> ${await toggle.getAttribute("aria-expanded")})`;
              } else {
                await page.locator(at.row("crew")).getByRole("link", { name: new RegExp(`^${title}`) }).first().click({ timeout: 3000 });
                await page.waitForTimeout(1500);
                landedAt = await pathname(page);
              }
            } catch (error) {
              landedAt = `error: ${(error as Error).message.split("\n")[0]}`;
            }
            landed.push({ view: `${deviceName}/${view}`, workspace: `crew/${kind}`, landed: landedAt });
          }
        }
        await context.close();
      }
    }
    return { shots, folds, landed, titles, unexpectedWrites: bridge.fake!.writes() };
  }, CAPTURE_EPOCH);
  await writeFile(join(outDir, "workspace-rows.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, shots: result.shots.length }, null, 2));
  if (result.unexpectedWrites.length) process.exit(1);
}

/** A workspace of two tabs, as Herdr leaves them: an agent in the unlabelled tab "1", a shell in "vpn". */
async function addOps(bridge: TestBridge): Promise<void> {
  bridge.fake!.addWorkspace("w4", "ops").addTab("w4:t1", "1").addTab("w4:t2", "vpn")
    .addPane({ paneId: "w4:agent", workspaceId: "w4", tabId: "w4:t1", agent: "claude", label: "Search metrics", cwd: join(bridge.dir, "ops") })
    .addPane({ paneId: "w4:vpn", workspaceId: "w4", tabId: "w4:t2", agent: null, label: "vpn", cwd: join(bridge.dir, "ops") });
  bridge.fake!.setStatus("w4:agent", "working");
  for (let i = 0; i < 150; i++) {
    const snap = await fetch(`${bridge.url}/api/snapshot`).then((r) => r.json() as Promise<{ shellPanes: Array<{ paneId: string }> }>);
    if (snap.shellPanes.some((p) => p.paneId === "w4:vpn")) return;
    await sleep(100);
  }
  throw new Error("the bridge never listed ops");
}

/**
 * Every page at the widths a desk shows it (1280, 1440 and 1920, the sidebar open and folded), on a
 * tablet and on a phone, with the header's height and where its title and the content column sit (layout.json): Home, a
 * project, a node, Settings, a workspace and a workspace pane's chat, then a coordinator's chat
 * beside the project panel.
 */
async function layout(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  // 900 is a tablet: no sidebar yet, the phone's navigation, a desk's gutter.
  const variants: Array<[string, Record<string, unknown>, boolean]> = [["390", PHONE, false], ["900", { ...DESKTOP, viewport: { width: 900, height: 900 } }, false]];
  for (const width of [1280, 1440, 1920]) {
    for (const folded of [false, true]) variants.push([`${width}-${folded ? "folded" : "open"}`, { ...DESKTOP, viewport: { width, height: 900 } }, folded]);
  }
  const tabBar = '[data-workbench-navigation-band="tabs"]';
  const measures: Record<string, unknown> = {};
  const capture = async (bridge: TestBridge, browser: Browser, pages: Array<[string, string, string]>) => {
    for (const [variant, device, folded] of variants) {
      const context = await browser.newContext({ ...device, timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      await page.clock.install({ time: bridge.now() });
      if (folded) await page.addInitScript(() => localStorage.setItem("nenu:sidebar-collapsed:v1", "1"), null);
      for (const [name, path, ready] of pages) {
        await page.goto(bridge.url + path);
        await page.locator(ready).first().waitFor({ timeout: 15_000 });
        await page.waitForTimeout(1200);
        const shot = `${name}-${variant}`;
        await page.screenshot({ path: join(outDir, `${shot}.png`), animations: "disabled" });
        measures[shot] = await page.evaluate(() => {
          const box = (el: Element | null) => {
            if (!el) return null;
            const { left, right } = el.getBoundingClientRect();
            return { left: Math.round(left), right: Math.round(right), width: Math.round(right - left) };
          };
          return {
            path: decodeURIComponent(location.pathname),
            header: Math.round(document.querySelector(".workbench-app-header")?.getBoundingClientRect().height ?? 0),
            pane: box(document.querySelector(".workbench-main")),
            title: box(document.querySelector(".workbench-app-header .flex-1 > *")),
            column: box(document.querySelector("main > div")),
          };
        }, null);
      }
      await context.close();
    }
  };
  await withBench(async (bridge, browser) => {
    await addOps(bridge);
    await capture(bridge, browser, [
      ["home", "/", "h1"],
      ["project", "/project/acme", 'main >> text="Panel depósito"'],
      ["node", "/project/acme/node/t-0101", 'main >> text="Migración de stock"'],
      ["settings", "/settings", "text=Push notifications"],
      ["workspace", "/space/w4", `main:has-text("ops"), ${tabBar}`],
      ["chat", "/pane/w4%3Aagent", tabBar],
    ]);
  }, CAPTURE_EPOCH, (herd, now) => orgTreeSeed(herd, now));
  await withBench(async (bridge, browser) => {
    await capture(bridge, browser, [["coordinator", `/pane/${encodeURIComponent(bridge.herd!.codex)}`, 'aside[aria-label="Project"]:has-text("Panel depósito"), [role=tab]:has-text("Threads")']]);
  }, CAPTURE_EPOCH, (herd, now) => orgTreeSeed(herd, now, { coordinator: true }));
  await writeFile(join(outDir, "layout.json"), JSON.stringify(measures, null, 2));
  console.log(`[e2e] ${Object.keys(measures).length} captures in ${outDir}`);
}

/**
 * Stop on a working Claude, on a phone and a desk: the composer while it works (empty, then with a
 * draft), "Stopping…", and the composer once the pane is idle. The phone taps Stop twice and fires two
 * interrupts at once, and must still press Escape once; the desk stops with Esc in the empty composer.
 * The phone also queues a message for after the turn first: Stop must leave it held, not delivered.
 * A build without Stop records `stop: false` and keeps the first two captures, so the same command
 * shows the before.
 */
async function stop(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const result = await withBench(async (bridge, browser) => {
    const fake = bridge.fake!;
    const pane = bridge.herd!.working;
    // Long enough to see "Stopping…"; a real Claude goes idle ~300 ms after Escape.
    fake.interruptMs = 2500;
    const shots: string[] = [];
    const runs: Array<Record<string, unknown>> = [];
    // The desk first: the phone's queued row is still listed when a later device opens the pane.
    for (const [deviceName, device] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
      fake.setStatus(pane, "working");
      const context = await browser.newContext({ ...device, timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      await page.clock.install({ time: bridge.now() });
      await page.goto(`${bridge.url}/pane/${encodeURIComponent(pane)}`);
      const box = page.getByRole("textbox").first();
      await box.waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1500);
      const shot = async (name: string) => {
        const path = join(outDir, `stop-${name}-${deviceName}.png`);
        await page.screenshot({ path, animations: "disabled" });
        shots.push(path);
      };
      await shot("working");
      await box.fill("Also run the tests before you finish");
      await page.waitForTimeout(400);
      await shot("working-draft");
      const run: Record<string, unknown> = { device: deviceName };
      runs.push(run);
      let queued = 0;
      if (deviceName === "phone") {
        // Queued for after the turn, the row waits in Nenu while Claude works.
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await page.getByRole("button", { name: /Queue for later/ }).click({ timeout: 5000 });
        queued = fake.submitted.length;
        await page.waitForTimeout(800);
      } else {
        await box.fill("");
      }
      const stopButton = page.getByRole("button", { name: "Stop", exact: true });
      run.stop = await stopButton.waitFor({ timeout: 3000 }).then(() => true, () => false);
      if (!run.stop) {
        await context.close();
        continue;
      }
      const before = fake.interrupted.length;
      if (deviceName === "phone") {
        await stopButton.click();
        await stopButton.click({ timeout: 300 }).catch(() => {});
        // Two requests racing past the button, as two devices would.
        run.racing = await page.evaluate(async (id: string) => {
          const post = () => fetch(`/api/pane/${encodeURIComponent(id)}/interrupt`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => r.json());
          return Promise.all([post(), post()]);
        }, pane);
      } else {
        await box.press("Escape");
      }
      run.stopping = await page.getByText("Stopping…").first().waitFor({ timeout: 2000 }).then(() => true, () => false);
      await shot("stopping");
      for (let i = 0; i < 100 && fake.screen(pane).includes("esc to interrupt"); i++) await sleep(100);
      await page.waitForTimeout(2000);
      await shot("stopped");
      run.escapes = fake.interrupted.length - before;
      run.stopAfterIdle = await stopButton.isVisible();
      if (deviceName === "phone") {
        // Held, not delivered: nothing new was submitted since the row was queued.
        run.heldUndelivered = fake.submitted.length === queued;
        run.held = await page.getByText(/^Held/).first().waitFor({ timeout: 3000 }).then(() => true, () => false);
      }
      await context.close();
    }
    const failed = runs.filter((r) => r.stop && (r.escapes !== 1 || !r.stopping || r.stopAfterIdle || r.heldUndelivered === false)).map((r) => r.device);
    return { shots, runs, failed, writes: fake.writes().map((c) => `${c.method} ${JSON.stringify(c.params.keys ?? c.params.text ?? "")}`) };
  }, CAPTURE_EPOCH);
  await writeFile(join(outDir, "stop.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (result.failed.length) process.exit(1);
}

/**
 * A working Claude with background work: a running workflow, a subagent waiting on you, one running,
 * a background command and a monitor. The bridge's activity and subagent readers are unit-tested over
 * real (redacted) session files, so here their answers are fixed (web/src/components/activity
 * fixture, shifted to the capture instant) and the bench looks at how the chat shows them: the chat,
 * the processes list, a row expanded, a workflow's details, the ⋯ menu and the composer typing while
 * the agent works, then everything finished: the quiet chip and its Done list. On a desk it also
 * checks that Esc in the empty composer closes the details panel without sending anything. Run on a build without the chip, it captures the same moments the old way (cards in
 * the chat, the Activity sheet, the full-screen workflow), so one command shows before and after.
 */
async function processes(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const fixture = JSON.parse(await Bun.file(join(import.meta.dir, "../../web/src/components/activity/activity.fixture.json")).text());
  const result = await withBench(async (bridge, browser) => {
    const pane = bridge.herd!.working;
    const now = bridge.now();
    const shift = now - fixture.now;
    const shiftTimes = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(shiftTimes);
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, (k === "startedAt" || k === "updatedAt" || k === "at") && typeof v === "number" ? v + shift : shiftTimes(v)]));
      }
      return value;
    };
    const list = shiftTimes(fixture.list) as { workflows: unknown[]; tasks: unknown[] };
    list.tasks = [
      { id: "b0001", kind: "bash", title: "bun test --watch", status: "running", at: now - 8_000, hasOutput: true },
      { id: "m0001", kind: "monitor", title: "Monitor CI checks", status: "running", at: now - 60_000, hasOutput: false },
      { id: "b0002", kind: "bash", title: "bun run build", status: "completed", exitCode: 0, at: now - 900_000, hasOutput: true },
      ...list.tasks,
    ];
    const detail = shiftTimes(fixture.detail);
    const iso = (ago: number) => new Date(now - ago).toISOString();
    const subagents = {
      available: true, sessionKey: "bench", truncated: false, agents: [
        { id: "a0000000000000001", parentId: "", name: "reviewer", task: "Review the processes chip diff", model: "claude-opus-5-5[1m]", status: "waiting", updatedAt: iso(120_000) },
        { id: "a0000000000000002", parentId: "", name: "state-reader", task: "Read how Stop decides a turn runs", model: "claude-opus-5-5[1m]", status: "running", updatedAt: iso(20_000) },
        { id: "a0000000000000003", parentId: "", name: "ui-audit", task: "Audit the composer row", status: "completed", updatedAt: iso(1_800_000) },
      ],
    };
    // Everything above, finished: what the chip offers once nothing waits or runs.
    const finishedList = { ...list, workflows: (list.workflows as Array<Record<string, unknown>>).map((w) => ({ ...w, status: w.status === "running" ? "completed" : w.status, durationMs: w.durationMs ?? 600_000 })),
      tasks: (list.tasks as Array<Record<string, unknown>>).map((t) => ({ ...t, status: t.status === "running" ? "completed" : t.status })) };
    const finishedSubagents = { ...subagents, agents: subagents.agents.map((a) => ({ ...a, status: "completed" })) };
    let finished = false;
    const shots: string[] = [];
    const found: Record<string, Record<string, boolean>> = {};
    const devices: Array<[string, Record<string, unknown>]> = [
      ["1440", DESKTOP], ["1920", { ...DESKTOP, viewport: { width: 1920, height: 1080 } }], ["390", PHONE],
    ];
    for (const [deviceName, device] of devices) {
      bridge.fake!.setStatus(pane, "working");
      const context = await browser.newContext({ ...device, timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      await page.clock.install({ time: now });
      await page.route("**/api/pane/*/activity*", (route) => {
        const url = new URL(route.request().url());
        const run = url.searchParams.get("run");
        if (run) {
          const workflow = (list as { workflows: Array<{ runId: string }> }).workflows.find((w) => w.runId === run);
          return route.fulfill(workflow ? { json: run === (detail as { workflow: { runId: string } }).workflow.runId ? detail : { sessionKey: "bench", workflow, results: {} } } : { status: 404 });
        }
        if (url.searchParams.has("task")) return route.fulfill({ json: { sessionKey: "bench", id: url.searchParams.get("task"), text: "✓ 412 pass\n  0 fail\nwatching for changes…", truncated: false, updatedAt: now } });
        return route.fulfill({ json: finished ? finishedList : list });
      });
      await page.route("**/api/pane/*/subagents*", (route) => route.fulfill({ json: finished ? finishedSubagents : subagents }));
      finished = false;
      const writes: string[] = [];
      page.on("request", (request) => { if (request.method() === "POST" && request.url().includes("/api/pane/")) writes.push(new URL(request.url()).pathname); });
      await page.goto(`${bridge.url}/pane/${encodeURIComponent(pane)}`);
      const box = page.getByRole("textbox").first();
      await box.waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1800);
      const seen: Record<string, boolean> = {};
      found[deviceName] = seen;
      const shot = async (name: string) => {
        const path = join(outDir, `processes-${name}-${deviceName}.png`);
        await page.screenshot({ path, animations: "disabled" });
        shots.push(path);
      };
      const tap = async (locator: Locator, key: string) => {
        seen[key] = await locator.waitFor({ timeout: 2500 }).then(() => true, () => false);
        if (seen[key]) await locator.click();
        await page.waitForTimeout(500);
        return seen[key];
      };
      await shot("chat");
      if (await tap(page.getByRole("button", { name: /^Processes/ }).first(), "chip")) {
        await shot("list");
        if (await tap(page.getByRole("button", { name: "Expand nenu-wave" }).first(), "expand")) await shot("expanded");
        if (await tap(page.getByRole("button", { name: "Details of nenu-wave" }).first(), "details")) await shot("details");
        const panel = page.getByRole("complementary", { name: /^Details/ });
        if (await panel.isVisible()) {
          // Esc in the empty composer closes the desk's panel first; it must not stop the turn.
          await box.click();
          const before = writes.length;
          await page.keyboard.press("Escape");
          await page.waitForTimeout(400);
          seen.escClosesPanel = !(await panel.isVisible());
          seen.escSentNothing = writes.length === before;
        } else {
          await page.keyboard.press("Escape");
          await page.keyboard.press("Escape");
        }
      } else {
        // The build before the chip: the Activity sheet behind ⋯, and a workflow full screen.
        if (await tap(page.getByRole("button", { name: "Conversation actions" }).first(), "menu-old")) {
          if (await tap(page.getByRole("button", { name: "Background activity" }).first(), "activity-sheet")) await shot("list");
          await page.keyboard.press("Escape");
        }
        if (await tap(page.getByRole("button", { name: /View workflow/ }).first(), "workflow-screen")) {
          await shot("details");
          await tap(page.getByRole("button", { name: "Back" }).first(), "back");
        }
      }
      await page.waitForTimeout(300);
      if (await tap(page.getByRole("button", { name: "Conversation actions" }).first(), "menu")) {
        await shot("menu");
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
      }
      await box.fill("Also run the tests before you finish");
      await page.waitForTimeout(500);
      await shot("typing");
      seen.stopWhileTyping = await page.getByRole("button", { name: "Stop", exact: true }).isVisible();
      seen.sendWhileTyping = await page.getByRole("button", { name: "Send", exact: true }).isVisible();
      await box.fill("");
      await page.waitForTimeout(400);
      seen.stopEmpty = await page.getByRole("button", { name: "Stop", exact: true }).isVisible();
      seen.sendEmpty = await page.getByRole("button", { name: "Send", exact: true }).isVisible();
      finished = true;
      bridge.fake!.setStatus(pane, "idle");
      await page.goto(`${bridge.url}/pane/${encodeURIComponent(pane)}`);
      await box.waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1800);
      const quiet = page.getByRole("button", { name: /^Processes/ }).first();
      seen.quietChip = await quiet.waitFor({ timeout: 2500 }).then(() => true, () => false);
      seen.quietChipText = await page.getByRole("button", { name: /^Processes: \d+ done$/ }).first().isVisible();
      await shot("finished");
      if (await tap(quiet, "quietOpens") && await tap(page.getByRole("button", { name: /^Done \(\d+\)$/ }).first(), "doneFold")) await shot("finished-list");
      await context.close();
    }
    return { shots, found };
  }, CAPTURE_EPOCH);
  await writeFile(join(outDir, "processes.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

/**
 * Stop decided by the CLI's own state (ADR 0067). The working Claude pane draws a custom statusline,
 * so its screen never says "esc to interrupt", and its session file (`<profile>/sessions/<pid>.json`)
 * says busy. Phone: Stop shows and presses Escape once, confirmed when the file goes idle. Then the
 * file stays busy while the transcript says the main turn ended (a background agent): Herdr still
 * says working, Stop must not show, and a forced Stop must press nothing.
 */
async function stopState(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const result = await withBench(async (bridge, browser) => {
    const fake = bridge.fake!;
    const pane = bridge.herd!.working;
    const pid = 424242;
    const sessionId = "6f0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
    const sessions = join(bridge.dir, "journals", "sessions");
    const transcript = join(bridge.dir, "journals", "claude", "-bench-stop-state", `${sessionId}.jsonl`);
    await mkdir(sessions, { recursive: true });
    await mkdir(join(transcript, ".."), { recursive: true });
    const writeSession = (status: string, statusUpdatedAt: number) =>
      writeFile(join(sessions, `${pid}.json`), JSON.stringify({ pid, sessionId, kind: "interactive", version: "2.1.296", status, statusUpdatedAt, updatedAt: statusUpdatedAt }));
    const busyAt = Date.now();
    await writeFile(transcript, JSON.stringify({ type: "user", timestamp: new Date(busyAt + 5).toISOString(), message: { role: "user", content: "write an essay" } }) + "\n");
    await writeSession("busy", busyAt);
    fake.customStatusline.add(pane);
    fake.processes.set(pane, [{ pid, argv: ["claude"] }]);
    fake.interruptMs = 300;
    fake.setStatus(pane, "working");
    // A real Claude flips its session file idle 12-21 ms after Escape (measured); the fake pane goes idle after interruptMs.
    const stopWatch = setInterval(() => {
      if (fake.interrupted.length > 0 && !idleWritten) { idleWritten = true; void writeSession("idle", Date.now()); }
    }, 20);
    let idleWritten = false;
    const run: Record<string, unknown> = {};
    const shots: string[] = [];
    try {
      const context = await browser.newContext({ ...PHONE, timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      await page.goto(`${bridge.url}/pane/${encodeURIComponent(pane)}`);
      await page.getByRole("textbox").first().waitFor({ timeout: 15_000 });
      const stopButton = page.getByRole("button", { name: "Stop", exact: true });
      run.hintOnScreen = fake.screen(pane).includes("esc to interrupt");
      run.stopShown = await stopButton.waitFor({ timeout: 5000 }).then(() => true, () => false);
      const shot = async (name: string) => { const path = join(outDir, `stop-state-${name}-phone.png`); await page.screenshot({ path, animations: "disabled" }); shots.push(path); };
      await shot("working");
      if (run.stopShown) await stopButton.click();
      await page.waitForTimeout(1500);
      await shot("stopped");
      run.escapes = fake.interrupted.length;
      run.turnAfter = await page.evaluate(async (id: string) => {
        const snapshot = await (await fetch("/api/snapshot")).json() as { agents: Array<{ paneId: string; turn?: unknown }> };
        return snapshot.agents.find((agent) => agent.paneId === id)?.turn ?? null;
      }, pane);
      run.stopAfterIdle = await stopButton.isVisible();

      // Background only: busy, and the main chain's last assistant row ended the turn inside this busy
      // spell. No turn_duration: Claude holds it back while teammates or detached tool calls run.
      clearInterval(stopWatch);
      const bgAt = Date.now();
      await writeSession("busy", bgAt);
      await writeFile(transcript, [
        { type: "user", timestamp: new Date(bgAt + 5).toISOString(), message: { role: "user", content: "launch a background agent" } },
        { type: "assistant", timestamp: new Date(bgAt + 50).toISOString(), message: { role: "assistant", stop_reason: "end_turn", content: [] } },
      ].map((row) => JSON.stringify(row)).join("\n") + "\n");
      fake.setStatus(pane, "working");
      await page.waitForTimeout(2500);
      run.backgroundStopShown = await stopButton.isVisible();
      run.backgroundNote = await page.getByText("Background work is running. Stop doesn't reach it.").isVisible();
      await shot("background");
      // A background agent's permission prompt, answered: waiting, then busy again with a later timestamp.
      await writeSession("waiting", Date.now());
      await page.waitForTimeout(400);
      await writeSession("busy", Date.now());
      await page.waitForTimeout(1500);
      run.afterDialogStopShown = await stopButton.isVisible();
      run.backgroundForced = await page.evaluate(async (id: string) => (await fetch(`/api/pane/${encodeURIComponent(id)}/interrupt`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json(), pane);
      run.escapesAfterBackground = fake.interrupted.length;
      await context.close();
    } finally {
      clearInterval(stopWatch);
    }
    const turnAfter = run.turnAfter as { running?: boolean; source?: string } | null;
    const forced = run.backgroundForced as { ok?: boolean; code?: string } | null;
    const failed = [
      run.hintOnScreen ? "the screen showed the hint; the test proves nothing" : null,
      run.stopShown ? null : "Stop not shown for a busy session",
      turnAfter?.source === "claude-session" && turnAfter.running === false && !run.stopAfterIdle ? null : "the session file's idle did not reach the button",
      run.escapes === 1 ? null : `expected 1 Escape, got ${run.escapes}`,
      run.backgroundStopShown ? "Stop shown while only background work runs" : null,
      run.backgroundNote ? null : "no note says why Stop is missing during background work",
      run.afterDialogStopShown ? "Stop shown after a background agent's dialog was answered" : null,
      forced?.code === "not_running" && run.escapesAfterBackground === 1 ? null : "a forced Stop on background work pressed or answered wrongly",
    ].filter(Boolean);
    return { run, shots, failed };
  }, CAPTURE_EPOCH);
  await writeFile(join(outDir, "stop-state.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (result.failed.length) process.exit(1);
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

/**
 * A pull request's diff (scenario.ts `seedDiffRepo`): the working pane is a thread on PR #1342 whose
 * folder is the PR's worktree. Its size in the PR bar (phone) and in the PRs tab (desk) opens the
 * viewer, dark and light; then a commit past every limit (`growDiffRepo`) shows the cuts announced.
 * With `--before` it only captures the bar and the tab, for a build that has no viewer.
 */
/**
 * Why a thread needs you (scenario.ts `needsYouSeed`): one on a dialog, one that finished and said it
 * waits for your reply. The phone's Threads tab and Browse sheet, the desk's cards beside the sidebar,
 * then a tap on the waiting thread, which should land on its last message.
 */
async function needsYou(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const result = await withBench(async (bridge, browser) => {
    const herd = bridge.herd!;
    const ask = "The new copy is ready. Your call: ship it now, or wait for the design review first?";
    await writeJournal(herd.journals.get(herd.idle)!, [["user", "Rewrite the checkout copy"], ["assistant", "Rewriting the checkout copy."], ["assistant", ask]], bridge.now());
    bridge.fake!.appendLines(herd.idle, "", `● ${ask}`, "", "❯ ");
    const shots: string[] = [];
    const seen: Record<string, unknown> = {};
    const shoot = async (page: Page, name: string) => {
      const path = join(outDir, `${name}.png`);
      await page.screenshot({ path, animations: "disabled" });
      shots.push(path);
    };
    const open = async (device: typeof PHONE | typeof DESKTOP) => {
      const context = await browser.newContext({ ...device, timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      await page.clock.install({ time: bridge.now() });
      await page.goto(`${bridge.url}/pane/${encodeURIComponent(herd.working)}`);
      await page.getByPlaceholder("Ask the coordinator…").waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1500);
      return { page, close: () => context.close() };
    };
    const text = (locator: Locator) => locator.innerText().then((t) => t.replace(/\s+/g, " ").trim());
    {
      const { page, close } = await open(PHONE);
      await page.getByRole("tab", { name: /^Threads/ }).click();
      await page.locator(".project-overlay").waitFor({ timeout: 5000 });
      await page.waitForTimeout(300);
      for (const title of ["Checkout copy", "Payments panel"]) seen[`phoneRow ${title}`] = await text(page.locator(".project-overlay .task-main", { hasText: title }).first());
      await shoot(page, "phone-threads");
      await page.locator(".project-overlay .task-main", { hasText: "Checkout copy" }).first().click();
      await page.getByText(ask).last().waitFor({ timeout: 10_000 });
      await page.waitForTimeout(800);
      seen.phoneTapLandsOn = decodeURIComponent(new URL(page.url()).pathname);
      seen.phoneLastMessageInView = await page.getByText(ask).last().isVisible();
      await shoot(page, "phone-tap-waiting");
      await close();
    }
    {
      // The tab bar's Search holds the project tree under its box until something is typed.
      const { page, close } = await open(PHONE);
      await page.goto(`${bridge.url}/`);
      await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Search" }).click();
      const project = page.locator('[role=dialog] button[aria-label="Demo shop tasks"]');
      if (await project.count() && !(await page.locator('[role=dialog] .nav-tree-row', { hasText: "Checkout copy" }).count())) await project.click();
      await page.waitForTimeout(600);
      for (const title of ["Checkout copy", "Payments panel"]) seen[`phoneSearch ${title}`] = await text(page.locator(".nav-tree-row", { hasText: title }).first()).catch(() => "(not shown)");
      await shoot(page, "phone-search");
      await close();
    }
    {
      const { page, close } = await open(DESKTOP);
      const hide = page.getByRole("button", { name: "Hide project panel" });
      if (await hide.count()) await hide.click();
      await page.waitForTimeout(500);
      for (const title of ["Checkout copy", "Payments panel"]) {
        seen[`deskCard ${title}`] = await text(page.locator('section[aria-label="Threads"] article', { hasText: title }).first()).catch(() => "(no card)");
        seen[`deskSidebar ${title}`] = await text(page.locator(".nav-tree-row", { hasText: title }).first()).catch(() => "(not shown)");
      }
      await shoot(page, "desktop-cards");
      await close();
    }
    return { shots, seen, unexpectedWrites: bridge.fake!.writes() };
  }, CAPTURE_EPOCH, (herd, now) => needsYouSeed(herd, now));
  await writeFile(join(outDir, "needs-you.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (result.unexpectedWrites.length) process.exit(1);
}

async function diffs(before: boolean): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const shots: string[] = [];
  const requests: string[] = [];
  const prs = join(outDir, "gh-prs.json");
  process.env.NENU_E2E_GH_PRS = prs;
  let size = { additions: 0, deletions: 0 };
  const result = await withBench(async (bridge, browser) => {
    const open = async (device: typeof PHONE | typeof DESKTOP, path: string, ready: string, colorScheme: "dark" | "light" = "dark") => {
      const context = await browser.newContext({ ...device, colorScheme, timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      page.on("request", (request) => { if (request.url().includes("/diff")) requests.push(new URL(request.url()).pathname + new URL(request.url()).search); });
      await page.clock.install({ time: bridge.now() });
      await page.goto(bridge.url + path);
      await page.locator(ready).first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1200);
      return { page, close: () => context.close() };
    };
    const shoot = async (page: Page, name: string) => {
      const path = join(outDir, `${name}.png`);
      await page.screenshot({ path, animations: "disabled" });
      shots.push(path);
    };
    const viewer = async (page: Page, name: string, file?: string, from: Page | Locator = page) => {
      await from.getByRole("button", { name: /^View changes/ }).first().click();
      const dialog = page.getByRole("dialog", { name: "PR #1342 changes" });
      await dialog.getByText(/^\d+ files?$/).waitFor({ timeout: 15_000 });
      if (file) await dialog.getByRole("button", { name: new RegExp(file) }).click();
      await page.waitForTimeout(400);
      await shoot(page, name);
      return dialog;
    };
    const chat = `/pane/${encodeURIComponent(bridge.herd!.working)}`;
    const bar = 'text="#1342"';

    for (const [name, device] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
      const { page, close } = await open(device, chat, bar);
      await shoot(page, `bar-${name}`);
      if (!before) await viewer(page, `viewer-${name}`, "app/checkout\\.tsx");
      await close();
    }
    {
      const { page, close } = await open(DESKTOP, chat, bar);
      await page.getByRole("tab", { name: "PRs" }).click();
      await page.waitForTimeout(400);
      await shoot(page, "prs-tab-desktop");
      if (!before) await viewer(page, "viewer-from-prs-tab-desktop", "app/cart\\.ts", page.getByRole("tabpanel", { name: "PRs" }));
      await close();
    }
    if (!before) {
      const { page, close } = await open(PHONE, chat, bar, "light");
      await viewer(page, "viewer-phone-light", "app/checkout\\.tsx");
      await close();
      growDiffRepo(bridge.dir);
      for (const [name, device] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
        const { page, close } = await open(device, chat, bar);
        const dialog = await viewer(page, `truncated-${name}`);
        // Down to where the 1 MB cut fell: the first file past it keeps only its counts.
        await dialog.getByText("Past the size limit").first().waitFor();
        await page.evaluate(() => Array.from(document.querySelectorAll("span")).find((span) => span.textContent?.endsWith("Past the size limit"))?.closest("li")?.previousElementSibling?.scrollIntoView({ block: "start" }), null);
        await page.waitForTimeout(300);
        await shoot(page, `truncated-cut-${name}`);
        await close();
      }
    }
    return { shots, diffRequests: requests, unexpectedWrites: bridge.fake!.writes() };
  }, CAPTURE_EPOCH, (herd, now) => diffOrg(herd, now, size), (dir) => {
    size = seedDiffRepo(dir);
    writeFileSync(prs, JSON.stringify([{
      number: 1342, title: "Landing a 390 px", url: "https://github.com/acme/shop/pull/1342", headRefName: "e2e-demo", baseRefName: "main",
      isDraft: false, reviewDecision: "APPROVED", statusCheckRollup: [], ...size, updatedAt: new Date(CAPTURE_EPOCH).toISOString(),
    }]));
  });
  await writeFile(join(outDir, "diffs.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (result.unexpectedWrites.length) process.exit(1);
}

/**
 * The Artifacts list of a working Claude: a page published on claude.ai, a designboard and a report
 * the agent linked, one image it showed from its folder and two it named from a folder beyond it.
 * Every tab is captured on a phone (dark and light) and a desk; `thumbnails` lists what each image
 * card loaded, so a grey card cannot pass for a picture.
 */
async function artifacts(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const vault = await mkdtemp(join(tmpdir(), "nenu-e2e-vault-"));
  const shots: string[] = [];
  const thumbnails: Record<string, Array<{ src: string; loaded: boolean }>> = {};
  try {
    const result = await withBench(async (bridge, browser) => {
      const pane = bridge.herd!.working;
      const now = bridge.now();
      const picture = await Bun.file(join(import.meta.dir, "../../web/public/nenu-pwa-192x192.png")).bytes();
      const files: Record<string, string | Uint8Array> = {
        [join(bridge.dir, "shots/checkout-after.png")]: picture,
        [join(bridge.dir, "reports/test-report.md")]: "# Test report\n\nAll 48 checkout tests pass.\n",
        [join(bridge.dir, "design/checkout-redesign.html")]: `<!doctype html><title>Checkout redesign</title><script id="canvas-doc" type="application/json">${JSON.stringify({ title: "Checkout redesign", files: { "cart.html": "<p>Cart</p>", "checkout.html": "<p>Checkout</p>", "empty.html": "<p>Empty cart</p>" } })}</script>`,
        [join(vault, "attachments/9e7b9700d186.png")]: picture,
        [join(vault, "attachments/de324ccf677a.png")]: picture,
      };
      for (const [path, body] of Object.entries(files)) {
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, body);
      }
      await appendJournal(bridge.herd!.journals.get(pane)!, [
        ["user", "Redesign the checkout and show me how it looks."],
        ["assistant", [
          "The redesign is on the board: [Checkout redesign](design/checkout-redesign.html). Tests are in [test-report.md](reports/test-report.md).",
          "![Checkout after](shots/checkout-after.png)",
          `For the copy I followed the two references in ${join(vault, "attachments/9e7b9700d186.png")} and ${join(vault, "attachments/de324ccf677a.png")}.`,
        ].join("\n\n")],
      ], now - 120_000);
      const activity = { available: true, sessionKey: "bench", workflows: [], tasks: [], truncated: false,
        artifacts: [{ id: "a1", url: "https://claude.ai/artifact/00000000-0000-4000-8000-000000000001", title: "Checkout review notes", at: now - 300_000 }] };
      for (const [name, device, colorScheme] of [["phone", PHONE, "dark"], ["desktop", DESKTOP, "dark"], ["phone-light", PHONE, "light"]] as const) {
        const context = await browser.newContext({ ...device, colorScheme, timezoneId: "UTC", locale: "en-US" });
        const page = await context.newPage();
        await page.clock.install({ time: now });
        await page.route("**/api/pane/*/activity*", (route) => route.fulfill({ json: activity }));
        await page.goto(`${bridge.url}/pane/${encodeURIComponent(pane)}`);
        await page.getByRole("textbox").first().waitFor({ timeout: 15_000 });
        await page.waitForTimeout(1200);
        await page.getByRole("button", { name: "Conversation actions" }).click();
        await page.getByRole("button", { name: "Artifacts and files" }).click();
        const sheet = page.getByRole("dialog", { name: "Artifacts and files" });
        await sheet.waitFor({ timeout: 10_000 });
        const tabs = await page.evaluate(() => Array.from(document.querySelectorAll('[role="dialog"] [aria-label="File type"] button'), (button) => button.textContent ?? ""), null);
        for (const tab of tabs) {
          const label = tab.split(" ·")[0]!;
          await sheet.getByRole("group", { name: "File type" }).getByRole("button", { name: new RegExp(`^${label}`) }).click();
          await page.waitForTimeout(1500);
          thumbnails[`${name}-${label}`] = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLImageElement>('[role="dialog"] img'),
            (image) => ({ src: image.src, loaded: image.naturalWidth > 0 && !image.hidden })), null);
          const path = join(outDir, `${label.toLowerCase()}-${name}.png`);
          await page.screenshot({ path, animations: "disabled" });
          shots.push(path);
        }
        // The way to an image beyond the folder: the row, then the confirmation it asks for.
        if (name !== "phone-light" && tabs.some((tab) => tab.startsWith("Artifacts"))) {
          await sheet.getByRole("group", { name: "File type" }).getByRole("button", { name: /^Artifacts/ }).click();
          const outside = sheet.getByRole("button", { name: /named outside the pane's folder/ });
          if (await outside.waitFor({ timeout: 5_000 }).then(() => true, () => false)) {
            await outside.click();
            await page.waitForTimeout(300);
            const listed = join(outDir, `outside-list-${name}.png`);
            await page.screenshot({ path: listed, animations: "disabled" });
            await sheet.getByRole("button", { name: "Open 9e7b9700d186.png" }).click();
            await page.getByRole("dialog", { name: "Open this file outside Nenu's preview?" }).waitFor({ timeout: 5_000 });
            await page.waitForTimeout(800);
            const confirm = join(outDir, `outside-confirm-${name}.png`);
            await page.screenshot({ path: confirm, animations: "disabled" });
            shots.push(listed, confirm);
          }
        }
        await context.close();
      }
      return { shots, thumbnails, unexpectedWrites: bridge.fake!.writes() };
    }, CAPTURE_EPOCH);
    await writeFile(join(outDir, "artifacts.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    if (result.unexpectedWrites.length) process.exit(1);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
}

/** Every way a chat hands over a file, followed for real: taps, new tabs, the lists, the confirmed Open and what the bridge refuses. */
async function files(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const checks = await withBench((bridge, browser) => filesBench(bridge, browser, outDir), CAPTURE_EPOCH);
  await writeFile(join(outDir, "files.json"), JSON.stringify(checks, null, 2));
  for (const c of checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}${c.ok || !c.detail ? "" : `  (${c.detail})`}`);
  if (checks.some((c) => !c.ok)) process.exit(1);
}

/**
 * Home over a neutral project (homeOrg) and two pull requests from GitHub, one on the working pane's
 * branch and one on a branch no pane is on: phone and desk, dark and light, then each list the
 * Recents / Workspaces control offers (when the build has it), then a phone's requests on Home over
 * `--seconds`, after a 5 s warm-up. Last, Claude's PermissionRequest hook reaches the bridge as an
 * installed hook delivers it, so the blocked pane's command is known whole, and a desk answers Yes
 * from Needs you: the key the fake terminal got, and the requests from the tap to that key.
 */
/** A GitHub pull request as `gh pr list --json` prints it, from its number, title and what GitHub says of it. */
function ghPr(number: number, title: string, at: string, extra: { review?: string; checks?: string[]; draft?: boolean; additions?: number; deletions?: number; branch?: string } = {}) {
  return {
    number, title, url: `https://github.com/acme/shop/pull/${number}`, headRefName: extra.branch ?? `acme-${number}`, baseRefName: "main",
    isDraft: extra.draft ?? false, reviewDecision: extra.review ?? "REVIEW_REQUIRED",
    statusCheckRollup: (extra.checks ?? ["SUCCESS", "SUCCESS", "SUCCESS"]).map((state) => ({ state })),
    additions: extra.additions ?? 40 + number, deletions: extra.deletions ?? number % 17, updatedAt: at,
  };
}

/**
 * Home as a busy operator sees it: a project, four workspaces with several tabs each, a dozen pull
 * requests in every state, first with nothing waiting on you, then with a dialog and a thread waiting
 * for your reply. Captures, each list, the requests a phone on Home makes per minute, and a dialog
 * answered from Home.
 */
async function home(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const prs = join(outDir, "gh-prs.json");
  process.env.NENU_E2E_GH_PRS = prs;
  let size = { additions: 0, deletions: 0 };
  const windowMs = Number(values.seconds) * 1000;
  const result = await withBench(async (bridge, browser) => {
    const shots: string[] = [];
    const fake = bridge.fake!;
    const herd = bridge.herd!;
    // More workspaces, each with several tabs: "docs" runs two agents and, in the project's folder, the
    // thread that will wait for a reply.
    fake.addWorkspace("w3", "docs").addTab("w3:t1", "outline").addTab("w3:t2", "examples").addTab("w3:t3", "copy")
      .addPane({ paneId: "w3:outline", workspaceId: "w3", tabId: "w3:t1", agent: "claude", label: "Docs outline", cwd: "/tmp" })
      .addPane({ paneId: "w3:examples", workspaceId: "w3", tabId: "w3:t2", agent: "codex", label: "API examples", cwd: "/tmp" })
      .addPane({ paneId: "w3:copy", workspaceId: "w3", tabId: "w3:t3", agent: "claude", label: "Checkout copy", cwd: bridge.dir });
    fake.setStatus("w3:outline", "working");
    await addOps(bridge);
    // Nothing needs you first: the dialog is off and no thread waits for a reply.
    fake.setDialog(herd.blocked, null);
    const stopJournal = tickJournal(herd.journals.get(herd.working)!, bridge.now);
    try {
      const open = async (device: typeof PHONE | typeof DESKTOP, colorScheme: "dark" | "light") => {
        const context = await browser.newContext({ ...device, colorScheme, timezoneId: "UTC", locale: "en-US" });
        const page = await context.newPage();
        await page.clock.install({ time: bridge.now() });
        await page.goto(bridge.url + "/");
        // The sessions' control, not a row: with this many sessions a row can sit behind "Show all".
        await page.getByRole("tab", { name: "Recents" }).waitFor({ timeout: 15_000 });
        await page.waitForTimeout(1500);
        return { page, close: () => context.close() };
      };
      const shoot = async (page: Page, name: string) => {
        const path = join(outDir, `${name}.png`);
        await page.screenshot({ path, animations: "disabled" });
        shots.push(path);
      };
      const scrollTo = async (page: Page, selector: string) => {
        await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: "start" }), selector);
        await page.waitForTimeout(300);
      };
      for (const [name, device] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
        const { page, close } = await open(device, "dark");
        await shoot(page, `home-${name}-calm`);
        await close();
      }
      // Then a dialog on the blocked pane, and the docs thread says it waits for your reply.
      fake.setDialog(herd.blocked, herd.dialog);
      const orgFile = join(bridge.dir, "org.json");
      const seed = JSON.parse(await Bun.file(orgFile).text()) as OrgSeed;
      seed.projects[0]!.threads = seed.projects[0]!.threads.map((thread) => thread.id === "t-0015" ? { ...thread, activity: "Waiting for you", percent: 85 } : thread);
      await writeFile(orgFile, JSON.stringify(seed, null, 2));
      const manifest = join(bridge.dir, "projects", seed.projects[0]!.slug, "PROJECT.md");
      await utimes(manifest, new Date(), new Date(Date.now() + 1000));
      for (let i = 0; ; i++) {
        const snap = await fetch(`${bridge.url}/api/snapshot`).then((r) => r.json() as Promise<{ agents: Array<{ status: string }>; projects?: Array<{ threads: Array<{ id: string; selfWaiting?: true }> }> }>);
        if (snap.projects?.[0]?.threads.some((t) => t.id === "t-0015" && t.selfWaiting) && snap.agents.some((a) => a.status === "blocked")) break;
        if (i > 300) throw new Error("the reply thread never read as waiting");
        await sleep(100);
      }
      for (const [name, device] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
        for (const scheme of ["dark", "light"] as const) {
          const { page, close } = await open(device, scheme);
          await shoot(page, `home-${name}-${scheme}`);
          // The list itself, scrolled into view: the tabs' control, else the older "Recent".
          await scrollTo(page, '[role="tablist"][aria-label="Your work"], #home-recent');
          await shoot(page, `home-${name}-${scheme}-list`);
          if (scheme === "dark") {
            // The pull requests: the PRs tab of the sessions' switcher, or the section they were before it.
            const prsTab = page.getByRole("tab", { name: "PRs" });
            const tabbed = (await prsTab.count()) > 0;
            if (tabbed) await prsTab.click();
            await scrollTo(page, tabbed ? '[role="tablist"][aria-label="Your work"]' : "#home-review");
            await shoot(page, `home-${name}-prs`);
            if (tabbed) await page.getByRole("tab", { name: "Recents" }).click();
            const workspaces = page.getByRole("tab", { name: "Workspaces" });
            if (await workspaces.count()) {
              await workspaces.click();
              await scrollTo(page, '[role="tablist"][aria-label="Your work"]');
              await shoot(page, `home-${name}-workspaces`);
              const docs = page.locator("main").getByRole("button", { name: /^docs,/ });
              if (await docs.count()) {
                await docs.first().click();
                await page.waitForTimeout(400);
                await shoot(page, `home-${name}-workspace-open`);
              }
              await page.getByRole("tab", { name: "Recents" }).click();
            }
            if (name === "phone") {
              // Search before anything is typed: the project tree, the sessions and the host under its box.
              await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Search" }).click();
              await page.waitForTimeout(600);
              await shoot(page, "home-phone-search");
              await page.keyboard.press("Escape");
            }
          }
          await close();
        }
      }
      const phone = await phonePage(browser);
      await phone.page.goto(bridge.url + "/");
      await sleep(5000);
      const from = Date.now();
      await sleep(windowMs);
      const http = tally(phone.requests.filter((r) => r.at >= from).map((r) => r.url));
      await phone.close();

      const token = crypto.randomUUID();
      await writeFile(join(bridge.dir, "state", CLAUDE_HOOK_TOKEN_FILE), token);
      const hook = await fetch(bridge.url + CLAUDE_HOOK_PATH, {
        method: "POST", headers: { "content-type": "application/json", [CLAUDE_HOOK_TOKEN_HEADER]: token },
        // The snapshot keeps Claude's session id to the bridge; the demo journal is named after it.
        body: JSON.stringify({ hook_event_name: "PermissionRequest", session_id: basename(herd.journals.get(herd.blocked)!, ".jsonl"),
          tool_name: "Bash", tool_input: { command: "mkfifo fixture-fifo" } }),
      });
      if (hook.status !== 204) throw new Error(`the hook was refused: ${hook.status}`);
      const { page, close } = await open(DESKTOP, "dark");
      const requests: Array<{ url: string; at: number }> = [];
      page.on("request", (req) => requests.push({ url: req.url(), at: Date.now() }));
      const yes = page.getByRole("region", { name: /^Needs you/ }).getByRole("button", { name: "Yes", exact: true });
      await yes.waitFor({ timeout: 15_000 });
      await shoot(page, "home-desktop-answer");
      const t0 = Date.now();
      await yes.click();
      while (fake.answered.length === 0 && Date.now() - t0 < 15_000) await sleep(5);
      const answer = fake.answered[0];
      if (!answer) throw new Error("the answer from Home never reached the fake terminal");
      await page.getByText(/^Approved/).first().waitFor({ timeout: 15_000 });
      await shoot(page, "home-desktop-answered");
      await close();
      const phoneAsk = await open(PHONE, "dark");
      await shoot(phoneAsk.page, "home-phone-after-answer");
      await phoneAsk.close();
      // The one write this run drives: the dialog's key on the blocked pane.
      const unexpectedWrites = fake.writes().filter((c) => !(c.method === "pane.send_keys" && c.params.pane_id === herd.blocked));
      return {
        shots, windowSeconds: windowMs / 1000,
        homeRequestsPerMinute: Math.round(sum(http) * 60_000 / windowMs), byRoute: perMinute(http, windowMs),
        answerFromHome: { pane: answer.paneId, key: answer.key, tapToKeyMs: answer.at - t0, byRouteToKey: tally(requests.filter((r) => r.at >= t0 && r.at <= answer.at).map((r) => r.url)) },
        unexpectedWrites,
      };
    } finally {
      stopJournal();
    }
  }, CAPTURE_EPOCH, (herd, now) => {
    const seed = homeOrg(herd, now, size);
    const project = seed.projects[0]!;
    const sibling = project.threads.find((thread) => thread.id === "t-0014")!;
    project.threads.push({ ...sibling, id: "t-0015", title: "Checkout copy", group: "waiting-on-you", group_label: "waiting-on-you", workspace_id: "w3", tab_id: "w3:t3", pane_id: "w3:copy", activity: "" });
    return seed;
  }, (dir) => {
    size = seedDiffRepo(dir);
    const at = new Date(CAPTURE_EPOCH).toISOString();
    const failing = ["SUCCESS", "FAILURE", "SUCCESS"];
    const pending = ["SUCCESS", "PENDING", "PENDING"];
    writeFileSync(prs, JSON.stringify([
      ghPr(42, "Checkout flow", at, { branch: "e2e-demo", checks: [], ...size }),
      ghPr(39, "Refresh the docs", at, { review: "APPROVED", additions: 18, deletions: 4 }),
      ghPr(44, "Coupon codes at checkout", at, { review: "APPROVED" }),
      ghPr(54, "Bump dependencies", at, { review: "APPROVED", additions: 212, deletions: 198 }),
      ghPr(45, "Order export to CSV", at),
      ghPr(46, "Inventory sync retries", at, { checks: failing }),
      ghPr(47, "Faster product search", at, { checks: pending }),
      ghPr(48, "Gift cards", at, { review: "CHANGES_REQUESTED" }),
      ghPr(49, "Shipping rates by zone", at),
      ghPr(50, "Admin audit log", at, { draft: true, checks: pending }),
      ghPr(51, "Tax rules for the EU", at),
      ghPr(52, "Dark mode for the admin", at, { review: "APPROVED", checks: failing }),
      ghPr(53, "Remove the legacy cart", at, { additions: 3, deletions: 640 }),
    ]));
  });
  await writeFile(join(outDir, "home.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (result.unexpectedWrites.length) process.exit(1);
}

/** The bench folder also holds the test bridge's own files: git leaves them out, and the agent has one new file. */
function benchRepo(dir: string): void {
  writeFileSync(join(dir, ".git/info/exclude"), "/*\n!/app/\n!/docs/\n");
  writeFileSync(join(dir, "app/coupon.test.ts"), "test(\"applies a coupon\", () => {});\n");
}

/**
 * A session on a desk with its Inspector (homeOrg, PR #42 on the working pane's branch): phone and
 * desk captures, then, when the build has one, each tab, the folded panel, the project behind ⋯, a
 * session switch, light, and the shell pane, which has no PR. `requests` lists what each step asked
 * the bridge beyond the snapshot and the chat's own reads, so a tab that loads unseen shows up.
 */
async function inspector(before: boolean): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const prs = join(outDir, "gh-prs.json");
  process.env.NENU_E2E_GH_PRS = prs;
  let size = { additions: 0, deletions: 0 };
  const steps: Record<string, string[]> = {};
  const result = await withBench(async (bridge, browser) => {
    const shots: string[] = [];
    const herd = bridge.herd!;
    let log: string[] = [];
    // Every read but the app-wide polls, so a tab that loads unseen shows up beside the chat's own reads.
    const polls = /^\/api\/(snapshot|events|version|update)|\/(queue|subagents|interactions)$/;
    const open = async (device: typeof PHONE | typeof DESKTOP, paneId: string, colorScheme: "dark" | "light" = "dark") => {
      log = [];
      const context = await browser.newContext({ ...device, colorScheme, timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname.startsWith("/api/") && !polls.test(url.pathname)) log.push(decodeURIComponent(url.pathname + url.search).replace(paneId, ":id"));
      });
      await page.clock.install({ time: bridge.now() });
      await page.goto(bridge.url + `/pane/${encodeURIComponent(paneId)}`);
      await page.getByRole("textbox").first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1500);
      return { page, close: () => context.close() };
    };
    const shoot = async (page: Page, name: string) => {
      const path = join(outDir, `${name}.png`);
      await page.screenshot({ path, animations: "disabled" });
      shots.push(path);
    };
    const step = async (name: string, page: Page, act?: () => Promise<unknown>) => {
      log = [];
      await act?.();
      await page.waitForTimeout(1200);
      steps[name] = log;
      await shoot(page, name);
    };
    const panel = (page: Page) => page.getByRole("complementary", { name: "Session panel" });

    for (const [name, device, paneId] of [["phone-session", PHONE, herd.working], ["phone-shell", PHONE, herd.shell], ["desktop-session", DESKTOP, herd.working]] as const) {
      const { page, close } = await open(device, paneId);
      steps[name] = log;
      await shoot(page, name);
      await close();
    }
    if (!before) {
      const { page, close } = await open(DESKTOP, herd.working);
      steps["desktop-changes-open"] = log;
      // A project's session opens its panel on Overview (ADR 0101); Changes is the next tab.
      await panel(page).getByRole("tab", { name: /Changes/ }).click();
      await panel(page).getByRole("button", { name: /app\/checkout\.tsx/ }).click();
      await step("desktop-changes", page);
      await step("desktop-uncommitted", page, () => panel(page).getByRole("radio", { name: "Uncommitted" }).click());
      await step("desktop-files", page, () => panel(page).getByRole("tab", { name: /Files/ }).click());
      await step("desktop-artifacts", page, () => panel(page).getByRole("radio", { name: "Artifacts" }).click());
      await step("desktop-overview", page, () => panel(page).getByRole("tab", { name: /^Overview/ }).click());
      await step("desktop-closed", page, () => page.keyboard.press("Meta+Alt+KeyB"));
      await step("desktop-reopened", page, () => page.getByRole("button", { name: "Show session panel" }).click());
      await step("desktop-switched", page, () => page.goto(bridge.url + `/pane/${encodeURIComponent(herd.blocked)}`));
      await close();
      for (const [name, paneId, scheme] of [["desktop-light", herd.working, "light"], ["desktop-shell", herd.shell, "dark"]] as const) {
        const view = await open(DESKTOP, paneId, scheme);
        steps[name] = log;
        await shoot(view.page, name);
        await view.close();
      }
    }
    return { shots, requests: steps, unexpectedWrites: bridge.fake!.writes() };
  }, CAPTURE_EPOCH, (herd, now) => homeOrg(herd, now, size), (dir) => {
    size = seedDiffRepo(dir);
    benchRepo(dir);
    writeFileSync(prs, JSON.stringify([
      { number: 42, title: "Checkout flow", url: "https://github.com/acme/shop/pull/42", headRefName: "e2e-demo", baseRefName: "main",
        isDraft: false, reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: [], ...size, updatedAt: new Date(CAPTURE_EPOCH).toISOString() },
    ]));
  });
  // A pane with no pull request: GitHub lists none, and the shell is in no project.
  writeFileSync(prs, "[]");
  const bare = before ? undefined : await withBench(async (bridge, browser) => {
    const context = await browser.newContext({ ...DESKTOP, colorScheme: "dark", timezoneId: "UTC", locale: "en-US" });
    const page = await context.newPage();
    await page.clock.install({ time: bridge.now() });
    await page.goto(bridge.url + `/pane/${encodeURIComponent(bridge.herd!.shell)}`);
    await page.getByRole("complementary", { name: "Session panel" }).getByText(/files? ·/).first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(800);
    const path = join(outDir, "desktop-no-pr.png");
    await page.screenshot({ path, animations: "disabled" });
    await context.close();
    return { shots: [path], unexpectedWrites: bridge.fake!.writes() };
  }, CAPTURE_EPOCH, (herd, now) => homeOrg(herd, now, size), (dir) => { seedDiffRepo(dir); benchRepo(dir); });
  if (bare) Object.assign(result, { shots: [...result.shots, ...bare.shots], unexpectedWrites: [...result.unexpectedWrites, ...bare.unexpectedWrites] });
  await writeFile(join(outDir, "inspector.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (result.unexpectedWrites.length) process.exit(1);
}

/**
 * The Terminal tab on a desk and the + menu on both: captures, how often the bridge reads the open pane
 * with the panel on Changes and on Terminal (it watches only a mirror on screen, ADR 0058), arming
 * and disarming Type into terminal from the tab, and the key queue's discard confirm.
 */
async function terminal(before: boolean): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const result = await withBench(async (bridge, browser) => {
    const herd = bridge.herd!;
    const fake = bridge.fake!;
    const shots: string[] = [];
    const seen: Record<string, unknown> = {};
    const open = async (device: typeof PHONE | typeof DESKTOP, path: string, colorScheme: "dark" | "light" = "dark") => {
      const context = await browser.newContext({ ...device, colorScheme, timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      const streams: string[] = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname === "/api/events") streams.push(decodeURIComponent(url.search) || "(no watch)");
      });
      await page.clock.install({ time: bridge.now() });
      await page.goto(bridge.url + path);
      await page.waitForTimeout(1500);
      return { page, streams, close: () => context.close() };
    };
    const shoot = async (page: Page, name: string) => {
      const path = join(outDir, `${name}.png`);
      await page.screenshot({ path, animations: "disabled" });
      shots.push(path);
    };
    // The bridge's reads of the open pane over five seconds: a handful from its own poll, many more
    // while a browser watches the pane's screen.
    const reads = async (page: Page) => {
      const from = fake.calls.length;
      await page.waitForTimeout(5000);
      return fake.calls.slice(from).filter((call) => call.method === "pane.read" && call.params.pane_id === herd.working).length;
    };
    const text = (locator: Locator) => locator.innerText().then((t) => t.replace(/\s+/g, " ").trim());
    const chat = `/pane/${encodeURIComponent(herd.working)}`;

    {
      const { page, close } = await open(PHONE, chat);
      await page.getByRole("button", { name: "Message actions" }).click();
      await page.waitForTimeout(400);
      seen.phoneMenu = await text(page.getByRole("dialog", { name: "Message actions" }));
      await shoot(page, "phone-menu");
      // The phone keeps its Keys dock whatever the desk does.
      await page.getByRole("dialog", { name: "Message actions" }).getByRole("button", { name: "Keys" }).click();
      await page.waitForTimeout(400);
      await shoot(page, "phone-keys");
      await close();
    }
    const desk = await open(DESKTOP, chat);
    const { page } = desk;
    const panel = page.getByRole("complementary", { name: "Session panel" });
    await panel.waitFor({ timeout: 15_000 });
    seen.changesReads = await reads(page);
    seen.changesStreams = [...desk.streams];
    await shoot(page, "desktop-changes");
    await page.getByRole("button", { name: "Message actions" }).click();
    await page.waitForTimeout(400);
    seen.deskMenu = await text(page.getByRole("dialog", { name: "Message actions" }));
    await shoot(page, "desktop-menu");
    await page.keyboard.press("Escape");
    if (!before) {
      const terminalTab = panel.getByRole("tab", { name: /Terminal/ });
      await terminalTab.click();
      seen.terminalReads = await reads(page);
      seen.terminalStreams = [...desk.streams];
      await shoot(page, "desktop-terminal");

      // What the tab holds besides the mirror: the switch, and no keyboard of its own.
      seen.tabKeyButtons = await panel.getByRole("button", { name: /^(Esc|Ctrl C|Presets|F keys)$/ }).count();
      seen.tabQuickRepliesNote = await panel.getByText(/Quick replies stay on the phone/).count();

      const toggle = panel.getByRole("switch", { name: /Type into terminal/ });
      await toggle.click();
      await page.waitForTimeout(400);
      seen.armedStrip = await page.getByText("Typing into terminal").count();
      seen.armedSwitch = await toggle.getAttribute("aria-checked");
      // The desk's own keyboard while armed: each key pressed, and what reached the pane for it.
      const physical: Record<string, string[]> = {};
      for (const key of ["Escape", "Control+c", "Control+d", "Control+l", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab", "Shift+Tab", "Enter", "Backspace", "F5", "x"]) {
        const from = fake.calls.length;
        await page.keyboard.press(key);
        await page.waitForTimeout(300);
        physical[key] = fake.calls.slice(from).filter((call) => call.method === "pane.send_keys" && call.params.pane_id === herd.working)
          .flatMap((call) => call.params.keys as string[]);
      }
      seen.physicalKeys = physical;
      seen.stillArmed = await toggle.getAttribute("aria-checked");
      await shoot(page, "desktop-terminal-armed");
      await panel.getByRole("tab", { name: /Changes/ }).click();
      await page.waitForTimeout(600);
      seen.stripAfterLeavingTab = await page.getByText("Typing into terminal").count();
      seen.changesAgainReads = await reads(page);
    }
    await desk.close();
    if (!before) {
      const { page, close } = await open(DESKTOP, chat, "light");
      await page.getByRole("complementary", { name: "Session panel" }).getByRole("tab", { name: /Terminal/ }).click();
      await page.waitForTimeout(1200);
      await shoot(page, "desktop-terminal-light");
      await close();
    }
    // The only writes this drives are the keys typed while armed, into the working pane.
    const unexpectedWrites = fake.writes().filter((call) => !(call.method === "pane.send_keys" && call.params.pane_id === herd.working));
    return { shots, seen, writes: fake.writes().length, unexpectedWrites };
  }, CAPTURE_EPOCH);
  await writeFile(join(outDir, "terminal.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (result.unexpectedWrites.length) process.exit(1);
}

/**
 * Page motion (web/src/lib/motion.ts). Counts document.startViewTransition calls in the page, so a poll
 * that starts one shows up; steps each transition frame by frame by pausing its animations; and times
 * a tap to the next page in the DOM and on screen. `--before` runs the same flows on a build without
 * motion, opening a notification the way the service worker did then (a full navigation).
 */
async function motion(before: boolean): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const windowMs = Number(values.seconds) * 1000;
  // The tab's CPU while quiet is the browser's: the Playwright browser this run launched (a descendant of
  // this process) and its helpers (web content, GPU, network), which launchd parents, so they are told
  // from another bench's by starting within seconds of ours. Only processes alive at both ends count.
  const ps = async () => {
    const out = await new Response(Bun.spawn(["ps", "-axo", "pid=,ppid=,lstart=,comm="]).stdout).text();
    return out.split("\n").map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ [\d:]+ \d{4}) (.*)$/)).filter((m) => m !== null)
      .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), started: Date.parse(m[3]!), command: m[4]! }));
  };
  const ourBrowser = async () => {
    const all = await ps();
    const mine = new Set([process.pid]);
    for (let grew = true; grew;) {
      grew = false;
      for (const proc of all) if (!mine.has(proc.pid) && mine.has(proc.ppid)) { mine.add(proc.pid); grew = true; }
    }
    const main = all.find((proc) => mine.has(proc.pid) && proc.command.includes("ms-playwright/") && /\/(Playwright|Chromium|chrome)$/.test(proc.command));
    if (!main) return [];
    const dir = main.command.match(/ms-playwright\/[^/]+/)![0];
    return all.filter((proc) => proc.pid === main.pid
      || (proc.ppid === 1 && proc.command.includes(dir) && proc.started >= main.started - 1000 && proc.started <= main.started + 10_000));
  };
  const quietCpu = async (page: Page, seconds: number) => {
    const ours = await ourBrowser();
    const start = await Promise.all(ours.map((proc) => cpuMs(proc.pid)));
    const calls0 = await page.evaluate(() => (window as unknown as { __motion: { calls: number } }).__motion.calls, null);
    await sleep(seconds * 1000);
    const calls1 = await page.evaluate(() => (window as unknown as { __motion: { calls: number } }).__motion.calls, null);
    const alive = new Set((await ps()).map((proc) => proc.pid));
    const end = await Promise.all(ours.map((proc) => alive.has(proc.pid) ? cpuMs(proc.pid) : Promise.resolve(Number.NaN)));
    const cpu = end.reduce((acc, ms, i) => Number.isNaN(ms) ? acc : acc + ms - start[i]!, 0);
    return {
      seconds, transitions: calls1 - calls0, browserCpuMs: cpu, browserCpuPercent: Math.round((cpu / (seconds * 1000)) * 1000) / 10,
      processes: ours.map((proc, i) => `${proc.command.split("/").pop()} ${Number.isNaN(end[i]!) ? "gone" : end[i]! - start[i]!}ms`),
    };
  };
  const result = await withBench(async (bridge, browser) => {
    const herd = bridge.herd!;
    const stopJournal = tickJournal(herd.journals.get(herd.working)!, bridge.now);
    const shots: string[] = [];
    const out: Record<string, unknown> = { before, browser: "WebKit (playwright-core 1.60.0, webkit-2287)" };
    // In the page: count every startViewTransition, and when `hold` is set pause its animations once they
    // start, so the bench can seek them to any point and capture that frame.
    const instrument = () => {
      const w = window as unknown as { __motion: { calls: number; hold: boolean; paused: Animation[] | null; last: { finished: Promise<void> } | null } };
      w.__motion = { calls: 0, hold: false, paused: null, last: null };
      const native = Document.prototype.startViewTransition;
      if (!native) return;
      Document.prototype.startViewTransition = function (this: Document, arg?: ViewTransitionUpdateCallback | StartViewTransitionOptions) {
        w.__motion.calls++;
        const transition = native.call(this, arg as ViewTransitionUpdateCallback);
        w.__motion.last = transition;
        if (w.__motion.hold) void transition.ready.then(() => {
          const running = document.getAnimations().filter((a) => (a.effect as KeyframeEffect | null)?.pseudoElement?.startsWith("::view-transition"));
          for (const animation of running) animation.pause();
          w.__motion.paused = running;
        }, () => {});
        return transition;
      };
    };
    const open = async (device: typeof PHONE | typeof DESKTOP, reducedMotion: "reduce" | "no-preference", path = "/") => {
      const context = await browser.newContext({ ...device, reducedMotion, timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      await page.addInitScript(instrument, null);
      await page.goto(bridge.url + path);
      await page.locator("main").getByText("Working Claude").first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1200);
      return { page, close: () => context.close() };
    };
    const shoot = async (page: Page, name: string) => {
      const path = join(outDir, `${name}.png`);
      await page.screenshot({ path });
      shots.push(path);
    };
    const paneHref = (id: string) => `/pane/${encodeURIComponent(id)}`;
    // What each step waits for: the next page's path and its own marker, in the DOM. Data, not code: the
    // app's CSP refuses string evaluation, so the page tests it with `arrived`.
    type Target = { path: string; marker: string };
    const isPane = (href: string): Target => ({ path: href, marker: "textarea" });
    const isHome: Target = { path: "/", marker: '[role="tablist"][aria-label="Your work"], #home-recent' };
    const isSettings: Target = { path: "/settings", marker: "main" };
    const arrived = (t: Target) => location.pathname === t.path && document.querySelector(t.marker) !== null;
    const reach = (page: Page, t: Target) => page.waitForFunction(arrived, t, { timeout: 15_000 });

    /** Run `act`, then capture the transition it starts at 0, 25, 50, 75 and 100 %, or (none) the cut. */
    const frames = async (page: Page, name: string, act: () => Promise<void>, done: Target) => {
      await page.evaluate(() => { const m = (window as unknown as { __motion: { hold: boolean; paused: unknown } }).__motion; m.hold = true; m.paused = null; }, null);
      const calls0 = await page.evaluate(() => (window as unknown as { __motion: { calls: number } }).__motion.calls, null);
      await shoot(page, `${name}-0-start`);
      await act();
      const deadline = Date.now() + 3000;
      let held = false;
      while (Date.now() < deadline) {
        held = await page.evaluate(() => (window as unknown as { __motion: { paused: unknown } }).__motion.paused !== null, null);
        if (held) break;
        await sleep(20);
      }
      const steps: Array<{ at: number; transforms: string[] }> = [];
      if (held) {
        for (const at of [0, 0.25, 0.5, 0.75, 1]) {
          const transforms = await page.evaluate((p: number) => {
            const running = (window as unknown as { __motion: { paused: Animation[] } }).__motion.paused;
            for (const a of running) a.currentTime = p * Number(a.effect!.getComputedTiming().endTime);
            return running.map((a) => `${(a.effect as KeyframeEffect).pseudoElement}: ${JSON.stringify((a.effect as KeyframeEffect).getKeyframes().map((k) => k.transform ?? null))}`);
          }, at);
          steps.push({ at, transforms });
          await shoot(page, `${name}-${Math.round(at * 100)}`);
        }
        await page.evaluate(() => { for (const a of (window as unknown as { __motion: { paused: Animation[] } }).__motion.paused) a.finish(); }, null);
      } else {
        await shoot(page, `${name}-cut`);
      }
      await page.evaluate(() => { (window as unknown as { __motion: { hold: boolean } }).__motion.hold = false; }, null);
      await reach(page, done);
      await page.waitForTimeout(400);
      await shoot(page, `${name}-end`);
      const calls = await page.evaluate(() => (window as unknown as { __motion: { calls: number } }).__motion.calls, null);
      return { transitions: calls - calls0, steps };
    };

    /** Tap → the next page in the DOM (`dom`), on the next frame (`frame`), and settled (`settled`), in ms. */
    const time = async (page: Page, act: () => Promise<void>, done: Target) => {
      await page.evaluate((t: Target) => {
        const w = window as unknown as { __timing: Record<string, number> | null; __motion: { last: { finished: Promise<void> } | null } };
        w.__timing = null;
        w.__motion.last = null;
        const check = () => location.pathname === t.path && document.querySelector(t.marker) !== null;
        addEventListener("click", () => {
          const t0 = performance.now();
          const observer = new MutationObserver(() => {
            if (!check()) return;
            observer.disconnect();
            const dom = performance.now() - t0;
            requestAnimationFrame(() => {
              const frame = performance.now() - t0;
              const settle = w.__motion.last?.finished ?? Promise.resolve();
              void settle.then(() => { w.__timing = { dom, frame, settled: performance.now() - t0 }; }, () => { w.__timing = { dom, frame, settled: performance.now() - t0 }; });
            });
          });
          observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        }, { capture: true, once: true });
      }, done);
      await act();
      await page.waitForFunction(() => (window as unknown as { __timing: unknown }).__timing !== null, null, { timeout: 15_000 });
      return page.evaluate(() => (window as unknown as { __timing: Record<string, number> }).__timing, null);
    };

    const row = (page: Page, text: string) => page.locator("main").getByText(text).first();
    const back = (page: Page) => page.locator('header [aria-label^="Back to"]').first();
    const tabHome = (page: Page) => page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Home" });
    // A tapped notification: the service worker's message to the open app, or (before) its full navigation.
    const notify = (page: Page, href: string) => page.evaluate(({ href, before }: { href: string; before: boolean }) => {
      if (before) location.assign(href);
      else navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "nenu:open", path: href } }));
    }, { href, before });

    try {
      // 1. Each way between pages, on a phone, frame by frame.
      const phone = await open(PHONE, "no-preference");
      const p = phone.page;
      const flows: Record<string, unknown> = {};
      flows.openThread = await frames(p, "phone-open-thread", () => row(p, "Working Claude").click(), isPane(paneHref(herd.working)));
      flows.back = await frames(p, "phone-back", () => back(p).click(), isHome);
      await p.getByRole("button", { name: "Settings" }).first().click();
      await reach(p, isSettings);
      await p.waitForTimeout(600);
      flows.homeFromTabBar = await frames(p, "phone-tab-home", () => tabHome(p).click(), isHome);
      flows.notification = await frames(p, "phone-notification", () => notify(p, paneHref(herd.blocked)), isPane(paneHref(herd.blocked)));
      out.phone = flows;

      // 2. Tap to content, the same flows and the same clock before and after.
      const reps = 8;
      const timings: Record<string, Array<Record<string, number>>> = { openThread: [], back: [] };
      await p.goto(bridge.url + "/");
      await reach(p, isHome);
      for (let i = 0; i < reps; i++) {
        await p.waitForTimeout(500);
        timings.openThread!.push(await time(p, () => row(p, "Working Claude").click(), isPane(paneHref(herd.working))));
        await p.waitForTimeout(500);
        timings.back!.push(await time(p, () => back(p).click(), isHome));
      }
      const summary = (xs: Array<Record<string, number>>, key: string) => {
        const values = xs.map((x) => Math.round(x[key]!));
        return { median: pct(values, 0.5), p90: pct(values, 0.9), all: values };
      };
      out.timing = Object.fromEntries(Object.entries(timings).map(([flow, xs]) =>
        [flow, { dom: summary(xs, "dom"), frame: summary(xs, "frame"), settled: summary(xs, "settled") }]));

      // 3. Quiet: after a browser Back and Forward (the history state that used to replay a transition on
      // every poll), sit on a polling pane and count transitions.
      await row(p, "Working Claude").click();
      await reach(p, isPane(paneHref(herd.working)));
      await p.evaluate(() => history.back(), null);
      await reach(p, isHome);
      await p.evaluate(() => history.forward(), null);
      await reach(p, isPane(paneHref(herd.working)));
      await p.waitForTimeout(1000);
      const requests: string[] = [];
      p.on("request", (req) => requests.push(req.url()));
      const pane = await quietCpu(p, windowMs / 1000);
      out.quiet = { page: paneHref(herd.working), ...pane, requests: tally(requests) };
      // And Home, quiet, reached by the back control.
      await back(p).click();
      await reach(p, isHome);
      await p.waitForTimeout(2000);
      out.quietHome = { page: "/", ...await quietCpu(p, windowMs / 1000) };
      await phone.close();

      // 4. Reduced motion: the same open, which must not move sideways.
      const reduced = await open(PHONE, "reduce");
      out.reduced = await frames(reduced.page, "phone-reduced-open-thread", () => row(reduced.page, "Working Claude").click(), isPane(paneHref(herd.working)));
      await reduced.close();

      // 5. A desk: a Home row, then a sideways pick in the sidebar.
      const desk = await open(DESKTOP, "no-preference");
      const d = desk.page;
      const deskFlows: Record<string, unknown> = {};
      deskFlows.openThread = await frames(d, "desk-open-thread", () => row(d, "Working Claude").click(), isPane(paneHref(herd.working)));
      deskFlows.sidebarPick = await frames(d, "desk-sidebar-pick", () => d.locator(`aside a[href="${paneHref(herd.blocked)}"]`).first().click(), isPane(paneHref(herd.blocked)));
      out.desk = deskFlows;
      await desk.close();
    } finally {
      stopJournal();
    }
    return { ...out, shots, unexpectedWrites: bridge.fake!.writes() };
  }, CAPTURE_EPOCH);
  await writeFile(join(outDir, "motion.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, shots: `${result.shots.length} in ${outDir}` }, null, 2));
}

/**
 * The way back through a project (useGoUp in web/src/lib/motion.ts), phone and desk, three walks: a
 * coordinator under a project that organizes them (demoOrg: project → coordinator → its thread, a
 * sibling, reloads), a project that opens on its own coordinator's chat (projectChatSeed: a thread at its
 * root), and the own coordinator of a project that organizes coordinators (orgTreeSeed: a thread at its root). Each walk taps the
 * app's back until there is none, reaches Home the way a person would (the back, or the desk's bar), and
 * then takes the browser's Back once. Logs path, `history.length` and motion per step, with a capture each.
 */
async function back(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const shots: string[] = [];
  type Walk = { coordinator?: { pane: string; title: string }; thread: { pane: string; title: string }; sibling?: string };
  const walk = async (org: (herd: DemoHerd, now: number) => OrgSeed, name: string, route: (herd: DemoHerd) => Walk) => withBench(async (bridge, browser) => {
    const herd = bridge.herd!;
    const way = route(herd);
    const paneHref = (id: string) => `/pane/${encodeURIComponent(id)}`;
    const run = async (device: typeof PHONE | typeof DESKTOP, kind: string) => {
      const context = await browser.newContext({ ...device, reducedMotion: "no-preference", timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      // The motion each navigation asked for, read where lib/motion.ts sets it, before the transition starts.
      await page.addInitScript(() => {
        const w = window as unknown as { __moves: string[] };
        w.__moves = [];
        const native = Document.prototype.startViewTransition;
        if (!native) return;
        Document.prototype.startViewTransition = function (this: Document, arg?: ViewTransitionUpdateCallback | StartViewTransitionOptions) {
          w.__moves.push(document.documentElement.dataset.motion ?? "?");
          return native.call(this, arg as ViewTransitionUpdateCallback);
        };
      }, null);
      const steps: Array<{ step: string; path: string; len: number; moves: string[]; tab?: string | null; back?: string | null }> = [];
      const log = async (step: string) => {
        await page.waitForTimeout(900);
        const state = await page.evaluate(() => {
          const w = window as unknown as { __moves?: string[] };
          const moves = w.__moves ?? [];
          w.__moves = [];
          const tab = document.querySelector('[role="tablist"][aria-label="Project"] [aria-selected="true"]')?.textContent ?? null;
          const back = Array.from(document.querySelectorAll('header [aria-label^="Back to"]')).find((el) => (el as HTMLElement).offsetParent !== null)?.getAttribute("aria-label") ?? null;
          return { path: location.pathname + location.search, len: history.length, moves, tab, back };
        }, null);
        steps.push({ step, ...state });
        const path = join(outDir, `${name}-${kind}-${String(steps.length).padStart(2, "0")}-${step}.png`);
        await page.screenshot({ path, animations: "disabled" });
        shots.push(path);
      };
      const visibleBack = () => page.locator('header [aria-label^="Back to"] >> visible=true').first();
      // A row by its title where a person would tap it: the phone's Threads tab, else the page or the desk's bar.
      const open = async (title: string) => {
        if (device === PHONE && await page.getByRole("tab", { name: /^Threads/ }).first().isVisible()) {
          await page.getByRole("tab", { name: /^Threads/ }).first().click({ timeout: 5000 });
          await log("threads-tab");
          await page.locator(".project-overlay").getByText(title).first().click({ timeout: 5000 });
        } else {
          const inMain = page.locator(`main >> text="${title}" >> visible=true`).first();
          await (await inMain.isVisible() ? inMain : page.locator(`aside >> text="${title}" >> visible=true`).first()).click({ timeout: 5000 });
        }
      };
      await page.goto(bridge.url + "/");
      await page.locator('a[href="/project/acme"]').first().waitFor({ state: "attached", timeout: 15_000 });
      await log("home");
      const entry = steps[0]!.len;
      // A phone reaches a project through the navigation the mark opens; a desk's bar lists it.
      if (device === PHONE) await page.getByRole("button", { name: "Open navigation" }).first().click({ timeout: 5000 });
      // The navigation's own row: Home's Projects tab links the same project.
      await page.locator('nav[aria-label="Projects and chats"] a[href="/project/acme"] >> visible=true').first().click({ timeout: 5000 });
      await page.waitForFunction(() => /^\/(project\/acme|pane\/)/.test(location.pathname), null, { timeout: 10_000 });
      await log("project");
      if (way.coordinator) {
        // A desk's project opens a coordinator's page on a tap on its card's head (ADR 0109), a phone's
        // on a tap on its row (ADR 0110), and Open chat its chat (ADR 0102).
        if (device === DESKTOP) await page.getByRole("button", { name: `Open ${way.coordinator.title}`, exact: true }).click({ timeout: 5000 });
        else await open(way.coordinator.title);
        await page.waitForURL("**/project/acme/node/**", { timeout: 10_000 });
        await log("coordinator-page");
        await page.locator("main").getByRole("button", { name: "Open chat" }).click({ timeout: 5000 });
        await page.waitForURL(`**${paneHref(way.coordinator.pane)}*`, { timeout: 10_000 });
        await log("coordinator");
        if (device === PHONE) {
          await page.getByRole("tab", { name: /^Threads/ }).click({ timeout: 5000 });
          await page.reload();
          await page.locator('[role="tablist"][aria-label="Project"]').waitFor({ timeout: 10_000 });
          await log("threads-reload");
        }
      }
      await open(way.thread.title);
      await page.waitForURL(`**${paneHref(way.thread.pane)}*`, { timeout: 10_000 });
      await log("thread");
      if (device === PHONE && way.sibling) {
        await open("Panel depósito");
        await page.waitForURL(`**${paneHref(way.sibling)}*`, { timeout: 10_000 });
        await log("sibling");
        await open(way.thread.title);
        await page.waitForURL(`**${paneHref(way.thread.pane)}*`, { timeout: 10_000 });
        await log("sibling-back");
        await page.reload();
        await page.locator("header").first().waitFor({ timeout: 10_000 });
        await log("thread-reload");
      }
      for (let i = 1; i <= 4 && await visibleBack().isVisible(); i++) {
        await visibleBack().click({ timeout: 5000 });
        await log(`app-back-${i}`);
      }
      // A desk's back steps aside where the bar lists the parent: Home is the bar's.
      if (steps.at(-1)!.path !== "/") {
        await page.locator('aside a[href="/"] >> visible=true').first().click({ timeout: 5000 });
        await page.waitForFunction(() => location.pathname === "/", null, { timeout: 10_000 });
        await log("bar-home");
      }
      const home = steps.at(-1)!;
      await page.evaluate(() => history.back(), null);
      await page.waitForTimeout(1200);
      const systemBackFromHome = page.url().replace(bridge.url, "");
      await context.close();
      return { entry, lenAtHome: home.len, entriesAdded: home.len - entry, systemBackFromHome, steps };
    };
    return { phone: await run(PHONE, "phone"), desk: await run(DESKTOP, "desk"), unexpectedWrites: bridge.fake!.writes() };
  }, CAPTURE_EPOCH, org);
  const result = {
    organizer: await walk(demoOrg, "organizer", (herd) => ({
      coordinator: { pane: herd.idle, title: "Rediseño mobile" }, thread: { pane: herd.working, title: "Landing a 390 px" }, sibling: herd.blocked })),
    rootThread: await walk(projectChatSeed, "root", (herd) => ({ thread: { pane: herd.blocked, title: "Panel depósito" } })),
    organizerRoot: await walk((herd, now) => orgTreeSeed(herd, now, { coordinator: true }), "organizer-root", (herd) => ({
      coordinator: { pane: herd.codex, title: "Project coordinator" }, thread: { pane: herd.blocked, title: "Panel depósito" } })),
  };
  await writeFile(join(outDir, "back.json"), JSON.stringify({ ...result, shots }, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

/**
 * The conversation's scroll on a phone while nobody touches it. A long session whose turn keeps running
 * (a call every 1.5 s, its result half a step later), read at the tail, read 1800 px up, typed into,
 * with the keyboard open and closed, paging older messages, through a sheet, and back from Home. In the
 * page every write to the list's scroll position is logged with its stack, and each frame the line
 * the reader was looking at is measured again: a move their own drag does not explain is a jump.
 */
async function scrollProbe(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const probe = () => {
    type Jump = { t: number; label: string; dy: number; dTop: number; dHeight: number; top: number; tail: boolean; text: string; images: number[][] };
    const state = {
      label: "load", input: Number.NEGATIVE_INFINITY, user: 0,
      writes: [] as Array<{ t: number; label: string; kind: string; arg: string; from: number; input: boolean; stack: string }>,
      jumps: [] as Jump[], lost: [] as Array<{ t: number; label: string }>, samples: [] as Array<[number, string, number, number, number]>,
    };
    (window as unknown as { __scroll: typeof state }).__scroll = state;
    const list = () => document.querySelector<HTMLElement>('section[aria-label="Live conversation"] .overflow-y-auto');
    const recent = () => performance.now() - state.input < 300;
    const write = (kind: string, el: Element, arg: unknown) => {
      const scroller = list();
      if (!scroller || !(el === scroller || scroller.contains(el))) return;
      state.writes.push({ t: Math.round(performance.now()), label: state.label, kind, arg: JSON.stringify(arg) ?? "", from: scroller.scrollTop, input: recent(),
        stack: (new Error().stack ?? "").split("\n").slice(2, 10).map((line) => line.trim()).join(" < ") });
    };
    const top = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
    Object.defineProperty(Element.prototype, "scrollTop", { configurable: true, get: top.get, set(this: Element, value: number) { write("scrollTop=", this, value); top.set!.call(this, value); } });
    for (const name of ["scrollTo", "scrollBy", "scrollIntoView"] as const) {
      const native = Element.prototype[name] as (...args: unknown[]) => void;
      (Element.prototype as unknown as Record<string, unknown>)[name] = function (this: Element, ...args: unknown[]) { write(name, this, args[0]); return native.apply(this, args); };
    }
    for (const type of ["wheel", "touchstart", "touchmove", "pointerdown", "keydown"]) addEventListener(type, () => { state.input = performance.now(); }, { capture: true, passive: true });
    let prev: { el: Element; y: number; top: number; height: number; tail: boolean; user: number } | null = null;
    let lastSample = 0;
    // A rAF reads layout before the frame's ResizeObservers run, so a move that comes with a resize may
    // be put right by the app before the frame is painted. Such a move waits for this observer, made
    // after the app's and so run after it, and counts only if it is still there.
    let pending: { jump: Jump; el: Element; y: number; user: number } | null = null;
    let watched: Element | null = null;
    let settle: ResizeObserver | null = null;
    const where = (el: Element, list: HTMLElement) => el.getBoundingClientRect().top - list.getBoundingClientRect().top;
    const confirm = () => {
      const list_ = list();
      if (!pending || !list_) return false;
      const { jump, el, y, user } = pending;
      pending = null;
      const now = el.isConnected ? where(el, list_) + (state.user - user) : Number.NaN;
      if (!(Math.abs(now - y) < 2)) state.jumps.push(jump);
      return true;
    };
    // After the app's observers ran, the line stands where it is painted: measure the next frame from there.
    // A layout the app changes in its own rAF (the keyboard's height) lands after the probe's rAF, so the
    // move is looked for here too.
    const settled = () => {
      // The line this frame's rAF picked was measured before the app's correction: only re-measure it.
      const checked = confirm();
      const el = list();
      if (!prev?.el.isConnected || !el) return;
      const y = where(prev.el, el);
      if (!checked && Math.abs(y + (state.user - prev.user) - prev.y) >= 2) state.jumps.push({ t: Math.round(performance.now()), label: state.label,
        dy: Math.round(y + (state.user - prev.user) - prev.y), dTop: Math.round(el.scrollTop - prev.top), dHeight: el.scrollHeight - prev.height,
        top: Math.round(el.scrollTop), tail: prev.tail, text: (prev.el.textContent ?? "").slice(0, 48), images: [] });
      prev = { ...prev, y, top: el.scrollTop, height: el.scrollHeight, user: state.user };
    };
    const frame = () => {
      confirm();
      const el = list();
      if (el && el !== watched) {
        settle?.disconnect();
        watched = el;
        settle = null;
        setTimeout(() => {
          if (watched !== el) return;
          settle = new ResizeObserver(settled);
          settle.observe(el);
          if (el.firstElementChild) settle.observe(el.firstElementChild);
        }, 100);
      }
      if (el) {
        const box = el.getBoundingClientRect();
        const tail = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
        // The line the reader looked at last frame, measured again: where it went is what they saw move.
        // What the reader's own drag moved since last frame is theirs; the rest of the move is not.
        if (prev) {
          if (!prev.el.isConnected) state.lost.push({ t: Math.round(performance.now()), label: state.label });
          else {
            const y = prev.el.getBoundingClientRect().top - box.top + (state.user - prev.user);
            if (Math.abs(y - prev.y) >= 2) {
              const jump = { t: Math.round(performance.now()), label: state.label, dy: Math.round(y - prev.y),
                dTop: Math.round(el.scrollTop - prev.top), dHeight: el.scrollHeight - prev.height, top: Math.round(el.scrollTop), tail: prev.tail,
                text: (prev.el.textContent ?? "").slice(0, 48),
                // Pictures near the screen, top and height relative to the list's box: what grew, and where.
                images: Array.from(el.querySelectorAll("img"), (img) => [Math.round(img.getBoundingClientRect().top - box.top), Math.round(img.getBoundingClientRect().height)] as [number, number])
                  .filter(([top]) => top > -1000 && top < box.height + 1000) };
              if (jump.dHeight !== 0 && settle) pending = { jump, el: prev.el, y: prev.y, user: prev.user };
              else state.jumps.push(jump);
            }
          }
        }
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 3);
        const anchor = hit && el.contains(hit) ? hit.closest("p, li, pre, h2, [data-turn], [data-work-turn]") ?? hit : null;
        prev = anchor ? { el: anchor, y: anchor.getBoundingClientRect().top - box.top, top: el.scrollTop, height: el.scrollHeight, tail, user: state.user } : null;
        if (performance.now() - lastSample > 250) {
          lastSample = performance.now();
          state.samples.push([Math.round(lastSample), state.label, Math.round(el.scrollTop), el.scrollHeight, el.clientHeight]);
        }
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  };
  type State = { writes: Array<{ label: string; input: boolean; kind: string; stack: string }>; jumps: Array<{ label: string; dy: number; tail: boolean }>; lost: Array<{ label: string }>; samples: unknown[] };
  const result = await withBench(async (bridge, browser) => {
    const herd = bridge.herd!;
    const file = herd.journals.get(herd.working)!;
    const last = await writeLongJournal(file, 90, bridge.now() - 2 * 3_600_000, bridge.dir);
    const stopTurn = tickWorkingTurn(file, last, bridge.now);
    const context = await browser.newContext({ ...PHONE, reducedMotion: "no-preference", timezoneId: "UTC", locale: "en-US" });
    const page = await context.newPage();
    await page.addInitScript(probe, null);
    const label = (name: string) => page.evaluate((n: string) => { (window as unknown as { __scroll: { label: string } }).__scroll.label = n; }, name);
    const at = () => page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('section[aria-label="Live conversation"] .overflow-y-auto');
      return el ? { top: Math.round(el.scrollTop), gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) } : null;
    }, null);
    // Mobile WebKit takes no wheel and Playwright has no touch drag, so the reader's drag is a pointerdown
    // on the list (what the app and the probe count as input) and then the scroll it produces, a frame a step.
    const drag = (dy: number, times: number) => page.evaluate(async ([step, count]: [number, number]) => {
      const el = document.querySelector<HTMLElement>('section[aria-label="Live conversation"] .overflow-y-auto');
      if (!el) return;
      for (let i = 0; i < count; i++) {
        el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
        const from = el.scrollTop;
        el.scrollTop += step;
        (window as unknown as { __scroll: { user: number } }).__scroll.user += el.scrollTop - from;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
    }, [dy, times] as [number, number]);
    const shots: string[] = [];
    const shoot = async (name: string) => { const path = join(outDir, `${name}.png`); await page.screenshot({ path }); shots.push(path); };
    const steps: Array<{ step: string; before: unknown; after: unknown }> = [];
    const step = async (name: string, act: () => Promise<void>, settleMs: number) => {
      const before = await at();
      await label(`${name}:act`);
      await act();
      await label(name);
      await sleep(settleMs);
      steps.push({ step: name, before, after: await at() });
      await shoot(name);
    };

    await page.goto(`${bridge.url}/pane/${encodeURIComponent(herd.working)}`);
    await page.locator('[data-speaker="assistant"]').first().waitFor({ timeout: 15_000 });
    const latest = () => page.getByRole("button", { name: /latest|new message|waiting/i }).first().click({ timeout: 3000 }).catch(() => {});
    await step("tail", async () => {}, 8000);
    await step("read", () => drag(-300, 6), 15_000);
    // Reading up the way a person does: a screen's worth, a pause to read it, again.
    await step("read-slowly", async () => { for (let i = 0; i < 10; i++) { await drag(-300, 1); await sleep(1200); } }, 3000);
    await step("type", async () => { await page.locator("textarea").first().click(); await page.keyboard.type("checking the thread while typing", { delay: 120 }); }, 4000);
    await step("keyboard-open", () => page.setViewportSize({ width: 390, height: 500 }), 5000);
    await step("keyboard-closed", () => page.setViewportSize({ width: 390, height: 844 }), 5000);
    await step("near-tail", async () => { await latest(); await sleep(1500); await drag(-125, 2); }, 10_000);
    await step("turn-ends", async () => {
      stopTurn();
      await appendFile(file, JSON.stringify({ type: "assistant", uuid: "00000000-0000-4000-8000-ffffffffff01", parentUuid: null, timestamp: new Date(bridge.now()).toISOString(),
        message: { role: "assistant", content: [{ type: "text", text: "Done: the checkout cleanup is finished." }], stop_reason: "end_turn" } }) + "\n");
      bridge.fake!.setStatus(herd.working, "idle");
    }, 8000);
    await step("older", async () => {
      for (let i = 0; i < 60; i++) {
        const now = await at();
        if (!now || now.top < 600) break;
        await drag(-500, 1);
      }
    }, 6000);
    await step("sheet", async () => {
      await page.getByRole("button", { name: "Message tools" }).first().click({ timeout: 3000 }).catch(() => {});
      await sleep(800);
      await page.keyboard.press("Escape");
    }, 4000);
    // In the app, not a reload: the probe's log lives in the page.
    await step("away-and-back", async () => {
      await page.evaluate(() => { document.querySelector<HTMLAnchorElement>('a[href="/"]')?.click(); }, null);
      await sleep(1500);
      await page.goBack();
    }, 6000);
    await step("tail-keyboard", async () => {
      await latest();
      await page.locator("textarea").first().click();
      await page.setViewportSize({ width: 390, height: 500 });
    }, 6000);
    const state = await page.evaluate(() => (window as unknown as { __scroll: unknown }).__scroll, null) as State;
    await context.close();
    const labels = [...new Set(steps.map((s) => s.step))];
    const summary = Object.fromEntries(labels.map((name) => {
      const mine = (label: string) => label === name || label === `${name}:act`;
      const jumps = state.jumps.filter((j) => mine(j.label) && !j.tail);
      const writes = state.writes.filter((w) => mine(w.label) && !w.input);
      return [name, { jumpsWhileReading: jumps.length, upPx: jumps.filter((j) => j.dy > 0).reduce((a, j) => a + j.dy, 0), downPx: jumps.filter((j) => j.dy < 0).reduce((a, j) => a - j.dy, 0),
        writesWithoutInput: writes.length, writers: [...new Set(writes.map((w) => `${w.kind} ${w.stack.split(" < ")[0]}`))].slice(0, 6), lost: state.lost.filter((l) => mine(l.label)).length }];
    }));
    return { steps, summary, state, shots, unexpectedWrites: bridge.fake!.writes() };
  });
  await writeFile(join(outDir, "scroll.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ steps: result.steps, summary: result.summary, shots: `${result.shots.length} in ${outDir}` }, null, 2));
}

/**
 * Every WebKit process run from this bench's browser path, with RSS in KB and CPU time in ms. WebKit's
 * helpers are XPC services whose parent is launchd, so the path is what ties them to a browser: give
 * the bench a private copy (PLAYWRIGHT_BROWSERS_PATH) and another bench's WebKit stays out of the count.
 */
async function webkitProcesses(): Promise<Map<number, { rssKb: number; cpuMs: number }>> {
  const out = await new Response(Bun.spawn(["ps", "-A", "-o", "pid=,rss=,time=,command="]).stdout).text();
  const path = join(browsersCache(), "webkit-");
  const procs = new Map<number, { rssKb: number; cpuMs: number }>();
  for (const line of out.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!match || !match[4]!.includes(path)) continue;
    const [clock, days] = match[3]!.includes("-") ? [match[3]!.split("-")[1]!, Number(match[3]!.split("-")[0])] : [match[3]!, 0];
    const seconds = clock.split(":").map(Number).reduce((acc, n) => acc * 60 + n, 0);
    procs.set(Number(match[1]), { rssKb: Number(match[2]), cpuMs: Math.round((days * 86400 + seconds) * 1000) });
  }
  return procs;
}

/**
 * The surfaces every screen sits on, with five projects so each draws its own mark: Home, a session
 * (the desk's session panel beside it), a project, Settings and Search, on a phone and a desk, dark
 * and light, plus the phone's navigation drawer and the desk's collapsed rail. Then, on the real clock, one fresh WebKit per view
 * left alone for `--seconds`: its processes' CPU and resident memory, and the page's DOM elements.
 */
async function surface(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const prs = join(outDir, "gh-prs.json");
  process.env.NENU_E2E_GH_PRS = prs;
  let size = { additions: 0, deletions: 0 };
  const windowMs = Number(values.seconds) * 1000;
  const result = await withBench(async (bridge, browser) => {
    const herd = bridge.herd!;
    const shots: string[] = [];
    const chat = `/pane/${encodeURIComponent(herd.working)}`;
    const pages: Array<[string, string, string]> = [
      ["home", "/", '[role="tab"]:has-text("Recents")'],
      ["chat", chat, "textarea"],
      ["project", "/project/acme-shop", 'main >> text="Checkout flow"'],
      ["settings", "/settings", "text=Push notifications"],
    ];
    for (const [deviceName, device] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
      for (const scheme of ["dark", "light"] as const) {
        const context = await browser.newContext({ ...device, colorScheme: scheme, timezoneId: "UTC", locale: "en-US" });
        const page = await context.newPage();
        await page.clock.install({ time: bridge.now() });
        const shoot = async (name: string) => {
          const path = join(outDir, `${name}-${deviceName}-${scheme}.png`);
          await page.screenshot({ path, animations: "disabled" });
          shots.push(path);
        };
        for (const [name, path, ready] of pages) {
          await page.goto(bridge.url + path);
          await page.locator(ready).first().waitFor({ timeout: 15_000 });
          await page.waitForTimeout(1500);
          await shoot(name);
        }
        await page.goto(bridge.url + "/");
        await page.locator(pages[0]![2]).first().waitFor({ timeout: 15_000 });
        if (deviceName === "desktop") {
          // The bar under a resting pointer, which shows what it keeps out of sight until then (a row's shortcut).
          await page.getByRole("navigation", { name: "Projects and chats" }).getByRole("button", { name: /^New chat/ }).hover();
          await page.waitForTimeout(300);
          await shoot("sidebar-hover");
          await page.mouse.move(720, 450);
        }
        if (deviceName === "phone") {
          await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Search" }).click();
        } else {
          await page.getByRole("navigation", { name: "Projects and chats" }).getByRole("button", { name: /^Search/ }).click();
        }
        await page.getByRole("searchbox").first().fill("a");
        await page.waitForTimeout(600);
        await shoot("search");
        if (deviceName === "desktop") {
          // The collapsed rail, where a project is a tile among the loose workspaces.
          await page.evaluate(() => localStorage.setItem("nenu:sidebar-collapsed:v1", "1"), null);
          await page.goto(bridge.url + "/");
          await page.getByRole("navigation", { name: "Collapsed sidebar" }).waitFor({ timeout: 15_000 });
          await page.waitForTimeout(600);
          await shoot("rail");
        }
        if (deviceName === "phone") {
          await page.keyboard.press("Escape");
          // A chat in no project: its title opens the drawer (a project's chat leads back to its project instead).
          await page.goto(bridge.url + `/pane/${encodeURIComponent(herd.codex)}`);
          await page.locator("[data-chat-title]").first().click();
          await page.waitForTimeout(600);
          await shoot("drawer");
        }
        await context.close();
      }
    }

    const idle = await idleCost(bridge, [["home", "/", pages[0]![2]], ["chat", chat, "textarea"]], windowMs);
    return { shots, idle, unexpectedWrites: bridge.fake!.writes() };
  }, CAPTURE_EPOCH, (herd, now) => {
    const seed = homeOrg(herd, now, size);
    // Acme Shop picked its mark in Organizations, red included; the neighbours picked none, so theirs is the slug's.
    Object.assign(seed.projects[0]!, { icon: "flag", tone: "red" });
    const neighbour = (slug: string, name: string, goal: string) => ({ slug, name, goal, status: "active" as const, icon: "", tone: "", threads: [] });
    seed.projects.push(
      neighbour("docs-site", "Docs site", "Guides and the API reference"),
      neighbour("mobile-app", "Mobile app", "The iOS and Android clients"),
      neighbour("billing-api", "Billing API", "Invoices, plans and webhooks"),
      neighbour("data-pipeline", "Data pipeline", "Nightly exports and the warehouse"),
    );
    return seed;
  }, (dir) => {
    size = seedDiffRepo(dir);
    benchRepo(dir);
    writeFileSync(prs, JSON.stringify([ghPr(42, "Checkout flow", new Date(CAPTURE_EPOCH).toISOString(), { branch: "e2e-demo", checks: [], ...size })]));
  });
  await writeFile(join(outDir, "surface.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (result.unexpectedWrites.length) process.exit(1);
}

/**
 * Idle cost: a WebKit of its own per view, so its processes are only this page's, left alone for
 * `windowMs` twice: its processes' CPU and resident memory, and the page's DOM elements.
 */
async function idleCost(bridge: TestBridge, views: ReadonlyArray<readonly [string, string, string]>, windowMs: number) {
  const idle = [];
  for (const [view, path, ready] of views) {
    for (let run = 1; run <= 2; run++) {
      const known = new Set((await webkitProcesses()).keys());
      const own = await launchWebkit();
      try {
        const context = await own.newContext({ ...DESKTOP, timezoneId: "UTC", locale: "en-US" });
        const page = await context.newPage();
        await page.goto(bridge.url + path);
        await page.locator(ready).first().waitFor({ timeout: 15_000 });
        // Past the load and the service worker's precache, so the window holds only the page at rest.
        await page.waitForTimeout(10_000);
        const mine = (procs: Map<number, { rssKb: number; cpuMs: number }>) => [...procs].filter(([pid]) => !known.has(pid));
        const before = new Map(mine(await webkitProcesses()));
        await page.waitForTimeout(windowMs);
        const after = mine(await webkitProcesses());
        const cpuMs = after.reduce((acc, [pid, p]) => acc + p.cpuMs - (before.get(pid)?.cpuMs ?? 0), 0);
        const dom = await page.evaluate(() => document.getElementsByTagName("*").length, null);
        idle.push({
          view, run, seconds: windowMs / 1000, processes: after.length, cpuMs, cpuPercent: Math.round((cpuMs / windowMs) * 1000) / 10,
          rssMb: Math.round(after.reduce((acc, [, p]) => acc + p.rssKb, 0) / 1024), dom,
        });
        await context.close();
      } finally {
        await own.close();
      }
    }
  }
  return idle;
}

/**
 * The desk's bar drawn as Cursor's, a project's Routines tab and Home's Needs you, on a desk and a phone in
 * light and dark; then, with a chat open on the desk, another agent finishing, which shows what the
 * app raises for it. Then the idle cost of Home and a chat (`--seconds`, 0 skips it). With `--before`
 * it skips Routines, which origin/main does not have.
 */
async function sidebar(before: boolean): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const prs = join(outDir, "gh-prs.json");
  process.env.NENU_E2E_GH_PRS = prs;
  let size = { additions: 0, deletions: 0 };
  const windowMs = Number(values.seconds) * 1000;
  const result = await withBench(async (bridge, browser) => {
    const herd = bridge.herd!;
    const fake = bridge.fake!;
    const shots: string[] = [];
    const seen: Record<string, unknown> = {};
    const chat = `/pane/${encodeURIComponent(herd.working)}`;
    const home: readonly [string, string, string] = ["home", "/", '[role="tab"]:has-text("Recents")'];
    for (const [deviceName, device] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
      for (const scheme of ["light", "dark"] as const) {
        const context = await browser.newContext({ ...device, colorScheme: scheme, timezoneId: "UTC", locale: "en-US" });
        const page = await context.newPage();
        await page.clock.install({ time: bridge.now() });
        const shoot = async (name: string) => {
          const path = join(outDir, `${name}-${deviceName}-${scheme}.png`);
          await page.screenshot({ path, animations: "disabled" });
          shots.push(path);
        };
        const visit = async (path: string, ready: string) => {
          await page.goto(bridge.url + path);
          await page.locator(ready).first().waitFor({ timeout: 15_000 });
          await page.waitForTimeout(1200);
        };
        await visit(home[1], home[2]);
        await shoot("home");
        await visit(chat, "textarea");
        await shoot("chat");
        // Nothing may move at rest: a running animation here costs CPU for as long as the page is open.
        seen[`animationsAtRest-${deviceName}-${scheme}`] = await page.evaluate(() => document.getAnimations().length, null);
        if (deviceName === "desktop") {
          if (!before) {
            // A desk reads routines on each project's Routines tab (ADR 0102).
            await visit("/project/acme-shop?tab=routines", 'main >> text="nightly-dependency-check"');
            await shoot("routines");
          }
          await visit(chat, "textarea");
          await page.getByRole("navigation", { name: "Projects and chats" }).getByRole("button", { name: /^Search/ }).click();
          await page.waitForTimeout(400);
          await shoot("search-browse");
          await page.keyboard.press("Escape");
          // The collapsed rail, then the bar open again for what follows.
          await page.evaluate(() => localStorage.setItem("nenu:sidebar-collapsed:v1", "1"), null);
          await visit(chat, "textarea");
          await shoot("rail");
          await page.evaluate(() => localStorage.setItem("nenu:sidebar-collapsed:v1", "0"), null);
          await visit(chat, "textarea");
          if (scheme === "light") {
            // Another agent finishes while this chat is open: a toast, or a mark on its row in the bar.
            fake.setStatus(herd.idle, "working");
            await page.waitForTimeout(2500);
            fake.setStatus(herd.idle, "done");
            const toast = page.locator("[data-notification-viewport] [role=status], [data-notification-viewport] [role=alert]");
            const mark = page.locator(".nav-desk [data-unread]");
            await page.locator("[data-notification-viewport] [role=status], [data-notification-viewport] [role=alert], .nav-desk [data-unread]").first()
              .waitFor({ timeout: 12_000 }).catch(() => undefined);
            await page.waitForTimeout(300);
            seen.finishedToast = await toast.count();
            seen.finishedToastText = seen.finishedToast ? await toast.first().innerText() : null;
            seen.finishedToastCloseButton = seen.finishedToast ? await toast.first().getByRole("button", { name: /Dismiss/ }).count() : null;
            seen.finishedMark = await mark.count();
            await shoot("finished");
            fake.setStatus(herd.idle, "idle");
          }
        } else {
          // A chat owns the phone's bottom edge, so Search is the tab bar's on Home.
          await visit(home[1], home[2]);
          await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Search" }).click();
          await page.waitForTimeout(600);
          await shoot("search");
          await page.keyboard.press("Escape");
          await page.goto(bridge.url + `/pane/${encodeURIComponent(herd.codex)}`);
          await page.locator("[data-chat-title]").first().click();
          await page.waitForTimeout(600);
          await shoot("drawer");
        }
        await context.close();
      }
    }
    const idle = windowMs > 0 ? await idleCost(bridge, [home, ["chat", chat, "textarea"]], windowMs) : [];
    return { shots, seen, idle, orgCalls: await bridge.orgCalls(), unexpectedWrites: fake.writes() };
  }, CAPTURE_EPOCH, (herd, now) => deskOrg(herd, now, size), (dir) => {
    size = seedDiffRepo(dir);
    benchRepo(dir);
    writeFileSync(prs, JSON.stringify([ghPr(42, "Checkout flow", new Date(CAPTURE_EPOCH).toISOString(), { branch: "e2e-demo", checks: [], ...size })]));
  });
  await writeFile(join(outDir, "sidebar.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (result.unexpectedWrites.length) process.exit(1);
}

/** Only `sidebar`'s idle cost (Home and a chat, a desk at rest), with no captures: run it once per build to compare two. */
async function idle(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  let size = { additions: 0, deletions: 0 };
  const result = await withBench(async (bridge) => {
    const chat = `/pane/${encodeURIComponent(bridge.herd!.working)}`;
    const views = [["home", "/", '[role="tab"]:has-text("Recents")'], ["chat", chat, "textarea"]] as const;
    return { idle: await idleCost(bridge, views, Number(values.seconds) * 1000), unexpectedWrites: bridge.fake!.writes() };
  }, CAPTURE_EPOCH, (herd, now) => deskOrg(herd, now, size), (dir) => {
    size = seedDiffRepo(dir);
    benchRepo(dir);
  });
  await writeFile(join(outDir, "idle.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

const command = positionals[0];
/**
 * The row above a project chat's composer (homeOrg): the worker "Checkout flow" (PR #42 on the working
 * pane, with background work) and its coordinator, on a phone and a desk, dark and light. Each chip's
 * panel is opened and captured; `--before` captures the PR bar, its CI popover and the Background
 * chip instead. Then, on the real clock, one fresh WebKit on the worker's desk view left alone for
 * `--seconds`: CPU, resident memory and DOM elements, twice.
 */
async function chips(before: boolean): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const prs = join(outDir, "gh-prs.json");
  process.env.NENU_E2E_GH_PRS = prs;
  let size = { additions: 0, deletions: 0 };
  const windowMs = Number(values.seconds) * 1000;
  const fixture = JSON.parse(await Bun.file(join(import.meta.dir, "../../web/src/components/activity/activity.fixture.json")).text());
  const result = await withBench(async (bridge, browser) => {
    const herd = bridge.herd!;
    const now = bridge.now();
    const iso = (ago: number) => new Date(now - ago).toISOString();
    const list = { ...fixture.list, workflows: [], artifacts: [], tasks: [
      { id: "b0001", kind: "bash", title: "bun test --watch", status: "running", at: now - 8_000, hasOutput: true },
      { id: "b0002", kind: "bash", title: "bun run build", status: "completed", exitCode: 0, at: now - 900_000, hasOutput: true },
    ] };
    const subagents = { available: true, sessionKey: "bench", truncated: false, agents: [
      { id: "a0000000000000001", parentId: "", name: "reviewer", task: "Review the cart diff", status: "waiting", updatedAt: iso(120_000) },
      { id: "a0000000000000002", parentId: "", name: "explorer", task: "Read the carrier API", status: "running", updatedAt: iso(20_000) },
    ] };
    const mock = async (page: Page) => {
      await page.route("**/api/pane/*/activity*", (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.has("task")) return route.fulfill({ json: { sessionKey: "bench", id: url.searchParams.get("task"), text: "412 pass", truncated: false, updatedAt: now } });
        return route.fulfill({ json: route.request().url().includes(encodeURIComponent(herd.working)) ? list : { ...list, tasks: [] } });
      });
      await page.route("**/api/pane/*/subagents*", (route) => route.fulfill({ json: route.request().url().includes(encodeURIComponent(herd.working)) ? subagents : { ...subagents, agents: [] } }));
    };
    const shots: string[] = [];
    const found: Record<string, boolean> = {};
    const views: Array<[string, typeof PHONE | typeof DESKTOP, string, "dark" | "light"]> = [
      ["worker-desk-dark", DESKTOP, herd.working, "dark"], ["worker-desk-light", DESKTOP, herd.working, "light"],
      ["worker-phone-dark", PHONE, herd.working, "dark"], ["worker-phone-light", PHONE, herd.working, "light"],
      ["coordinator-desk-dark", DESKTOP, herd.idle, "dark"], ["coordinator-phone-dark", PHONE, herd.idle, "dark"],
    ];
    for (const [name, device, paneId, colorScheme] of views) {
      bridge.fake!.setStatus(herd.working, "working");
      const context = await browser.newContext({ ...device, colorScheme, timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      await page.clock.install({ time: now });
      await mock(page);
      await page.goto(`${bridge.url}/pane/${encodeURIComponent(paneId)}`);
      await page.getByRole("textbox").first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1800);
      const shoot = async (step: string) => {
        const path = join(outDir, `${name}-${step}.png`);
        await page.screenshot({ path, animations: "disabled" });
        shots.push(path);
      };
      const tap = async (locator: Locator, key: string) => {
        found[`${name}:${key}`] = await locator.waitFor({ timeout: 2500 }).then(() => true, () => false);
        if (found[`${name}:${key}`]) await locator.click();
        await page.waitForTimeout(500);
        return found[`${name}:${key}`];
      };
      await shoot("rest");
      if (before) {
        if (await tap(page.getByRole("button", { name: /^CI.*checks$/ }).first(), "ci")) { await shoot("ci"); await page.keyboard.press("Escape"); }
        if (await tap(page.getByRole("button", { name: /^Processes/ }).first(), "background")) { await shoot("background"); await page.keyboard.press("Escape"); }
      } else {
        const row = page.getByRole("group", { name: "Status" });
        for (const chip of ["Needs you", "Working", "Background", "PRs"]) {
          if (!await tap(row.getByRole("button", { name: new RegExp(`^${chip}`) }).first(), chip)) continue;
          await shoot(chip.toLowerCase().replace(" ", "-"));
          if (chip === "PRs" && name.startsWith("worker-phone")) {
            // The PR bar's diff, from the PRs panel now: its size opens the PR's changes.
            if (await tap(page.getByRole("button", { name: /^View changes/ }).first(), "prs:diff")) {
              const viewer = page.getByRole("dialog").first();
              found[`${name}:prs:diff-open`] = await viewer.waitFor({ timeout: 5000 }).then(() => true, () => false);
              await page.waitForTimeout(800);
              await shoot("prs-diff");
              await viewer.getByRole("button", { name: "Close" }).first().click();
              await page.waitForTimeout(400);
            }
          }
          await tap(page.getByRole("button", { name: "Close", exact: true }).first(), `${chip}:close`);
        }
        // Routines ask nothing of you: a row of the ⋯ menu opens their panel (ADR 0108).
        if (await tap(page.getByRole("button", { name: "Conversation actions" }), "menu") && await tap(page.getByRole("button", { name: /^Routines/ }), "Routines")) {
          await shoot("routines");
          await tap(page.getByRole("button", { name: "Close", exact: true }).first(), "Routines:close");
        }
      }
      await context.close();
    }

    // Idle cost: a WebKit of its own, so its processes are only this page's.
    const idle = [];
    for (let run = 1; run <= 2; run++) {
      const known = new Set((await webkitProcesses()).keys());
      const own = await launchWebkit();
      try {
        const context = await own.newContext({ ...DESKTOP, timezoneId: "UTC", locale: "en-US" });
        const page = await context.newPage();
        await mock(page);
        await page.goto(`${bridge.url}/pane/${encodeURIComponent(herd.working)}`);
        await page.getByRole("textbox").first().waitFor({ timeout: 15_000 });
        await page.waitForTimeout(10_000);
        const mine = (procs: Map<number, { rssKb: number; cpuMs: number }>) => [...procs].filter(([pid]) => !known.has(pid));
        const start = new Map(mine(await webkitProcesses()));
        await page.waitForTimeout(windowMs);
        const end = mine(await webkitProcesses());
        const cpuMs = end.reduce((acc, [pid, p]) => acc + p.cpuMs - (start.get(pid)?.cpuMs ?? 0), 0);
        const dom = await page.evaluate(() => document.getElementsByTagName("*").length, null);
        const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length, null);
        idle.push({ run, seconds: windowMs / 1000, cpuMs, cpuPercent: Math.round((cpuMs / windowMs) * 1000) / 10,
          rssMb: Math.round(end.reduce((acc, [, p]) => acc + p.rssKb, 0) / 1024), dom, runningAnimations: running });
        await context.close();
      } finally {
        await own.close();
      }
    }
    return { shots, found, idle, unexpectedWrites: bridge.fake!.writes() };
  }, CAPTURE_EPOCH, (herd, now) => {
    const seed = homeOrg(herd, now, size);
    const hour = 3_600_000;
    // As `routine list --json` prints them; an Organizations without the document lists none.
    seed.projects[0]!.routines = [
      { name: "pr-followup", trigger: "pr", schedule: "", events: ["checks-failed", "review"], enabled: true, last_run: "", next_run: "" },
      { name: "nightly-deps", trigger: "schedule", schedule: "daily 03:00", events: [], enabled: true,
        last_run: new Date(now - 20 * hour).toISOString(), next_run: new Date(now + 4 * hour).toISOString() },
    ];
    return seed;
  }, (dir) => {
    size = seedDiffRepo(dir);
    benchRepo(dir);
    writeFileSync(prs, JSON.stringify([ghPr(42, "Checkout flow", new Date(CAPTURE_EPOCH).toISOString(), { branch: "e2e-demo", checks: [], ...size })]));
  });
  await writeFile(join(outDir, "chips.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (result.unexpectedWrites.length) process.exit(1);
}

/**
 * Around the box on a 390px phone and a 1440px desk: a worker with a sibling that needs you, one that
 * works, two resolved, its routines and PRs, background work running and finished, a long branch and
 * another machine. Each chip opens and closes; the box's top and the thread's scroll are read before,
 * open and after, and none may move.
 */
async function composerAround(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const prs = join(outDir, "gh-prs.json");
  process.env.NENU_E2E_GH_PRS = prs;
  let size = { additions: 0, deletions: 0 };
  const branch = "fix/meli-contracargos-reintentos-webhook";
  const result = await withBench(async (bridge, browser) => {
    const herd = bridge.herd!;
    const now = bridge.now();
    const iso = (ago: number) => new Date(now - ago).toISOString();
    const activity = { sessionKey: "bench", available: true, workflows: [], artifacts: [], tasks: [
      { id: "b0001", kind: "bash", title: "bun test --watch", status: "running", at: now - 8_000, hasOutput: true },
      { id: "b0002", kind: "bash", title: "bun run build", status: "completed", exitCode: 0, at: now - 900_000, hasOutput: true },
      { id: "b0003", kind: "bash", title: "bun run lint", status: "failed", exitCode: 1, at: now - 1_500_000, hasOutput: true },
    ] };
    const subagents = { available: true, sessionKey: "bench", truncated: false, agents: [
      { id: "a0000000000000002", parentId: "", name: "explorer", task: "Read the carrier API", status: "running", updatedAt: iso(20_000) },
    ] };
    const shots: string[] = [];
    const seen: Record<string, unknown> = {};
    const moved: string[] = [];
    // A conversation long enough to scroll, so a panel that took the thread's height would show.
    await writeChatJournal(herd.journals.get(herd.working)!, now, 4, "running");
    for (const [deviceName, device] of [["390", PHONE], ["1440", DESKTOP]] as const) {
      bridge.fake!.setStatus(herd.working, process.env.NENU_E2E_IDLE ? "idle" : "working");
      const context = await browser.newContext({ ...device, colorScheme: "dark", timezoneId: "UTC", locale: "en-US", ...(process.env.NENU_E2E_LATE_CHIPS ? { reducedMotion: "no-preference" } : {}) });
      const page = await context.newPage();
      await page.clock.install({ time: now });
      await page.route("**/api/pane/*/activity*", async (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.has("task")) return route.fulfill({ json: { sessionKey: "bench", id: url.searchParams.get("task"), text: "412 pass", truncated: false, updatedAt: now } });
        const late = process.env.NENU_E2E_LATE_CHIPS ? { ...activity, tasks: process.env.NENU_E2E_NO_CHIPS ? [] : activity.tasks.filter((t) => t.status !== "running") } : activity;
        // A real session log takes a while to read: the chips land after the box has drawn.
        if (process.env.NENU_E2E_LATE_CHIPS) await sleep(1200);
        return route.fulfill({ json: route.request().url().includes(encodeURIComponent(herd.working)) ? late : { ...activity, tasks: [] } });
      });
      await page.route("**/api/pane/*/subagents*", (route) => route.fulfill({ json: process.env.NENU_E2E_LATE_CHIPS ? { ...subagents, agents: [] } : subagents }));
      // Another machine on screen, as Herdr names it when it saves more than one.
      await page.route("**/api/snapshot*", async (route) => {
        const json = await (await fetch(route.request().url())).json() as { session?: string; machines?: unknown };
        json.machines = [{ session: json.session, label: "build-box-remote", state: "online" }, { session: "@laptop", label: "laptop", state: "online" }];
        await route.fulfill({ json });
      });
      // What the agent reports in a real session: its model, effort and context.
      await page.route("**/api/pane/*/history*", async (route) => {
        const json = await (await fetch(route.request().url())).json() as Record<string, unknown>;
        if (json.available) json.telemetry = { source: "journal", model: "claude-opus-5-5", effort: "medium", context: { usedTokens: 22_000, windowTokens: 200_000, usedPercent: 11 } };
        await route.fulfill({ json });
      });
      // Layout shifts while the chat opens (Chromium reports them; WebKit has no such entry).
      await page.addInitScript(() => {
        const log: Array<{ value: number; sources: string[] }> = [];
        (window as unknown as { __shifts: typeof log }).__shifts = log;
        try {
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries() as unknown as Array<{ value: number; sources?: Array<{ node?: Node }> }>) {
              log.push({ value: entry.value, sources: (entry.sources ?? []).map((s) => (s.node instanceof Element ? `${s.node.tagName.toLowerCase()}.${s.node.className}`.slice(0, 60) : "")) });
            }
          }).observe({ type: "layout-shift", buffered: true });
        } catch { /* no layout-shift entries in this engine */ }
      }, null);
      await page.goto(`${bridge.url}/pane/${encodeURIComponent(herd.working)}`);
      await page.getByRole("textbox").first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(2000);
      seen[`${deviceName}:open-shifts`] = await page.evaluate(() => {
        const log = (window as unknown as { __shifts?: Array<{ value: number; sources: string[] }> }).__shifts ?? [];
        const from = (name: string) => log.filter((s) => s.sources.some((src) => src.includes(name))).length;
        return { count: log.length, fold: from("composer-fold"), composer: from("workbench-composer"), total: log.reduce((a, s) => a + s.value, 0) };
      }, null);
      // A quiet chat is read only for how it opens.
      if (process.env.NENU_E2E_LATE_CHIPS) {
        seen[`${deviceName}:chips`] = await page.getByRole("group", { name: "Status" }).getByRole("button").evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-label") ?? ""));
        await page.screenshot({ path: join(outDir, `${deviceName}-quiet.png`), animations: "disabled" });
        await context.close();
        continue;
      }
      const shoot = async (step: string) => {
        const path = join(outDir, `${deviceName}-${step}.png`);
        await page.screenshot({ path, animations: "disabled" });
        shots.push(path);
      };
      const read = () => page.evaluate(() => {
        const box = document.querySelector(".composer-box")?.getBoundingClientRect();
        const thread = document.querySelector<HTMLElement>(".chat-thread");
        const scroller = thread && [thread, ...Array.from(thread.querySelectorAll<HTMLElement>("*"))].find((el) => /auto|scroll/.test(getComputedStyle(el).overflowY));
        const meta = document.querySelector<HTMLElement>(".composer-meta");
        const cut = meta ? Array.from(meta.querySelectorAll<HTMLElement>("*")).filter((el) => el.children.length === 0 && el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent) : [];
        return {
          boxTop: box ? Math.round(box.top) : null,
          threadBottom: thread ? Math.round(thread.getBoundingClientRect().bottom) : null,
          scrollTop: scroller ? Math.round(scroller.scrollTop) : null,
          meta: meta ? { text: meta.innerText.replace(/\s+/g, " "), width: meta.scrollWidth, clientWidth: meta.clientWidth, cut } : null,
          sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          focus: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName ?? null,
        };
      }, null);
      await shoot("closed");
      const rest = await read();
      seen[`${deviceName}:closed`] = rest;
      const row = page.getByRole("group", { name: "Status" });
      const labels = await row.getByRole("button").evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-label") ?? ""));
      seen[`${deviceName}:chips`] = labels;
      for (const label of labels) {
        const chip = row.getByRole("button", { name: label, exact: true });
        await chip.click();
        await page.waitForTimeout(500);
        const slug = label.split(",")[0]!.toLowerCase().replace(/\s+/g, "-");
        await shoot(`open-${slug}`);
        const open = await read();
        seen[`${deviceName}:open-${slug}`] = open;
        await page.keyboard.press("Escape");
        await page.waitForTimeout(400);
        const after = await read();
        seen[`${deviceName}:after-${slug}`] = after;
        for (const [when, m] of [["open", open], ["after", after]] as const) {
          if (m.boxTop !== rest.boxTop || m.scrollTop !== rest.scrollTop || m.threadBottom !== rest.threadBottom) moved.push(`${deviceName}:${when}-${slug}`);
        }
      }
      // Routines ask nothing of you: the ⋯ menu opens their panel, and it moves nothing either.
      await page.getByRole("button", { name: "Conversation actions" }).click();
      await page.waitForTimeout(400);
      await page.getByRole("button", { name: /^Routines/ }).click();
      await page.waitForTimeout(500);
      await shoot("open-routines");
      const routinesOpen = await read();
      seen[`${deviceName}:open-routines`] = routinesOpen;
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
      const routinesAfter = await read();
      seen[`${deviceName}:after-routines`] = routinesAfter;
      for (const [when, m] of [["open", routinesOpen], ["after", routinesAfter]] as const) {
        if (m.boxTop !== rest.boxTop || m.scrollTop !== rest.scrollTop || m.threadBottom !== rest.threadBottom) moved.push(`${deviceName}:${when}-routines`);
      }
      // What ended stays one tap away, folded and quiet under what still works.
      await row.getByRole("button", { name: /^Working/ }).click();
      await page.waitForTimeout(400);
      await page.getByRole("dialog", { name: "Working" }).getByRole("button", { name: /^Done/ }).click();
      await page.waitForTimeout(300);
      await shoot("open-working-done");
      // A press on the thread closes the panel and moves nothing.
      await page.mouse.click(8, 110);
      await page.waitForTimeout(400);
      await shoot("outside");
      seen[`${deviceName}:outside`] = { ...(await read()), open: await page.locator("#composer-chip-panel").count() };
      if (deviceName === "390") {
        // A phone's Back closes the panel and stays on the chat.
        const url = page.url();
        await row.getByRole("button", { name: /^Needs you/ }).waitFor({ timeout: 3000 }).catch(() => {});
        await row.getByRole("button", { name: /^Needs you/ }).click();
        await page.waitForTimeout(400);
        await page.goBack();
        await page.waitForTimeout(600);
        seen["390:back"] = { ...(await read()), open: await page.locator("#composer-chip-panel").count(), sameUrl: page.url() === url };
        // Where it runs, whole, one tap from the row under the box.
        await page.getByRole("button", { name: /^Where this runs/ }).click();
        await page.waitForTimeout(400);
        await shoot("place");
        await page.keyboard.press("Escape");
      }
      await context.close();
    }
    return { shots, seen, moved, unexpectedWrites: bridge.fake!.writes() };
  }, CAPTURE_EPOCH, (herd, now) => {
    const seed = homeOrg(herd, now, size);
    const project = seed.projects[0]!;
    const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
    const sibling = (id: string, title: string, group: string, minutes: number) => ({ ...project.threads[3]!, id, title, group, group_label: group,
      status: group === "resolved" ? "resolved" : "open", workspace_id: "", tab_id: "", pane_id: "", branch: "", pr: null, updated: ago(minutes) });
    project.threads[3] = { ...project.threads[3]!, branch };
    project.threads.push(sibling("t-0015", "Shipping rates", "working", 2), sibling("t-0016", "Old cart page", "resolved", 300), sibling("t-0017", "Coupon field", "resolved", 900));
    // $NENU_E2E_LATE_CHIPS: nothing around the chat but what its own reads bring after it mounts
    // (finished commands and routines), as in a quiet chat; its chips arrive a moment late.
    if (process.env.NENU_E2E_LATE_CHIPS) project.threads = project.threads.filter((t) => t.id === "t-0012" || t.id === "t-0010").map((t) => ({ ...t, pr: null }));
    const hour = 3_600_000;
    project.routines = process.env.NENU_E2E_NO_CHIPS ? [] : [
      { name: "pr-followup", trigger: "pr", schedule: "", events: ["checks-failed", "review"], enabled: true, last_run: "", next_run: "" },
      { name: "nightly-deps", trigger: "schedule", schedule: "daily 03:00", events: [], enabled: true,
        last_run: new Date(now - 20 * hour).toISOString(), next_run: new Date(now + 4 * hour).toISOString() },
    ];
    return seed;
  }, (dir) => {
    size = seedDiffRepo(dir);
    benchRepo(dir);
    writeFileSync(prs, JSON.stringify([ghPr(42, "Checkout flow", new Date(CAPTURE_EPOCH).toISOString(), { branch: "e2e-demo", checks: [], ...size })]));
  });
  await writeFile(join(outDir, "composer.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ moved: result.moved, seen: result.seen }, null, 2));
  if (result.unexpectedWrites.length) process.exit(1);
}

/**
 * The chips above the box and Stop in it (ADR 0108), on a phone and a desk, dark and light: a working
 * chat with one background command (Background 1 and Stop), the same with none (Stop alone), a chat at
 * rest with a command still running (chips alone), finished work only while working and at rest (no
 * line: it is a row of the ⋯ menu, opened from there), homeOrg's worker with everything around it
 * (more chips than a phone fits, and Stop) and the terminal view. Each capture measures what sits
 * between the last message and the box's top edge; the phone's first moment is also read with the
 * keyboard up.
 */
async function chipLine(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const prs = join(outDir, "gh-prs.json");
  process.env.NENU_E2E_GH_PRS = prs;
  let size = { additions: 0, deletions: 0 };
  const result = await withBench(async (bridge, browser) => {
    const herd = bridge.herd!;
    const fake = bridge.fake!;
    const now = bridge.now();
    const iso = (ago: number) => new Date(now - ago).toISOString();
    const folder = dirname(herd.journals.get(herd.idle)!);
    const running = (id: string, title: string) => ({ id, kind: "bash", title, status: "running", at: now - 8_000, hasOutput: true });
    const background = { sessionKey: "bench", available: true, workflows: [], artifacts: [], tasks: [running("b0001", "bun run build && bun run deploy")] };
    const everything = { ...background, tasks: [...background.tasks, running("b0002", "bun test --watch")] };
    const none = { ...background, tasks: [] };
    // Only finished work: what the row said as "Done 2" while nothing ran.
    const finished = (id: string, title: string) => ({ id, kind: "bash", title, status: "completed", exitCode: 0, at: now - 600_000, hasOutput: true });
    const done = { ...background, tasks: [finished("b0003", "bun run build"), finished("b0004", "bun test")] };
    const subagents = { available: true, sessionKey: "bench", truncated: false, agents: [
      { id: "a0000000000000001", parentId: "", name: "reviewer", task: "Review the cart diff", status: "waiting", updatedAt: iso(120_000) },
      { id: "a0000000000000002", parentId: "", name: "explorer", task: "Read the carrier API", status: "running", updatedAt: iso(20_000) },
    ] };
    // Panes outside the project, so only their own session's work makes chips.
    fake.addTab("w1:t3", "line");
    const moments = [
      { name: "chips-stop", paneId: "w1:line", status: "working", activity: background },
      { name: "stop", paneId: "w1:stop", status: "working", activity: none },
      { name: "chips", paneId: "w1:rest", status: "done", activity: background },
      { name: "done-stop", paneId: "w1:donestop", status: "working", activity: done },
      { name: "done", paneId: "w1:done", status: "done", activity: done },
      { name: "many", paneId: herd.working, status: "working", activity: everything },
      // The terminal view, whose mirror says how long the turn has run.
      { name: "terminal", paneId: "w1:line", status: "working", activity: background, raw: true },
    ] as const;
    for (const [i, moment] of moments.entries()) {
      if (moment.paneId === herd.working || "raw" in moment) continue;
      const session = `7777777${i}-7777-4777-8777-777777777777`;
      await writeChatJournal(join(folder, `${session}.jsonl`), now, 3, moment.status === "working" ? "running" : "finished");
      fake.addPane({ paneId: moment.paneId, workspaceId: "w1", tabId: "w1:t3", agent: "claude", label: "Checkout flow", sessionId: session, cwd: bridge.dir,
        status: moment.status, lines: ["● The empty cart now shows a single button."] });
    }
    for (let tries = 0; !(await (await fetch(bridge.url + "/api/snapshot")).text()).includes("w1:rest"); tries++) {
      if (tries > 60) throw new Error("the bridge never listed the chip-line panes");
      await sleep(500);
    }
    const activityOf = (url: string) => moments.find((m) => url.includes(encodeURIComponent(m.paneId)))?.activity ?? none;
    const shots: string[] = [];
    const seen: Record<string, unknown> = {};
    const momentOf: Record<string, string> = {};
    for (const moment of moments) {
      for (const [deviceName, device] of [["phone", PHONE], ["desk", DESKTOP]] as const) {
        for (const scheme of ["dark", "light"] as const) {
          fake.setStatus(moment.paneId, moment.status);
          const context = await browser.newContext({ ...device, colorScheme: scheme, timezoneId: "UTC", locale: "en-US" });
          const page = await context.newPage();
          await page.clock.install({ time: now });
          if ("raw" in moment) {
            await page.addInitScript((scope: string) => {
              localStorage.setItem("collie:raw-terminal-scopes:v1", JSON.stringify({ [scope]: true }));
            }, JSON.stringify(["default", moment.paneId]));
          }
          await page.route("**/api/pane/*/activity*", (route) => {
            const url = route.request().url();
            if (new URL(url).searchParams.has("task")) return route.fulfill({ json: { sessionKey: "bench", id: "b0001", text: "building…", truncated: false, updatedAt: now } });
            return route.fulfill({ json: activityOf(url) });
          });
          await page.route("**/api/pane/*/subagents*", (route) => route.fulfill({ json: route.request().url().includes(encodeURIComponent(herd.working)) ? subagents : { ...subagents, agents: [] } }));
          await page.goto(`${bridge.url}/pane/${encodeURIComponent(moment.paneId)}`);
          await page.getByRole("textbox").first().waitFor({ timeout: 15_000 });
          await page.waitForTimeout(2000);
          const key = `${moment.name}-${deviceName}-${scheme}`;
          momentOf[key] = momentOf[`${key}-keyboard`] = moment.name;
          const path = join(outDir, `${key}.png`);
          await page.screenshot({ path, animations: "disabled" });
          shots.push(path);
          seen[key] = await page.evaluate(measureAboveBox, null);
          if (moment.name === "chips-stop" && deviceName === "phone" && scheme === "dark") {
            // The keyboard up: the chips give their height back, and Stop stays where it was.
            await page.evaluate(() => document.querySelector(".workbench-chat")?.setAttribute("data-keyboard-open", ""), null);
            await page.waitForTimeout(400);
            const typing = join(outDir, `${key}-keyboard.png`);
            await page.screenshot({ path: typing, animations: "disabled" });
            shots.push(typing);
            seen[`${key}-keyboard`] = await page.evaluate(measureAboveBox, null);
            await page.evaluate(() => document.querySelector(".workbench-chat")?.removeAttribute("data-keyboard-open"), null);
            // What the chip counts beside the turn's own Working row: the session's background command.
            await page.getByRole("group", { name: "Status" }).getByRole("button", { name: /^Background/ }).click();
            await page.waitForTimeout(500);
            const panel = join(outDir, `${key}-working-panel.png`);
            await page.screenshot({ path: panel, animations: "disabled" });
            shots.push(panel);
            seen[`${key}-working-panel`] = await page.locator("#composer-chip-panel").innerText().catch(() => null);
          }
          if (moment.name === "done" && scheme === "dark") {
            // Finished work is off the line: the ⋯ menu opens the same panel, and the box stays put.
            await page.getByRole("button", { name: "Conversation actions" }).click();
            await page.waitForTimeout(400);
            const menu = join(outDir, `${key}-menu.png`);
            await page.screenshot({ path: menu, animations: "disabled" });
            shots.push(menu);
            await page.getByRole("button", { name: /^Finished work/ }).click();
            await page.waitForTimeout(500);
            const panel = join(outDir, `${key}-finished-panel.png`);
            await page.screenshot({ path: panel, animations: "disabled" });
            shots.push(panel);
            seen[`${key}-finished-panel`] = { text: await page.locator("#composer-chip-panel").innerText().catch(() => null), box: (await page.evaluate(measureAboveBox, null))?.boxTop };
          }
          await context.close();
        }
      }
    }
    // Stop sits in the box whenever a turn runs, keyboard up or not; nothing ever sits between the
    // thread and the box, chips or not (ADR 0108): they are in the row under it, clear of the model and
    // the place; and nothing pushes the page sideways.
    type Seen = ReturnType<typeof measureAboveBox>;
    const working = new Set<string>(moments.filter((m) => m.status === "working").map((m) => m.name));
    const failed = Object.entries(seen as Record<string, Seen>).filter(([key]) => !key.endsWith("-panel") && !key.endsWith("-menu")).filter(([key, m]) => !m || m.pageScrollsSideways
      || (working.has(momentOf[key] ?? "") && !m.stopInBox)
      || (m.stop && (m.stop.left < 0 || m.stop.right > m.viewportWidth))
      || (m.aboveBox !== null && m.aboveBox > 0) || !m.chipsUnderBox || m.chipsOverlap).map(([key]) => key);
    // Opened from the ⋯ menu, finished work's panel floats: the box stays where it was.
    for (const [key, value] of Object.entries(seen)) {
      if (key.endsWith("-finished-panel") && (value as { box?: number }).box !== (seen[key.replace(/-finished-panel$/, "")] as Seen)?.boxTop) failed.push(key);
    }
    return { shots, seen, failed, unexpectedWrites: fake.writes() };
  }, CAPTURE_EPOCH, (herd, now) => {
    const seed = homeOrg(herd, now, size);
    seed.projects[0]!.routines = [
      { name: "pr-followup", trigger: "pr", schedule: "", events: ["checks-failed", "review"], enabled: true, last_run: "", next_run: "" },
      { name: "nightly-deps", trigger: "schedule", schedule: "daily 03:00", events: [], enabled: true,
        last_run: new Date(now - 20 * 3_600_000).toISOString(), next_run: new Date(now + 4 * 3_600_000).toISOString() },
    ];
    return seed;
  }, (dir) => {
    size = seedDiffRepo(dir);
    benchRepo(dir);
    writeFileSync(prs, JSON.stringify([ghPr(42, "Checkout flow", new Date(CAPTURE_EPOCH).toISOString(), { branch: "e2e-demo", checks: [], ...size })]));
  });
  await writeFile(join(outDir, "chip-line.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (result.failed.length || result.unexpectedWrites.length) process.exit(1);
}

/**
 * In the page: the rows between the thread and the composer box. `gap` runs from the bottom of the
 * last message on screen to the box's top edge; `aboveBox` from the thread's bottom edge to it. Stop's
 * reach is probed 21px above and below its centre, inside the 44px a coarse pointer gets.
 */
function measureAboveBox() {
  const box = document.querySelector(".composer-box")?.getBoundingClientRect();
  if (!box) return null;
  // The terminal view has no thread: only the line itself is measured there.
  const thread = document.querySelector(".chat-thread")?.getBoundingClientRect();
  const messages = Array.from(document.querySelectorAll<HTMLElement>(".chat-thread [data-speaker], .chat-thread [data-work-log] > li"))
    .map((el) => el.getBoundingClientRect()).filter((r) => thread && r.height > 0 && r.bottom <= thread.bottom);
  const last = messages.length ? Math.max(...messages.map((r) => r.bottom)) : null;
  const rect = (el: Element | null | undefined) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.height > 0 ? { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), height: Math.round(r.height) } : null;
  };
  const stop = document.querySelector<HTMLElement>('button[aria-label="Stop"]');
  const chipRow = document.querySelector('[role="group"][aria-label="Status"]');
  const sr = stop?.getBoundingClientRect();
  const reach = sr && sr.height > 0 ? [-21, 21].map((dy) => document.elementFromPoint(sr.left + sr.width / 2, sr.top + sr.height / 2 + dy)?.closest("button") === stop) : null;
  const chipsRect = rect(chipRow);
  const inBox = stop?.closest(".composer-box") !== null && stop !== null && sr !== undefined && sr.height > 0;
  // The chips sit in the row under the box, and touch neither the model nor the place beside them.
  const meta = document.querySelector(".composer-meta");
  const neighbours = Array.from(meta?.children ?? []).filter((el) => !el.classList.contains("composer-chips")).map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0);
  const overlaps = chipsRect !== null && neighbours.some((r) => r.left < chipsRect.right - 1 && r.right > chipsRect.left + 1);
  return {
    gap: last === null ? null : Math.round(box.top - last),
    aboveBox: thread ? Math.round(box.top - thread.bottom) : null,
    boxTop: Math.round(box.top),
    chips: chipsRect,
    chipLabels: Array.from(chipRow?.querySelectorAll("button") ?? []).map((b) => b.getAttribute("aria-label")),
    chipsScroll: chipRow ? { scrollWidth: chipRow.scrollWidth, clientWidth: chipRow.clientWidth } : null,
    chipsUnderBox: chipsRect === null || (chipRow!.closest(".composer-meta") !== null && chipsRect.top >= box.bottom),
    chipsOverlap: overlaps,
    stop: rect(stop),
    stopInBox: inBox,
    stopReach: reach,
    pageScrollsSideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    viewportWidth: document.documentElement.clientWidth,
  };
}


/**
 * A finished conversation (scenario.ts `writeChatJournal`) on a phone and a desk, dark and light,
 * folded and with its first turn open; a third turn while it runs and once it ends. Then a long one (the same two turns twenty times), on the real
 * clock in a WebKit of its own per run: the thread's DOM elements, and the browser's CPU and resident
 * memory over `--seconds` left alone. Give it a private `PLAYWRIGHT_BROWSERS_PATH`, as for `surface`.
 */
async function chat(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const windowMs = Number(values.seconds) * 1000;
  const result = await withBench(async (bridge, browser) => {
    const herd = bridge.herd!;
    const folder = dirname(herd.journals.get(herd.idle)!);
    const panes = { short: "w1:chat", long: "w1:long" };
    // One running pane per capture, so each finishes once and its journal only ever grows.
    const runs = [["phone", PHONE, "dark"], ["desktop", DESKTOP, "dark"], ["desktop", DESKTOP, "light"]] as const;
    const running = runs.map((_, i) => ({ paneId: `w1:run${i}`, file: join(folder, `6666666${i}-6666-4666-8666-666666666666.jsonl`), at: bridge.now() }));
    bridge.fake!.addTab("w1:t3", "chat");
    const pane = (paneId: string, sessionId: string, status: "done" | "working") => bridge.fake!.addPane({ paneId, workspaceId: "w1", tabId: "w1:t3", agent: "claude",
      label: "Checkout flow", sessionId, cwd: bridge.dir, status, lines: ["● The empty cart now shows a single button."] });
    for (const [key, paneId, repeat] of [["short", panes.short, 1], ["long", panes.long, 20]] as const) {
      const session = key === "short" ? "44444444-4444-4444-8444-444444444444" : "55555555-5555-4555-8555-555555555555";
      await writeChatJournal(join(folder, `${session}.jsonl`), bridge.now(), repeat);
      pane(paneId, session, "done");
    }
    for (const run of running) {
      await writeChatJournal(run.file, run.at, 1, "running");
      pane(run.paneId, basename(run.file, ".jsonl"), "working");
    }
    // The bridge reads Herdr on its own beat; the panes are there once its snapshot names them.
    for (let tries = 0; !(await (await fetch(bridge.url + "/api/snapshot")).text()).includes(running.at(-1)!.paneId); tries++) {
      if (tries > 60) throw new Error("the bridge never listed the chat panes");
      await sleep(500);
    }
    const shots: string[] = [];
    const thread = (page: Page) => page.evaluate(() => document.querySelector(".chat-thread")?.getElementsByTagName("*").length ?? 0, null);
    const seen: Record<string, unknown> = {};
    for (const [deviceName, device] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
      for (const scheme of ["dark", "light"] as const) {
        const context = await browser.newContext({ ...device, colorScheme: scheme, timezoneId: "UTC", locale: "en-US" });
        const page = await context.newPage();
        await page.clock.install({ time: bridge.now() });
        await page.goto(bridge.url + `/pane/${encodeURIComponent(panes.short)}`);
        await page.getByText("Three pull requests are open").waitFor({ timeout: 15_000 });
        await page.waitForTimeout(1500);
        const shoot = async (name: string) => {
          const path = join(outDir, `${name}-${deviceName}-${scheme}.png`);
          await page.screenshot({ path, animations: "disabled" });
          shots.push(path);
        };
        seen[`${deviceName}-${scheme}-thread`] = await thread(page);
        // What the folds say, from the journal's turn_duration rows through the real bridge.
        seen[`${deviceName}-${scheme}-worked`] = await page.evaluate(() => Array.from(document.querySelectorAll("[data-work-toggle]")).map((el) => (el as HTMLElement).innerText.trim()), null);
        await shoot("chat");
        if (scheme === "dark") {
          await page.locator("[data-work-toggle]").first().click();
          await page.waitForTimeout(400);
          await shoot("chat-open");
          // Hover lights the first answer's actions, as a pointer resting on it would.
          if (deviceName === "desktop") {
            await page.getByText("I recommend merging").hover();
            await page.waitForTimeout(400);
            await shoot("chat-hover");
          }
        }
        await context.close();
      }
    }

    for (const [i, [deviceName, device, scheme]] of runs.entries()) {
      const { paneId, file, at } = running[i]!;
      const context = await browser.newContext({ ...device, colorScheme: scheme, timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      await page.clock.install({ time: bridge.now() });
      await page.goto(bridge.url + `/pane/${encodeURIComponent(paneId)}`);
      await page.getByText("The totals test still covers the coupon").waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1500);
      const shoot = async (name: string) => {
        const path = join(outDir, `${name}-${deviceName}-${scheme}.png`);
        await page.screenshot({ path, animations: "disabled" });
        shots.push(path);
      };
      await shoot("working");
      await writeChatJournal(file, at, 1, "finished");
      bridge.fake!.setStatus(paneId, "done");
      await page.getByText("The cart tests pass, 5 of 5").waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1500);
      seen[`finished-${deviceName}-${scheme}-worked`] = await page.evaluate(() => Array.from(document.querySelectorAll("[data-work-toggle]")).map((el) => (el as HTMLElement).innerText.trim()), null);
      await shoot("finished");
      await context.close();
    }

    const idle = [];
    for (let run = 1; run <= 2; run++) {
      const known = new Set((await webkitProcesses()).keys());
      const own = await launchWebkit();
      try {
        const context = await own.newContext({ ...DESKTOP, timezoneId: "UTC", locale: "en-US" });
        const page = await context.newPage();
        await page.goto(bridge.url + `/pane/${encodeURIComponent(panes.long)}`);
        await page.getByText("Three pull requests are open").first().waitFor({ timeout: 15_000 });
        await page.waitForTimeout(10_000);
        const mine = (procs: Map<number, { rssKb: number; cpuMs: number }>) => [...procs].filter(([pid]) => !known.has(pid));
        const before = new Map(mine(await webkitProcesses()));
        await page.waitForTimeout(windowMs);
        const after = mine(await webkitProcesses());
        const cpuMs = after.reduce((acc, [pid, p]) => acc + p.cpuMs - (before.get(pid)?.cpuMs ?? 0), 0);
        const dom = await page.evaluate(() => ({
          document: document.getElementsByTagName("*").length,
          thread: document.querySelector(".chat-thread")?.getElementsByTagName("*").length ?? 0,
          turns: document.querySelectorAll("[data-work-turn]").length,
        }), null);
        idle.push({ run, seconds: windowMs / 1000, processes: after.length, cpuMs, cpuPercent: Math.round((cpuMs / windowMs) * 1000) / 10,
          rssMb: Math.round(after.reduce((acc, [, p]) => acc + p.rssKb, 0) / 1024), dom });
        await context.close();
      } finally {
        await own.close();
      }
    }
    return { shots, seen, idle, unexpectedWrites: bridge.fake!.writes() };
  }, CAPTURE_EPOCH);
  await writeFile(join(outDir, "chat.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (result.unexpectedWrites.length) process.exit(1);
}


// The answer from the operator's phone captures (2026-10-17): a four-column table of long cells, a
// short two-column one and a list with sub-items. Synthetic words in the same shape.
const READING_ANSWER = [
  "Listo. Esto es lo que pediste y en qué quedó:",
  "",
  "| Lo que dijiste | Qué se hizo | PR | En vivo |",
  "|---|---|---|---|",
  "| Atrás suma entradas al historial | El botón ‹ vuelve a la página anterior en vez de apilar otra | #209 | sí |",
  "| Parpadeo y saltos de posición | Proyecto y chat cargan sin saltar, y el arranque muestra una sola pantalla en vez de dos | #212 | sí |",
  "| La lista de chats se reordena sola | Home y la barra mantienen el orden mientras están en pantalla | #210 | sí |",
  "| El aviso de actualización flota | Ahora es una fila dentro del flujo, sin animación | #211 | no, falta el release |",
  "",
  "| Paso | Estado |",
  "|---|---|",
  "| Merge | 4 de 4 |",
  "| Release | 1.24.1 |",
  "",
  "Lo que medí:",
  "",
  "- **Atrás, en el sitio real a 390 de ancho:** fui Home → proyecto → coordinador → Threads y toqué ‹ dos veces. El historial quedó en la entrada más 2. Antes sumaba uno con cada ‹.",
  "- **Parpadeo y saltos, en el banco de la auditoría con datos simulados:**",
  "  - Las filas que se movían pasaron de 250 y 476 por minuto a 0.",
  "  - El salto de layout del proyecto pasó de 0,30 a 0.",
  "  - El esqueleto del chat dejó de aparecer (antes duraba unos 500 ms).",
  "- **Pendiente:** el release de #211.",
  "",
  "Lo que vuelve a confirmar ahora: los 4 PRs figuran mergeados en GitHub y Nenu 1.24.1 está corriendo desde las 07:17.",
].join("\n");

/** Tables, nested lists, the way back to the tail and the model picker, read on a phone and a desk. */
async function reading(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const result = await withBench(async (bridge, browser) => {
    const herd = bridge.herd!;
    const folder = dirname(herd.journals.get(herd.idle)!);
    const panes = { claude: "w1:read", codex: "w1:readcx" };
    const session = "77777777-7777-4777-8777-777777777777";
    await writeJournal(join(folder, `${session}.jsonl`), [["user", "¿En qué quedó lo que te pedí?"], ["assistant", READING_ANSWER]], bridge.now() - 60_000);
    bridge.fake!.addTab("w1:t4", "reading");
    bridge.fake!.addPane({ paneId: panes.claude, workspaceId: "w1", tabId: "w1:t4", agent: "claude", label: "Brief de coordinación", sessionId: session, cwd: bridge.dir, status: "done", lines: ["● Listo."] });
    bridge.fake!.addPane({ paneId: panes.codex, workspaceId: "w1", tabId: "w1:t4", agent: "codex", label: "Codex", sessionId: "88888888-8888-4888-8888-888888888888", cwd: bridge.dir, status: "done", lines: ["• Listo."] });
    for (let tries = 0; !(await (await fetch(bridge.url + "/api/snapshot")).text()).includes(panes.codex); tries++) {
      if (tries > 60) throw new Error("the bridge never listed the reading panes");
      await sleep(500);
    }
    const historyOf = (paneId: string) => `${bridge.url}/api/pane/${encodeURIComponent(paneId)}/history`;
    // Claude's rows are the bridge's own, plus the one an account's cache adds; Codex's a models_cache.
    const claudeRows = async () => [...((await (await fetch(`${bridge.url}/api/pane/${encodeURIComponent(panes.claude)}/models`)).json()) as { models: unknown[] }).models,
      { name: "Fable", description: "Fable 5.1 · Most capable for your hardest and longest-running tasks" }];
    const codexRows = [
      { name: "gpt-5.5-codex", description: "Latest frontier agentic coding model." },
      { name: "gpt-5.5", description: "Latest frontier model with improvements across knowledge, reasoning and coding." },
      { name: "gpt-5.5-codex-mini", description: "Smaller, faster and cheaper." },
    ];
    const shots: string[] = [];
    const seen: Record<string, unknown> = {};
    for (const [deviceName, device] of [["390", PHONE], ["1440", DESKTOP]] as const) {
      // No service worker: its fetches would pass the routes below by.
      const context = await browser.newContext({ ...device, colorScheme: "dark", timezoneId: "UTC", locale: "en-US", serviceWorkers: "block" });
      const page = await context.newPage();
      await page.clock.install({ time: bridge.now() });
      await page.route("**/api/pane/*/history*", async (route) => {
        const url = new URL(route.request().url());
        const codex = url.pathname.includes(encodeURIComponent(panes.codex));
        url.searchParams.delete("session");
        const json = await (await fetch(`${historyOf(panes.claude)}?${url.searchParams}`)).json() as Record<string, unknown>;
        if (json.available) json.telemetry = codex
          ? { source: "journal", model: "gpt-5.5-codex", effort: "high", context: { usedTokens: 40_000, windowTokens: 400_000, usedPercent: 10 } }
          : { source: "journal", model: "claude-opus-5-5", effort: "medium", context: { usedTokens: 12_000, windowTokens: 200_000, usedPercent: 6 } };
        await route.fulfill({ json });
      });
      const claude = await claudeRows();
      await page.route("**/api/pane/*/models*", async (route) => route.fulfill({ json: { available: true, source: "bench",
        models: route.request().url().includes(encodeURIComponent(panes.codex)) ? codexRows : claude } }));
      const shoot = async (name: string) => {
        const path = join(outDir, `${deviceName}-${name}.png`);
        await page.screenshot({ path, animations: "disabled" });
        shots.push(path);
      };
      const list = () => page.evaluate(() => {
        const el = document.querySelector<HTMLElement>('section[aria-label="Live conversation"] .overflow-y-auto');
        return el ? { top: el.scrollTop, max: el.scrollHeight - el.clientHeight } : null;
      }, null);
      const scrollTo = (selector: string) => page.evaluate((sel: string) => {
        const el = document.querySelector<HTMLElement>('section[aria-label="Live conversation"] .overflow-y-auto');
        const target = Array.from(document.querySelectorAll<HTMLElement>("p, li, div")).find((node) => node.textContent?.startsWith(sel) && node.children.length < 3);
        if (el && target) el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - 24;
      }, selector);
      await page.goto(`${bridge.url}/pane/${encodeURIComponent(panes.claude)}`);
      await page.getByText("Lo que vuelve a confirmar").waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1500);
      // The four-column table: how tall each of its rows draws, and whether it kept its grid.
      seen[`${deviceName}:table`] = await page.evaluate(() => {
        const copies = Array.from(document.querySelectorAll<HTMLElement>('button[aria-label^="Copy table"], button')).filter((b) => /table/i.test(b.getAttribute("aria-label") ?? b.textContent ?? ""));
        return copies.map((copy) => {
          const table = copy.closest("div")!.parentElement!;
          const own = table.querySelectorAll("[data-table-row]");
          const rows = Array.from(own.length ? own : table.querySelectorAll("dl, tbody tr"));
          return { grid: table.querySelector("table") !== null, rows: rows.map((row) => Math.round(row.getBoundingClientRect().height)), height: Math.round(table.getBoundingClientRect().height) };
        });
      }, null);
      // The nested list: how far a sub-item stands in from the item it belongs to.
      seen[`${deviceName}:list`] = await page.evaluate(() => {
        const parent = Array.from(document.querySelectorAll("li")).find((li) => li.textContent?.startsWith("Parpadeo y saltos, en el banco"));
        const child = Array.from(document.querySelectorAll("li")).find((li) => li.textContent?.startsWith("Las filas que se movían"));
        return parent && child ? { indent: Math.round(child.getBoundingClientRect().left - parent.getBoundingClientRect().left), nested: parent.contains(child) } : null;
      }, null);
      await scrollTo("Listo. Esto es lo que pediste");
      await page.waitForTimeout(400);
      await shoot("table");
      await scrollTo("Lo que medí");
      await page.waitForTimeout(400);
      await shoot("list");
      // At the very end of the thread, then a little above it: what the way back covers.
      const bounds = await list();
      await page.evaluate((top: number) => { const el = document.querySelector<HTMLElement>('section[aria-label="Live conversation"] .overflow-y-auto'); if (el) el.scrollTop = top; }, Math.max(0, (bounds?.max ?? 0) - 90));
      await page.waitForTimeout(600);
      await shoot("near-end");
      seen[`${deviceName}:near-end`] = await page.evaluate(() => {
        const button = document.querySelector<HTMLElement>('button[aria-label^="Scroll to latest"]');
        const scroller = document.querySelector<HTMLElement>('section[aria-label="Live conversation"] .overflow-y-auto');
        if (!button || !scroller) return { button: false };
        const b = button.getBoundingClientRect();
        const covered = Array.from(scroller.querySelectorAll<HTMLElement>("p, li")).filter((el) => {
          const r = el.getBoundingClientRect();
          return r.bottom > b.top && r.top < b.bottom && r.right > b.left && r.left < b.right && el.children.length === 0;
        }).map((el) => el.textContent?.slice(0, 40));
        return { button: true, covered, maxScroll: scroller.scrollHeight - scroller.clientHeight, top: Math.round(scroller.scrollTop) };
      }, null);
      // At the very end: how far the last line stands above the list's bottom edge, where the way
      // back floats (12 px up, 44 px tall on touch) whenever the follow pauses there.
      seen[`${deviceName}:end-clearance`] = await page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>('section[aria-label="Live conversation"] .overflow-y-auto');
        if (!scroller) return null;
        scroller.scrollTop = scroller.scrollHeight;
        const texts = Array.from(scroller.querySelectorAll<HTMLElement>("p, li")).filter((el) => el.innerText.trim() !== "");
        const last = texts.at(-1)!;
        return Math.round(scroller.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom);
      }, null);
      for (const [agent, paneId] of [["claude", panes.claude], ["codex", panes.codex]] as const) {
        if (agent === "codex") {
          await page.goto(`${bridge.url}/pane/${encodeURIComponent(paneId)}`);
          await page.getByText("Lo que vuelve a confirmar").waitFor({ timeout: 15_000 });
          await page.waitForTimeout(1500);
        }
        const trigger = page.getByLabel("Choose model");
        await trigger.click();
        await page.waitForTimeout(800);
        await shoot(`picker-${agent}`);
        seen[`${deviceName}:picker-${agent}`] = await page.evaluate(() => {
          const sheet = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Model"]');
          if (!sheet) return null;
          const r = sheet.getBoundingClientRect();
          const rows = Array.from(sheet.querySelectorAll<HTMLElement>('[role="radio"], [role="menuitemradio"], [role="option"]'));
          const scrollers = Array.from(sheet.querySelectorAll<HTMLElement>("*")).filter((el) => el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY));
          return { height: Math.round(r.height), top: Math.round(r.top), rows: rows.map((row) => Math.round(row.getBoundingClientRect().height)),
            labels: rows.map((row) => row.innerText.replace(/\s+/g, " ").slice(0, 60)), scrolls: scrollers.length > 0 };
        }, null);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
        seen[`${deviceName}:picker-${agent}-escape`] = await page.evaluate(() => document.querySelector('[role="dialog"][aria-label="Model"]') === null, null);
      }
      await context.close();
    }
    return { shots, seen, unexpectedWrites: bridge.fake!.writes() };
  }, CAPTURE_EPOCH);
  await writeFile(join(outDir, "reading.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

/**
 * A finger pushing `by` px up from (195, y), down when negative. Chromium gets raw touch events (its
 * synthesized scroll gesture scrolls nothing headless). Mobile WebKit takes no wheel and Playwright
 * drives no touch scroll there, so it scrolls what the engine would: the nearest box under the finger
 * that can still go that way, chaining outward.
 */
async function touchDrag(engine: "webkit" | "chromium", context: Context, page: Page, y: number, by: number): Promise<void> {
  if (engine === "chromium") {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 195, y }] });
    for (let step = 1; step <= 15; step++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 195, y: y - step * by / 15 }] });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    await page.evaluate(([at, by]: readonly [number, number]) => {
      const down = by < 0;
      for (let el = document.elementFromPoint(195, at); el; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (el !== document.documentElement && !/auto|scroll/.test(style.overflowY)) continue;
        if (down ? el.scrollTop <= 0 : el.scrollTop + el.clientHeight >= el.scrollHeight) continue;
        el.scrollTop += by;
        return;
      }
    }, [y, by] as const);
  }
  await page.waitForTimeout(400);
}

/**
 * The box stays put on a phone: a project coordinator's long chat at 390x844 in WebKit and Chromium,
 * dark and light, with the keyboard closed and open (the viewport cut to 390x470, as the keyboard
 * leaves it). Each lists what a finger can scroll (only the thread may), the root's overscroll, and
 * where the box and the header sit before and after a drag that starts on the box and one on the
 * header: a wheel in WebKit, a touch scroll gesture in Chromium. Then the Threads tab's scrollers.
 */
async function pin(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const shots: string[] = [];
  const seen: Record<string, unknown> = {};
  const failures: string[] = [];
  const bridge = await startTestBridge({ port, fake: true, epoch: CAPTURE_EPOCH, org: (herd, now) => projectChatSeed(herd, now) });
  try {
    const herd = bridge.herd!;
    await writeChatJournal(herd.journals.get(herd.working)!, bridge.now(), 6, "finished");
    for (const engine of ["webkit", "chromium"] as const) {
      const browser = await launchEngine(engine);
      try {
        for (const scheme of ["dark", "light"] as const) {
          const context = await browser.newContext({ ...PHONE, colorScheme: scheme, timezoneId: "UTC", locale: "en-US" });
          const page = await context.newPage();
          await page.clock.install({ time: bridge.now() });
          await page.goto(bridge.url + `/pane/${encodeURIComponent(herd.working)}`);
          await page.getByPlaceholder("Ask the coordinator…").waitFor({ timeout: 15_000 });
          await page.waitForTimeout(2000);
          const shoot = async (name: string) => {
            const path = join(outDir, `pin-${name}-${engine}-${scheme}.png`);
            await page.screenshot({ path, animations: "disabled" });
            shots.push(path);
          };
          const scrollers = () => page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>("body *"))
            .filter((el) => el.tagName !== "TEXTAREA" && /auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight)
            .map((el) => `${el.closest(".chat-thread") === el.parentElement?.closest(".chat-thread") && el.closest(".chat-thread") ? "thread" : String(el.className).split(" ")[0]} +${el.scrollHeight - el.clientHeight}px`), null);
          const places = () => page.evaluate(() => {
            const top = (selector: string) => Math.round(document.querySelector(selector)?.getBoundingClientRect().top ?? NaN);
            const box = document.querySelector(".workbench-composer")!.getBoundingClientRect();
            return { header: top(".workbench-app-header"), box: Math.round(box.top), boxBottom: Math.round(box.bottom), height: window.visualViewport?.height ?? innerHeight };
          }, null);
          const drag = (y: number, down = false) => touchDrag(engine, context, page, y, down ? -300 : 300);
          const probe = async (moment: string) => {
            const at = await places();
            const list = await scrollers();
            const moved: Record<string, unknown> = {};
            await shoot(moment);
            for (const [from, y] of [["box", at.boxBottom - 12], ["header", at.header + 20], ["thread", Math.round((at.header + at.box) / 2)]] as const) {
              // Each drag starts from the page as it loaded: whatever an earlier one scrolled outside the thread goes back.
              await page.evaluate(() => { for (const el of Array.from(document.querySelectorAll<HTMLElement>(".workbench-chat, .workbench-chat > *"))) el.scrollTop = 0; }, null);
              await drag(y);
              const after = await places();
              moved[from] = { box: after.box - at.box, header: after.header - at.header };
              if (after.box !== at.box || after.header !== at.header) failures.push(`${engine} ${scheme} ${moment}: a drag on the ${from} moved the box ${after.box - at.box}px, the header ${after.header - at.header}px`);
            }
            // The control: a finger pulling down on the thread still reads back through it.
            const reading = () => page.evaluate(() => document.querySelector(".chat-thread [class*='overflow-y-auto']")?.scrollTop ?? NaN, null);
            const from = await reading();
            await drag(Math.round((at.header + at.box) / 2), true);
            moved.threadScrolled = from - await reading();
            if (!(Number(moved.threadScrolled) > 0)) failures.push(`${engine} ${scheme} ${moment}: a drag down on the thread did not scroll it`);
            if (list.length !== 1 || !list[0]!.startsWith("thread")) failures.push(`${engine} ${scheme} ${moment}: scrollers ${JSON.stringify(list)}`);
            if (at.boxBottom > at.height) failures.push(`${engine} ${scheme} ${moment}: the box ends at ${at.boxBottom}, under the viewport's ${at.height}`);
            seen[`${engine}-${scheme}-${moment}`] = { ...at, scrollers: list, moved };
            await shoot(`${moment}-dragged`);
          };
          const overscroll = await page.evaluate(() => getComputedStyle(document.documentElement).overscrollBehaviorY, null);
          seen[`${engine}-${scheme}-root-overscroll`] = overscroll;
          if (overscroll !== "none") failures.push(`${engine} ${scheme}: the root's overscroll is ${overscroll}`);
          await probe("closed");
          await page.getByPlaceholder("Ask the coordinator…").click();
          await page.setViewportSize({ width: 390, height: 470 });
          await page.waitForTimeout(600);
          await probe("keyboard");
          await page.setViewportSize(PHONE.viewport);
          await page.getByRole("tab", { name: /^Threads/ }).click();
          await page.locator(".project-overlay").waitFor({ timeout: 5000 });
          await page.waitForTimeout(400);
          const threads = await scrollers();
          seen[`${engine}-${scheme}-threads`] = threads;
          if (threads.length > 1) failures.push(`${engine} ${scheme} threads: scrollers ${JSON.stringify(threads)}`);
          await shoot("threads");
          await context.close();
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    await bridge.stop();
  }
  const result = { shots, seen, failures };
  await writeFile(join(outDir, "pin.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (failures.length) process.exit(1);
}

/**
 * Every phone screen scrolls one box and nothing else: Home, Projects, a project with its History open,
 * a coordinator node, Your asks, Settings, a chat, a coordinator's Threads, a chat's History, and two
 * sheets over a page, in WebKit and Chromium, twice: in Safari, whose bars leave the page no inset, and
 * as the home-screen app, 47px over and 34px under (env() is 0 headless, so the bundle's CSS says them).
 * The herd and the organization are seeded taller than a phone on every screen. Each screen: the root
 * opts out of vertical overscroll (a drag past an end rubber-bands the whole app in Safari otherwise),
 * exactly one box scrolls vertically, a drag from the header, the middle and the bottom moves only that
 * box (never the header, the tab bar, the composer or the window) and moves it at least once, and the
 * box's last row ends above whatever sits under it. On a sheet a drag over the panel or the backdrop
 * moves nothing behind it. WebKit's drags are touchDrag's stand-in, not the engine's touch scrolling.
 */
async function phoneScroll(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const shots: string[] = [];
  const seen: Record<string, unknown> = {};
  const failures: string[] = [];
  // orgTreeSeed with thirty more open threads, half of them under Migración de stock, so a project and
  // a node are taller than a phone; eight more projects for Projects, a dozen asks for Your asks, and
  // three more workspaces for Home, two of their sessions asking.
  const bridge = await startTestBridge({ port, fake: true, epoch: CAPTURE_EPOCH, org: (herd, now) => {
    const seed = orgTreeSeed(herd, now, { coordinator: true });
    for (const thread of seed.projects[0]!.threads) {
      const n = Number(/^Tarea cerrada (\d+)$/.exec(String(thread.title))?.[1]);
      if (n <= 30) Object.assign(thread, { status: "open", group: "idle", group_label: "idle", title: `Tarea abierta ${n}`, parent_id: n <= 15 ? "root" : "t-0101" });
    }
    for (let n = 1; n <= 8; n++) seed.projects.push({ slug: `side-${n}`, name: `Proyecto ${n}`, goal: "Un proyecto más para la lista", status: "active", threads: [] });
    seed.asks = Array.from({ length: 12 }, (_, i) => ({ project: "acme", coordinator: { id: "root", title: "" }, line: 5 + i, state: i % 2 ? "working" : "needs-decision",
      text: `Pregunta ${i + 1} sobre el checkout`, answer: "", links: [], confirmed: "", mismatch: "" }));
    return seed;
  } });
  try {
    const herd = bridge.herd!;
    await addDocs(bridge);
    await addPair(bridge);
    await addCrew(bridge);
    // Two more sessions asking, two more of Home's rows: its Recents stop at a count, its asks do not.
    bridge.fake!.setStatus("w6:lead", "blocked");
    bridge.fake!.setStatus("w5:lead", "blocked");
    await writeChatJournal(herd.journals.get(herd.working)!, bridge.now(), 6, "finished");
    const chat = `/pane/${encodeURIComponent(herd.working)}`;
    const screens: Array<{ name: string; path: string; open?: (page: Page) => Promise<void>; sheet?: boolean }> = [
      // Recents, the tall list: Projects, which Home opens on, folds the quiet projects and fits a phone.
      { name: "home", path: "/", open: (page) => page.getByRole("tab", { name: "Recents" }).click() },
      { name: "projects", path: "/projects" },
      { name: "project", path: "/project/acme", open: (page) => page.getByText(/^History/).first().click() },
      { name: "node", path: "/project/acme/node/t-0101" },
      { name: "asks", path: "/asks" },
      { name: "settings", path: "/settings" },
      { name: "chat", path: chat },
      { name: "threads", path: `/pane/${encodeURIComponent(herd.codex)}`, open: (page) => page.getByRole("tab", { name: /^Threads/ }).click() },
      { name: "history", path: `${chat}/history` },
      { name: "search-sheet", path: "/", sheet: true, open: (page) => page.locator(".bottom-tab-bar").getByRole("button", { name: "Search" }).click() },
      { name: "row-sheet", path: "/project/acme", sheet: true, open: (page) => page.getByRole("button", { name: "Panel depósito actions" }).click() },
    ];
    for (const engine of ["webkit", "chromium"] as const) {
      const browser = await launchEngine(engine);
      try {
        for (const [shell, over, under] of [["safari", 0, 0], ["app", 47, 34]] as const) {
          // No service worker: it would serve the CSS from its cache, past the route that sets the insets.
          const context = await browser.newContext({ ...PHONE, timezoneId: "UTC", locale: "en-US", serviceWorkers: "block" });
          const page = await context.newPage();
          let insets = 0;
          await page.route("**/assets/*.css", async (route) => {
            const css = await (await route.fetch()).text();
            const set = (px: number) => () => { insets++; return `${px}px`; };
            await route.fulfill({ contentType: "text/css", body: css
              .replace(/env\(\s*safe-area-inset-top\s*(,[^)]*)?\)/g, set(over))
              .replace(/env\(\s*safe-area-inset-bottom\s*(,[^)]*)?\)/g, set(under)) });
          });
          await page.clock.install({ time: bridge.now() });
          for (const screen of screens) {
            const where = `${engine} ${shell} ${screen.name}`;
            await page.goto(bridge.url + screen.path);
            await page.waitForTimeout(2500);
            if (screen.open) {
              await screen.open(page);
              await page.waitForTimeout(800);
            }
            // Every vertical scroller but a text field's, each scroll offset, and where the fixed chrome stands.
            // A box is named by its tag, two classes and a number it keeps across reads, so two alike stay apart.
            const state = () => page.evaluate(() => {
              const ids = window as unknown as { __e2eBoxes?: number };
              const name = (el: HTMLElement) => {
                el.dataset.e2eBox ??= String(ids.__e2eBoxes = (ids.__e2eBoxes ?? 0) + 1);
                return `${el.tagName.toLowerCase()}.${String(el.className).split(" ").filter(Boolean).slice(0, 2).join(".")}#${el.dataset.e2eBox}`;
              };
              const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
              const scrollers = Array.from(document.querySelectorAll<HTMLElement>("body *"))
                .filter((el) => el.tagName !== "TEXTAREA" && /auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1)
                .map((el) => ({ name: name(el), box: el.dataset.e2eBox!, extra: el.scrollHeight - el.clientHeight, inSheet: !!dialog?.contains(el) }));
              const offsets: Record<string, number> = {};
              for (const el of Array.from(document.querySelectorAll<HTMLElement>("html, body, body *"))) if (el.scrollTop && !dialog?.contains(el)) offsets[name(el)] = Math.round(el.scrollTop);
              const top = (selector: string) => {
                const box = document.querySelector(selector)?.getBoundingClientRect();
                return box && box.height ? Math.round(box.top) : null;
              };
              const panel = dialog?.querySelector(".sheet-bottom-panel")?.getBoundingClientRect();
              return { scrollers, offsets, windowY: scrollY, overscroll: getComputedStyle(document.documentElement).overscrollBehaviorY,
                header: top(".workbench-app-header"), bar: top(".bottom-tab-bar"), composer: top(".workbench-composer"),
                panel: panel ? { top: Math.round(panel.top), bottom: Math.round(panel.bottom) } : null };
            }, null);
            const at = await state();
            const path = join(outDir, `phone-scroll-${screen.name}-${engine}-${shell}.png`);
            await page.screenshot({ path, animations: "disabled" });
            shots.push(path);
            if (at.overscroll !== "none") failures.push(`${where}: the root's overscroll is ${at.overscroll}`);
            const page_ = at.scrollers.filter((s) => !s.inSheet);
            if (!screen.sheet && page_.length !== 1) failures.push(`${where}: ${page_.length} boxes scroll, ${JSON.stringify(page_)}`);
            // A finger from each place, up then down. Only the screen's own box may move, and it must; a sheet moves nothing behind it.
            const own = !screen.sheet && page_.length === 1 ? page_[0]! : null;
            let ownMoved = false;
            const bottom = at.bar ?? at.composer ?? 800;
            // A sheet is dragged in Chromium only: the WebKit stand-in walks the DOM, while an engine chains a
            // fixed layer's scroll by its containing block. Its panel goes up only, since a pull down from the
            // top is the sheet's own dismiss.
            const starts: Array<[string, number, number[]]> = !screen.sheet
              ? [["header", (at.header ?? 0) + 20, [300, -300]], ["middle", 420, [300, -300]], ["bottom", bottom + 20, [300, -300]]]
              : at.panel && engine === "chromium"
                ? [["backdrop", Math.max(80, at.panel.top - 120), [300, -300]], ["panel", Math.round((at.panel.top + at.panel.bottom) / 2), [300]]]
                : [];
            if (screen.sheet && !at.panel) failures.push(`${where}: the sheet did not open`);
            const moved: Record<string, unknown> = {};
            for (const [from, y, pushes] of starts) {
              for (const by of pushes) {
                const before = await state();
                if (screen.sheet && !before.panel) failures.push(`${where}: the sheet closed before a drag from the ${from}`);
                await touchDrag(engine, context, page, y, by);
                const after = await state();
                const changed = Object.keys({ ...before.offsets, ...after.offsets }).filter((k) => before.offsets[k] !== after.offsets[k] && k !== own?.name);
                if (own && before.offsets[own.name] !== after.offsets[own.name]) ownMoved = true;
                const chrome = (["header", "bar", "composer"] as const).filter((k) => after[k] !== before[k]);
                moved[`${from} ${by > 0 ? "up" : "down"}`] = { changed, chrome, windowY: after.windowY };
                if (changed.length || chrome.length || after.windowY !== 0) failures.push(`${where}: a drag ${by > 0 ? "up" : "down"} from the ${from} moved ${[...changed, ...chrome, ...(after.windowY ? ["the window"] : [])].join(", ")}`);
              }
            }
            if (own && !ownMoved) failures.push(`${where}: no drag scrolled ${own.name}`);
            // The end: the screen's box at its bottom, its lowest row of text drawn and not under anything.
            const end = !own ? null : await page.evaluate((id: string) => {
              const box = document.querySelector<HTMLElement>(`[data-e2e-box="${id}"]`);
              if (!box) return null;
              box.scrollTop = box.scrollHeight;
              const drawn = (el: Element) => {
                for (let up = el.parentElement; up && up !== box; up = up.parentElement) if (getComputedStyle(up).overflow !== "visible" && up.getBoundingClientRect().height < 2) return false;
                return el.getBoundingClientRect().height > 0;
              };
              const last = Array.from(box.querySelectorAll("a, button, p, span, h2, h3, li"))
                .filter((el) => drawn(el) && (el.textContent ?? "").trim())
                .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
              if (!last) return null;
              const row = last.getBoundingClientRect();
              const hit = document.elementFromPoint(row.left + Math.min(8, row.width / 2), row.bottom - 3);
              return { text: (last.textContent ?? "").trim().slice(0, 40), bottom: Math.round(row.bottom), boxBottom: Math.round(box.getBoundingClientRect().bottom),
                covered: !hit || !(hit === last || last.contains(hit) || hit.contains(last)) };
            }, own.box);
            if (end?.covered) failures.push(`${where}: the last row "${end.text}" is under something at ${end.bottom}`);
            if (end && end.bottom > end.boxBottom) failures.push(`${where}: the last row ends at ${end.bottom}, past its box's ${end.boxBottom}`);
            if (screen.sheet) await page.keyboard.press("Escape");
            seen[where] = { ...at, offsets: undefined, moved, end };
          }
          if (under && !insets) failures.push(`${engine} ${shell}: no env(safe-area-inset-*) in the CSS to set`);
          await context.close();
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    await bridge.stop();
  }
  const result = { shots, seen, failures };
  await writeFile(join(outDir, "phone-scroll.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ seen, failures }, null, 2));
  if (failures.length) process.exit(1);
}

/**
 * A conversation that ended its turn is no ask: Home on a phone, WebKit and Chromium, dark and light,
 * with its Workspaces list, beside a thread stopped on a real dialog. The conversation (`keep_open`)
 * said `Waiting for you`, as it does before every answer, so Organizations groups it Waiting on you;
 * only the dialog may count in the headline, Needs you, the Home tab's badge and a workspace's state.
 */
async function atRestBench(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const shots: string[] = [];
  const seen: Record<string, unknown> = {};
  const failures: string[] = [];
  const talk = { paneId: "w3:talk", workspaceId: "w3", tabId: "w3:t1", session: "77777777-7777-4777-8777-777777777777" };
  const bridge = await startTestBridge({ port, fake: true, epoch: CAPTURE_EPOCH, org: (herd, now) => {
    const seed = needsYouSeed(herd, now);
    const ago = new Date(now - 60_000).toISOString();
    seed.projects[0]!.threads = [
      { id: "t-0360", title: "Charla de mejoras", parent_id: "root", role: "worker", status: "open", group: "waiting-on-you", group_label: "Waiting on you",
        note: "done", branch: "", workspace_id: talk.workspaceId, tab_id: talk.tabId, pane_id: talk.paneId, cwd: "", updated: ago, report_unacked: true,
        auto_fix_ci: false, auto_merge: false, pr: null, activity: "Waiting for you", percent: null, keep_open: true },
      ...seed.projects[0]!.threads.filter((thread) => thread.id === "t-0002"),
    ];
    return seed;
  } });
  try {
    const herd = bridge.herd!;
    bridge.fake!.addWorkspace(talk.workspaceId, "Charla de mejoras").addTab(talk.tabId, "charla");
    await writeJournal(join(dirname(herd.journals.get(herd.idle)!), `${talk.session}.jsonl`), [["user", "¿Qué mejoramos hoy?"], ["assistant", "Dos cosas: el composer en el celular y la charla que figura como pedido."]], bridge.now());
    bridge.fake!.addPane({ paneId: talk.paneId, workspaceId: talk.workspaceId, tabId: talk.tabId, agent: "claude", label: "Charla de mejoras", sessionId: talk.session,
      cwd: bridge.dir, status: "done", lines: ["● Dos cosas: el composer en el celular y la charla que figura como pedido.", "", "❯ "] });
    for (let tries = 0; !(await (await fetch(bridge.url + "/api/snapshot")).text()).includes(talk.paneId); tries++) {
      if (tries > 60) throw new Error("the bridge never listed the conversation's pane");
      await sleep(500);
    }
    for (const engine of ["webkit", "chromium"] as const) {
      const browser = await launchEngine(engine);
      try {
        for (const scheme of ["dark", "light"] as const) {
          const context = await browser.newContext({ ...PHONE, colorScheme: scheme, timezoneId: "UTC", locale: "en-US" });
          const page = await context.newPage();
          await page.addInitScript(() => { localStorage.setItem("nenu:home-list:v2", "workspaces"); }, null);
          await page.clock.install({ time: bridge.now() });
          await page.goto(bridge.url + "/");
          await page.locator("h1.text-large-title").waitFor({ timeout: 15_000 });
          await page.waitForTimeout(2500);
          const read = await page.evaluate(() => {
            const text = (el: Element | null | undefined) => (el as HTMLElement | null)?.innerText.replace(/\s+/g, " ").trim() ?? null;
            const needs = document.querySelector('section[aria-label="Needs you"]');
            const row = Array.from(document.querySelectorAll("li")).find((li) => /Charla de mejoras/.test(li.textContent ?? "") && !needs?.contains(li));
            return {
              headline: text(document.querySelector("h1.text-large-title")),
              needsYou: needs ? Array.from(needs.querySelectorAll("a")).map(text) : [],
              badge: text(document.querySelector(".bottom-tab-badge")),
              talkRow: text(row),
            };
          }, null);
          seen[`${engine}-${scheme}`] = read;
          const fail = (what: string) => failures.push(`${engine} ${scheme}: ${what}`);
          if (read.headline !== "1 needs you") fail(`headline ${read.headline}`);
          if (read.needsYou.some((row) => /Charla/.test(row ?? ""))) fail(`Needs you lists the conversation: ${JSON.stringify(read.needsYou)}`);
          if (read.badge !== "1") fail(`the Home tab's badge says ${read.badge}`);
          if (!read.talkRow || /Needs you|Waiting for your reply/.test(read.talkRow)) fail(`the conversation's workspace reads ${read.talkRow}`);
          const path = join(outDir, `at-rest-home-${engine}-${scheme}.png`);
          await page.screenshot({ path, animations: "disabled" });
          shots.push(path);
          await context.close();
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    await bridge.stop();
  }
  const result = { shots, seen, failures };
  await writeFile(join(outDir, "at-rest.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (failures.length) process.exit(1);
}

/** Two pictures between a message's words, phone and desk: the composer, what the terminal got, the conversation. */
async function inlineImages(before: boolean): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const result = await withBench((bridge, browser) => inlineImagesBench(bridge, browser, outDir, before), CAPTURE_EPOCH);
  await writeFile(join(outDir, "inline-images.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result.sent, null, 2));
  for (const c of result.checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}${c.ok || !c.detail ? "" : `  (${c.detail})`}`);
  if (result.checks.some((c) => !c.ok)) process.exit(1);
}

async function pasteImage(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const result = await withBench((bridge, browser) => pasteImageBench(bridge, browser, outDir), CAPTURE_EPOCH);
  await writeFile(join(outDir, "paste-image.json"), JSON.stringify(result, null, 2));
  for (const c of result.checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}${c.ok || !c.detail ? "" : `  (${c.detail})`}`);
  if (result.checks.some((c) => !c.ok)) process.exit(1);
}

if (command === "smoke") await smoke();
else if (command === "project") await project();
else if (command === "org") await org();
else if (command === "threads") await threads();
else if (command === "needs-you") await needsYou();
else if (command === "tabs") await tabs();
else if (command === "workspace") await workspace();
else if (command === "workspace-rows") await workspaceRows();
else if (command === "layout") await layout();
else if (command === "stop") await stop();
else if (command === "processes") await processes();
else if (command === "stop-state") await stopState();
else if (command === "baseline") await baseline();
else if (command === "diffs") await diffs(values.before === true);
else if (command === "artifacts") await artifacts();
else if (command === "files") await files();
else if (command === "home") await home();
else if (command === "inspector") await inspector(values.before === true);
else if (command === "terminal") await terminal(values.before === true);
else if (command === "motion") await motion(values.before === true);
else if (command === "back") await back();
else if (command === "surface") await surface();
else if (command === "sidebar") await sidebar(values.before === true);
else if (command === "idle") await idle();
else if (command === "chips") await chips(values.before === true);
else if (command === "chip-line") await chipLine();
else if (command === "composer") await composerAround();
else if (command === "chat") await chat();
else if (command === "scroll") await scrollProbe();
else if (command === "reading") await reading();
else if (command === "pin") await pin();
else if (command === "at-rest") await atRestBench();
else if (command === "inline-images") await inlineImages(values.before === true);
else if (command === "paste-image") await pasteImage();
else if (command === "phone-scroll") await phoneScroll();
else if (command === "compare" && positionals[2]) await compare(positionals[1]!, positionals[2]);
else {
  console.error("usage: bun scripts/e2e/run.ts smoke|project|org|threads|needs-you|tabs|workspace|workspace-rows|layout|stop|processes|stop-state|baseline|diffs|artifacts|files|home|inspector|terminal|motion|back|surface|sidebar|chips|idle|chat|scroll|reading|pin|at-rest|inline-images|paste-image|phone-scroll [--before] [--port 8797] [--out DIR] | compare A.png B.png");
  process.exit(2);
}
