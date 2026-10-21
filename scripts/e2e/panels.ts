import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { brokenRows, DESKTOP, launchEngine, PHONE, reportModel, userCacheDir, type Page } from "./browser.ts";
import { startTestBridge } from "./bridge.ts";
import { homeOrg, seedDemoHerd, seedDiffRepo, writeLongJournal } from "./scenario.ts";

// A desk's three columns around a coordinator: the sidebar, its chat, and the right column that holds
// either its session panel or a thread docked beside it. What moves when a thread docks and leaves,
// when the panel folds and comes back; each edge's grip (drag, double-click, keys, kept on reload);
// and Changes for a coordinator whose own folder is not a repository, beside a worker in one.
//
//   bun scripts/e2e/panels.ts [--port 8797] [--out DIR] [--engine chromium|webkit]

const { values } = parseArgs({ options: { port: { type: "string", default: "8797" }, out: { type: "string" }, engine: { type: "string", default: "chromium" } } });
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), `panels-${Date.now()}`);
const CAPTURE_EPOCH = Date.parse("2026-10-10T14:00:00Z");
await mkdir(outDir, { recursive: true });

// The coordinator works where Organizations puts it, a folder of its own outside the project's repo.
const coordinatorFolder = await mkdtemp(join(tmpdir(), "nenu-e2e-coordinator-"));
const prs = join(outDir, "gh-prs.json");
process.env.NENU_E2E_GH_PRS = prs;
let size = { additions: 0, deletions: 0 };
const bridge = await startTestBridge({
  port: Number(values.port), fake: true, epoch: CAPTURE_EPOCH,
  seed: async (fake, ctx) => {
    const herd = await seedDemoHerd(fake, ctx);
    fake.setCwd(herd.idle, coordinatorFolder);
    return herd;
  },
  org: (herd, now) => {
    const seed = homeOrg(herd, now, size);
    const coordinator = seed.projects[0]!.threads.find((thread) => thread.id === "t-0010")!;
    Object.assign(coordinator, { cwd: coordinatorFolder });
    return seed;
  },
  repo: (dir) => {
    size = seedDiffRepo(dir);
    writeFileSync(join(dir, ".git/info/exclude"), "/*\n!/app/\n!/docs/\n");
    writeFileSync(prs, "[]");
  },
});
const browser = await launchEngine(values.engine === "webkit" ? "webkit" : "chromium").catch(async (error: unknown) => { await bridge.stop(); throw error; });
const herd = bridge.herd!;
const shots: string[] = [];
const result: Record<string, unknown> = {};

async function shoot(page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }) {
  await page.waitForTimeout(500);
  const path = join(outDir, `${name}.png`);
  await page.screenshot({ path, ...(clip ? { clip } : {}) });
  shots.push(path);
}

interface Columns { sidebar: number; chatLeft: number; chatWidth: number; right: number; t?: number }

/** The three columns' edges, rounded to the pixel: the sidebar (or its rail), the chat, the right column. */
const columns = (page: Page) => page.evaluate(() => {
  const width = (selector: string) => Math.round(document.querySelector(selector)?.getBoundingClientRect().width ?? 0);
  const chat = document.querySelector(".project-frame > :first-child")?.getBoundingClientRect();
  const right = document.querySelector(".project-frame > aside")?.getBoundingClientRect();
  return {
    sidebar: width(".workbench-sidebar") || width(".workbench-sidebar-rail"),
    chatLeft: Math.round(chat?.left ?? 0), chatWidth: Math.round(chat?.width ?? 0), right: Math.round(right?.width ?? 0),
  };
}, null) as Promise<Columns>;

/** The columns every animation frame for `ms` after `act`, so a jump and a glide read apart. */
async function track(page: Page, act: () => Promise<void>, ms = 450): Promise<Columns[]> {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: unknown[] };
    w.__frames = [];
    const sample = () => {
      const width = (selector: string) => Math.round(document.querySelector(selector)?.getBoundingClientRect().width ?? 0);
      const chat = document.querySelector(".project-frame > :first-child")?.getBoundingClientRect();
      const right = document.querySelector(".project-frame > aside")?.getBoundingClientRect();
      w.__frames.push({ t: Math.round(performance.now()), sidebar: width(".workbench-sidebar") || width(".workbench-sidebar-rail"), chatLeft: Math.round(chat?.left ?? 0), chatWidth: Math.round(chat?.width ?? 0), right: Math.round(right?.width ?? 0) });
      if (w.__frames.length < 60) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, null);
  await act();
  await page.waitForTimeout(ms);
  const frames = await page.evaluate(() => (window as unknown as { __frames: Columns[] }).__frames, null);
  // Only the frames where something moved.
  const same = (a: Columns, b: Columns) => a.sidebar === b.sidebar && a.chatLeft === b.chatLeft && a.chatWidth === b.chatWidth && a.right === b.right;
  const moved = frames.filter((frame, i) => i === 0 || !same(frame, frames[i - 1]!));
  const t0 = moved[0]?.t ?? 0;
  return moved.map((frame) => ({ ...frame, t: (frame.t ?? 0) - t0 }));
}

