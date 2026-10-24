import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DESKTOP, launchChrome, PHONE, userCacheDir, type Browser, type Page } from "./browser.ts";
import { startTestBridge } from "./bridge.ts";

// What loading draws, on a phone and a desk, with the reads slowed to what a real host takes: a chat
// opened again after a few seconds (frames that show the skeleton, frames to its text; then on a slow
// link, where it must say it is updating), and a direct load (which boot screens follow each other
// before the page). Chrome, for the Layout Instability API.
//
//   bun scripts/e2e/load.ts [--port 8799] [--out DIR] [--delay 400]

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8799" },
    out: { type: "string" },
    delay: { type: "string", default: "400" },
  },
});
const port = Number(values.port);
const delay = Number(values.delay);
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), `load-${Date.now()}`);
const CAPTURE_EPOCH = Date.parse("2026-10-16T14:00:00Z");
const CHAT = "/pane/w1%3Aidle";

// Recorded from the first script on every page: layout shifts, and per frame which loading screen
// is up (the HTML splash, React's boot splash, the chat skeleton) and whether the chat's text is.
const PROBE = () => {
  const w = window as unknown as { __shifts: Array<{ t: number; v: number; src: string[] }>; __frames: Array<{ t: number; path: string; screen: string; text: boolean }> };
  w.__shifts = [];
  w.__frames = [];
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: Array<{ node?: Node | null }> }>) {
        if (entry.hadRecentInput) continue;
        w.__shifts.push({ t: Math.round(entry.startTime), v: entry.value, src: (entry.sources ?? []).map((s) => {
          const el = s.node as Element | null | undefined;
          return el && el.nodeType === 1 ? `${el.tagName.toLowerCase()}[${el.getAttribute("aria-label") ?? ""}] «${(el.textContent ?? "").trim().slice(0, 30)}»` : "#text";
        }) });
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch { /* not Chrome */ }
  const frame = () => {
    const doc = document;
    // The HTML splash counts only while its caption is drawn (it can sit hidden, as plain background).
    const caption = doc.querySelector(".boot-splash > span");
    const screen = caption && getComputedStyle(caption).visibility !== "hidden" && !doc.querySelector(".app-viewport") ? "html-splash"
      : Array.from(doc.querySelectorAll("[role='status']")).some((el) => /^Connecting to/.test(el.textContent ?? "")) ? "boot-splash"
      : doc.querySelector("[data-slot='transcript-skeleton']") ? "skeleton"
      : doc.querySelector(".app-viewport") ? "app" : "blank";
    const text = (doc.body?.innerText ?? "").includes("Looking at the idle pane now.");
    const last = w.__frames.at(-1);
    const path = location.pathname;
    if (!last || last.screen !== screen || last.text !== text || last.path !== path) w.__frames.push({ t: Math.round(performance.now()), path, screen, text });
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
};

type Probe = { shifts: Array<{ t: number; v: number; src: string[] }>; frames: Array<{ t: number; path: string; screen: string; text: boolean }> };
const read = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __shifts: Probe["shifts"]; __frames: Probe["frames"] };
  return { shifts: w.__shifts, frames: w.__frames, now: Math.round(performance.now()) };
}, null) as Promise<Probe & { now: number }>;

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const shots: string[] = [];
  const failures: string[] = [];
  const bridge = await startTestBridge({ port, fake: true, epoch: CAPTURE_EPOCH });
  let browser: Browser | null = null;
  try {
    browser = await launchChrome();
    const open = async (device: Record<string, unknown>, slow: { snapshot?: number; history?: number } = {}) => {
      const context = await browser!.newContext({ ...device, timezoneId: "UTC", locale: "en-US" }) as Awaited<ReturnType<Browser["newContext"]>> & {
        addInitScript(fn: () => void): Promise<void>;
        route(url: string, handler: (route: { request(): { method(): string; url(): string }; continue(): Promise<void> }) => Promise<void>): Promise<void>;
      };
      await context.addInitScript(PROBE);
      // The read a real host is slow at: the journal. The snapshot only on a cold boot.
      await context.route("**/api/**", async (route) => {
        const { pathname } = new URL(route.request().url());
        const wait = /\/history$/.test(pathname) ? slow.history ?? delay : pathname === "/api/snapshot" ? slow.snapshot ?? 0 : 0;
        if (wait) await Bun.sleep(wait);
        await route.continue().catch(() => {});
      });
      const page = await context.newPage();
      return { page, context };
    };
    const shoot = async (page: Page, name: string) => {
      const path = join(outDir, `${name}.png`);
      await page.screenshot({ path });
      shots.push(path);
    };
    const tapLink = (page: Page, href: string) => page.evaluate((target: string) => {
      const link = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).find((a) => a.getAttribute("href") === target && a.offsetParent !== null);
      if (link) return link.click();
      // No row link on screen: the same in-app navigation.
      history.pushState({ idx: (history.state?.idx ?? 0) + 1 }, "", target);
      dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    }, href);

    const results: Record<string, unknown> = {};
    for (const [name, device] of [["phone", PHONE], ["desk", DESKTOP]] as const) {
      // A chat: opened, left for Home, opened again.
      {
        const slow: { history?: number } = {};
        const { page, context } = await open(device, slow);
        const chat = CHAT;
        await page.goto(bridge.url + "/");
        await page.waitForTimeout(1500);
        await tapLink(page, chat);
        await page.getByText("Looking at the idle pane now.").first().waitFor({ timeout: 10_000 });
        await page.waitForTimeout(1500);
        await page.evaluate(() => history.back(), null);
        await page.waitForTimeout(3000);
        const mark = (await read(page)).now;
        await tapLink(page, chat);
        await page.waitForTimeout(80);
        await shoot(page, `chat-again-${name}`);
        await page.waitForTimeout(delay + 1000);
        const frames = (await read(page)).frames.filter((f) => f.t >= mark);
        const onChat = frames.filter((f) => f.path.startsWith("/pane/"));
        const firstText = onChat.find((f) => f.text);
        const skeletonMs = onChat.filter((f) => f.screen === "skeleton").length
          ? (onChat.find((f, i) => i > 0 && f.screen !== "skeleton" && onChat[i - 1]!.screen === "skeleton")?.t ?? 0) - onChat.find((f) => f.screen === "skeleton")!.t : 0;
        const again = { skeletonMs, firstFrameHasText: onChat[0]?.text === true, msToText: firstText && onChat[0] ? firstText.t - onChat[0].t : null, frames: onChat };
        results[`chat-again-${name}`] = again;
        if (skeletonMs > 0) failures.push(`chat-again-${name}: skeleton for ${skeletonMs} ms`);
        if (!again.firstFrameHasText) failures.push(`chat-again-${name}: the first frame has no text`);
        // Opened again on a slow link: the remembered conversation says it is updating until its read lands.
        await page.evaluate(() => history.back(), null);
        await page.waitForTimeout(1500);
        slow.history = 2500;
        await tapLink(page, chat);
        await page.waitForTimeout(900);
        const marked = await page.evaluate(() => Array.from(document.querySelectorAll("[role='status']")).filter((el) => el.textContent === "Updating…")
          .map((el) => { const box = el.getBoundingClientRect(); return { top: Math.round(box.top), height: Math.round(box.height), visible: box.height > 0 && getComputedStyle(el).visibility !== "hidden" }; }), null) as Array<{ top: number; height: number; visible: boolean }>;
        await shoot(page, `chat-slow-${name}`);
        await page.waitForTimeout(2500);
        const cleared = await page.getByText("Updating…").count();
        results[`chat-slow-${name}`] = { markedAt900ms: marked.some((m) => m.visible), mark: marked, clearedAfterRead: cleared === 0 };
        if (!marked.some((m) => m.visible)) failures.push(`chat-slow-${name}: no Updating mark while the read is slow`);
        if (cleared) failures.push(`chat-slow-${name}: the mark stayed after the read`);
        await context.close();
      }
      // A direct load, the snapshot slowed so each boot screen is seen.
      {
        const { page, context } = await open(device, { snapshot: 1500 });
        void page.goto(bridge.url + CHAT, { waitUntil: "domcontentloaded" }).catch(() => {});
        await page.waitForTimeout(150);
        await shoot(page, `boot-early-${name}`);
        await page.waitForTimeout(900);
        await shoot(page, `boot-late-${name}`);
        await page.getByText("Looking at the idle pane now.").first().waitFor({ timeout: 10_000 });
        await page.waitForTimeout(300);
        const frames = (await read(page)).frames.filter((f, i, all) => f.screen !== all[i - 1]?.screen);
        // Each screen in turn and how long it stayed up.
        const screens = frames.map((f, i) => `${f.screen} ${frames[i + 1] ? frames[i + 1]!.t - f.t : "…"} ms`);
        const boot = frames.map((f) => f.screen).filter((s) => s === "html-splash" || s === "boot-splash");
        results[`boot-${name}`] = { screens, bootScreens: boot.length };
        if (boot.length > 1) failures.push(`boot-${name}: ${boot.join(" → ")}`);
        await context.close();
      }
    }

    const result = { outDir, delay, shots, results, failures };
    await writeFile(join(outDir, "load.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser?.close();
    await bridge.stop();
  }
  if (failures.length) process.exit(1);
}

await main();