/** Drag, double-click, keys and a reload on one grip; each reading is its aria-valuenow. */
async function grip(page: Page, label: RegExp, direction: 1 | -1, name: string) {
  const handle = page.getByRole("separator", { name: label }).first();
  if (!(await handle.count())) return { present: false };
  const value = async () => Number(await handle.getAttribute("aria-valuenow"));
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const start = await value();
  await page.mouse.move(x, y);
  await page.waitForTimeout(250);
  const crop = { x: Math.max(0, x - 120), y: 200, width: 240, height: 160 };
  await page.screenshot({ path: join(outDir, `grip-${name}-hover.png`), clip: crop });
  shots.push(join(outDir, `grip-${name}-hover.png`));
  const hover = await handle.evaluate((element) => {
    const style = getComputedStyle(element, "::after");
    return { cursor: getComputedStyle(element).cursor, seam: style.backgroundColor };
  });
  await page.mouse.down();
  await page.mouse.move(x + direction * 80, y, { steps: 6 });
  await page.mouse.up();
  const dragged = await value();
  await handle.dblclick();
  const reset = await value();
  await handle.focus();
  await page.keyboard.press(direction === 1 ? "ArrowRight" : "ArrowLeft");
  const key = await value();
  await page.keyboard.press("End");
  const end = await value();
  await page.keyboard.press("Home");
  const home = await value();
  await page.keyboard.press(direction === 1 ? "ArrowRight" : "ArrowLeft");
  await page.keyboard.press(direction === 1 ? "ArrowRight" : "ArrowLeft");
  const kept = await value();
  await page.reload();
  await page.getByRole("textbox").first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(400);
  const reloaded = await value();
  return { present: true, min: Number(await handle.getAttribute("aria-valuemin")), max: Number(await handle.getAttribute("aria-valuemax")), start, hover, dragged, reset, key, end, home, kept, reloaded };
}

try {
  // Motion on: the fold's glide is what is measured. Under reduced motion it is instant.
  const context = await browser.newContext({ ...DESKTOP, reducedMotion: "no-preference", colorScheme: "dark", timezoneId: "UTC", locale: "en-US" });
  const page = await context.newPage();
  await page.clock.install({ time: bridge.now() });
  // A model reported, so the rows under the boxes are as full as a real session's.
  await reportModel(page);
  const coordinator = `/pane/${encodeURIComponent(herd.idle)}`;
  await page.goto(bridge.url + coordinator);
  await page.getByRole("textbox").first().waitFor({ timeout: 15_000 });
  // The panel is its own chunk: shoot once it is drawn, not while its place holds empty.
  await page.getByRole("tab", { name: /^Overview/ }).waitFor({ timeout: 15_000 });
  await page.locator(".overview-thread", { hasText: "Checkout flow" }).waitFor({ timeout: 15_000 });
  await shoot(page, "1-coordinator");
  result.coordinator = await columns(page);

  const thread = page.locator(".overview-thread", { hasText: "Checkout flow" }).first();
  result.dock = await track(page, () => thread.click());
  await shoot(page, "2-docked");
  result.undock = await track(page, () => page.getByRole("button", { name: "Close thread" }).click());
  await shoot(page, "3-undocked");

  result.fold = await track(page, () => page.getByRole("button", { name: "Hide session panel" }).click());
  await shoot(page, "4-folded");
  result.unfold = await track(page, () => page.getByRole("button", { name: "Show session panel" }).click());
  const panel = page.getByRole("complementary", { name: "Session panel" });
  await panel.getByRole("tab", { name: /^Changes/ }).click();
  await page.waitForTimeout(800);
  await shoot(page, "5-coordinator-changes");
  result.coordinatorChanges = (await panel.getByRole("tabpanel").innerText()).slice(0, 400);
  await shoot(page, "6-panel-header", { x: 1440 - 520, y: 0, width: 520, height: 64 });

  result.sidebarGrip = await grip(page, /sidebar/i, 1, "sidebar");
  result.panelGrip = await grip(page, /session panel/i, -1, "panel");
  await shoot(page, "7-after-grips");

  await panel.getByRole("tab", { name: /^Overview/ }).click();
  await page.locator(".overview-thread", { hasText: "Checkout flow" }).first().click();
  await page.waitForTimeout(600);
  result.dockedGrip = await grip(page, /thread|session panel|right/i, -1, "docked");
  await shoot(page, "8-docked-after-grip");
  // The docked header at the column's narrowest: the title keeps its room.
  const edge = page.getByRole("separator", { name: "Resize thread" });
  await edge.focus();
  await page.keyboard.press("Home");
  await shoot(page, "8b-docked-narrowest-header", { x: 1440 - 340, y: 0, width: 340, height: 60 });
  // …and the row under its box, its chips beside the model, inside the column (ADR 0108).
  await shoot(page, "8b-docked-narrowest-row", { x: 1440 - 340, y: 900 - 140, width: 340, height: 140 });
  result.rowsNarrowest = await page.evaluate(brokenRows, null);
  await page.keyboard.press("End");
  await shoot(page, "8c-docked-widest");
  result.rowsWidest = await page.evaluate(brokenRows, null);

  // The same fold beside a long conversation (200 turns), with motion and without: each frame's
  // length, the second the one reflow an instant fold costs. No fake clock here: it would drive
  // requestAnimationFrame itself, and the frames would be its timers, not the compositor's.
  await writeLongJournal(herd.journals.get(herd.idle)!, 200, bridge.now());
  for (const motion of ["no-preference", "reduce"] as const) {
    const long = await browser.newContext({ ...DESKTOP, reducedMotion: motion, colorScheme: "dark", timezoneId: "UTC", locale: "en-US" });
    const longPage = await long.newPage();
    await longPage.goto(bridge.url + coordinator);
    await longPage.getByRole("textbox").first().waitFor({ timeout: 15_000 });
    await longPage.waitForTimeout(1500);
    const ticks = () => longPage.evaluate(() => {
      const w = window as unknown as { __ticks: number[] };
      w.__ticks = [];
      const tick = (t: number) => { w.__ticks.push(t); if (w.__ticks.length < 30) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    }, null);
    const read = async () => { await longPage.waitForTimeout(700); return longPage.evaluate(() => { const t = (window as unknown as { __ticks: number[] }).__ticks; return t.slice(1).map((x, i) => Math.round(x - t[i]!)); }, null); };
    result[`longDom-${motion}`] = await longPage.evaluate(() => document.querySelectorAll("*").length, null);
    if (motion === "no-preference") {
      const hide = longPage.getByRole("button", { name: "Hide session panel" });
      if (!(await hide.count())) await longPage.getByRole("button", { name: "Show session panel" }).click();
      await longPage.waitForTimeout(400);
    }
    // Three folds and three opens: each its frames' lengths.
    const runs: number[][] = [];
    for (let run = 0; run < 6; run++) {
      await ticks();
      await longPage.getByRole("button", { name: /session panel/ }).first().click();
      runs.push(await read());
    }
    result[`longFoldFrameMs-${motion}`] = runs;
    await long.close();
  }

  await page.goto(bridge.url + `/pane/${encodeURIComponent(herd.working)}`);
  await page.getByRole("textbox").first().waitFor({ timeout: 15_000 });
  const workerPanel = page.getByRole("complementary", { name: "Session panel" });
  await workerPanel.getByRole("tab", { name: /^Changes/ }).click();
  await page.waitForTimeout(800);
  await shoot(page, "9-worker-changes");
  await context.close();

  const phone = await browser.newContext({ ...PHONE, timezoneId: "UTC", locale: "en-US" });
  const phonePage = await phone.newPage();
  await phonePage.clock.install({ time: bridge.now() });
  await phonePage.goto(bridge.url + coordinator);
  await phonePage.getByRole("textbox").first().waitFor({ timeout: 15_000 });
  await shoot(phonePage, "10-phone-coordinator");
  result.phoneSeparators = await phonePage.getByRole("separator").count();
  await phone.close();
} finally {
  await browser.close();
  await bridge.stop();
  await rm(coordinatorFolder, { recursive: true, force: true });
}
writeFileSync(join(outDir, "panels.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
console.log(shots.join("\n"));
// No row under a box spills or crowds, the docked thread's at its narrowest and widest included (ADR 0108).
const broken = [...(result.rowsNarrowest as string[] ?? []), ...(result.rowsWidest as string[] ?? [])];
if (broken.length) {
  console.error(`✗ a row under the box spills or crowds: ${broken.join(" | ")}`);
  process.exitCode = 1;
}
// Docking a thread and closing it again must move no column (ADR 0105).
const moved = (["dock", "undock"] as const).filter((step) => (result[step] as Columns[]).length > 1);
if (moved.length) {
  console.error(`✗ ${moved.join(" and ")} moved the columns`);
  process.exitCode = 1;
} else console.log("✓ docking and closing a thread move nothing");
