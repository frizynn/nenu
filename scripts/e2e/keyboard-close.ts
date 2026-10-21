import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { launchWebkit, PHONE, userCacheDir, type Page } from "./browser.ts";
import { startTestBridge } from "./bridge.ts";
import { writeChatJournal } from "./scenario.ts";

// Closing the phone keyboard on the chat, along every way iOS has been seen to leave the app at the
// keyboard's height: the app must fill the screen again. Desktop WebKit has no keyboard and no visual
// viewport that moves, so the page gets a stand-in `visualViewport` and the probe plays iOS's part.
//
// - events: the keyboard goes down and `visualViewport` says so at once (the control).
// - late: the order iOS sends them in: the field blurs, and the viewport says so once the keyboard is down.
// - lost: the field blurs and the viewport is full again, but no `resize` or `scroll` arrives.
// - stuck-offset: iOS 26 leaves `visualViewport.offsetTop` above 0 after the keyboard goes down, with no
//   event (Apple forums 800125/800154, WebKit bug 297779): the screen shows the page from that offset.
// - zoom: the one `resize` arrives while the page is still zoomed (scale != 1), then the zoom ends silently.
// - background: the keyboard closes while the app is in the background, focus kept; on the way back only
//   `visibilitychange` and `pageshow` fire.
// - rotate: the phone turns with the keyboard up; only the window's `resize` fires.
//
// Each runs in Safari (no insets) and as the installed app (47/34 px insets). What is real: the app's
// layout from whatever events reach it. What is modelled: the keyboard's 336 px, the 110 px offset, the
// events that iOS sends or loses. Where the screen shows the page from `offsetTop`, a box's place on the
// screen is its place in the page minus that offset, and the captures are drawn shifted the same way.
//
//   bun scripts/e2e/keyboard-close.ts [--port 8849] [--label NAME] [--out DIR]

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8849" },
    label: { type: "string", default: "run" },
    out: { type: "string" },
  },
});
const port = Number(values.port);
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), `keyboard-close-${values.label}-${Date.now()}`);
const CAPTURE_EPOCH = Date.parse("2026-10-10T14:00:00Z");
const SCREEN = PHONE.viewport;
const KEYBOARD = 336;
const STUCK_OFFSET = 110;

type Box = { width: number; height: number; offsetTop: number; offsetLeft: number; pageTop: number; pageLeft: number; scale: number };
type Kb = { box: Box; set(next: Partial<Box>): void; emit(types: string[]): void; hidden(on: boolean): void; pageshow(): void };
type Step = ["set", Partial<Box>] | ["emit", string[]] | ["hidden", boolean] | ["pageshow", null];

/** The stand-in viewport, and a page visibility the probe can flip. */
function model(size: { width: number; height: number }): void {
  const box: Box = { ...size, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 };
  const viewport = new EventTarget();
  for (const key of Object.keys(box) as Array<keyof Box>) Object.defineProperty(viewport, key, { get: () => box[key] });
  Object.defineProperty(window, "visualViewport", { configurable: true, get: () => viewport });
  let hidden = false;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  const kb: Kb = {
    box,
    set: (next) => Object.assign(box, next),
    emit: (types) => { for (const type of types) viewport.dispatchEvent(new Event(type)); },
    hidden: (on) => { hidden = on; document.dispatchEvent(new Event("visibilitychange")); },
    pageshow: () => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
  };
  (window as unknown as { __kb: Kb }).__kb = kb;
}

/** Plays iOS's part: each step changes the stand-in viewport or sends an event, in order. */
const act = (page: Page, ...steps: Step[]) => page.evaluate((list: Step[]) => {
  const k = (window as unknown as { __kb: Kb }).__kb;
  for (const [op, arg] of list) (k[op] as (a: unknown) => void)(arg);
}, steps);

/** Where the app and the chat's header sit on the screen, the screen itself, whether the chat thinks
 * the keyboard is up (it then hides the model row and the navigation band), and whether the thread left
 * its tail: it was following before the keyboard went down, and a list growing back is no reader's move. */
const onScreen = (page: Page) => page.evaluate(() => {
  const box = (window as unknown as { __kb: Kb }).__kb.box;
  const app = document.querySelector(".app-viewport")!.getBoundingClientRect();
  const header = document.querySelector("[data-chat-chrome]")?.getBoundingClientRect();
  return { top: Math.round(app.top - box.offsetTop), bottom: Math.round(app.bottom - box.offsetTop),
    header: header ? Math.round(header.top - box.offsetTop) : null, screen: box.height,
    keyboard: document.querySelector("[data-keyboard-open]") !== null,
    leftTail: document.querySelector('[aria-label^="Scroll to latest"]') !== null };
}, null);

const open = async (page: Page) => {
  await page.evaluate(() => document.querySelector("textarea")!.focus({ preventScroll: true }), null);
  await act(page, ["set", { height: SCREEN.height - KEYBOARD }], ["emit", ["resize"]]);
  await page.waitForTimeout(600);
};
const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur(), null);

const paths: Record<string, (page: Page) => Promise<void>> = {
  events: async (page) => {
    await blur(page);
    await act(page, ["set", { height: SCREEN.height }], ["emit", ["resize", "scroll"]]);
  },
  late: async (page) => {
    await blur(page);
    await page.waitForTimeout(400);
    await act(page, ["set", { height: SCREEN.height }], ["emit", ["resize", "scroll"]]);
  },
  lost: async (page) => {
    await blur(page);
    await act(page, ["set", { height: SCREEN.height }]);
  },
  "stuck-offset": async (page) => {
    await blur(page);
    await page.waitForTimeout(300);
    await act(page, ["set", { height: SCREEN.height, offsetTop: STUCK_OFFSET, pageTop: STUCK_OFFSET }]);
  },
  zoom: async (page) => {
    await blur(page);
    await act(page, ["set", { scale: 1.25, height: SCREEN.height / 1.25 }], ["emit", ["resize"]]);
    await page.waitForTimeout(150);
    await act(page, ["set", { scale: 1, height: SCREEN.height }]);
  },
  background: async (page) => {
    await act(page, ["hidden", true], ["set", { height: SCREEN.height }]);
    await page.waitForTimeout(300);
    await act(page, ["hidden", false], ["pageshow", null]);
  },
  rotate: async (page) => {
    await act(page, ["set", { width: SCREEN.height, height: SCREEN.width }]);
    await page.setViewportSize({ width: SCREEN.height, height: SCREEN.width });
  },
};

await mkdir(outDir, { recursive: true });
const bridge = await startTestBridge({ port, fake: true, epoch: CAPTURE_EPOCH });
const herd = bridge.herd!;
await writeChatJournal(herd.journals.get(herd.idle)!, bridge.now() - 60_000, 2);
const chat = `/pane/${encodeURIComponent(herd.idle)}`;
const browser = await launchWebkit();
const results: Array<Record<string, unknown>> = [];
const failures: string[] = [];
try {
  for (const [shell, over, under] of [["safari", 0, 0], ["app", 47, 34]] as const) {
    for (const [name, close] of Object.entries(paths)) {
      // No service worker: it would serve the CSS from its cache, past the route that sets the insets.
      const context = await browser.newContext({ ...PHONE, timezoneId: "UTC", locale: "en-US", serviceWorkers: "block" });
      const page = await context.newPage();
      await page.route("**/assets/*.css", async (route) => {
        const css = await (await route.fetch()).text();
        await route.fulfill({ contentType: "text/css", body: css
          .replace(/env\(\s*safe-area-inset-top\s*(,[^)]*)?\)/g, `${over}px`)
          .replace(/env\(\s*safe-area-inset-bottom\s*(,[^)]*)?\)/g, `${under}px`) });
      });
      await page.addInitScript(model, SCREEN);
      await page.clock.install({ time: bridge.now() });
      await page.goto(bridge.url + chat);
      await page.locator("textarea").first().waitFor({ timeout: 15_000 });
      await page.locator("[data-speaker]").first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1500);
      const rest = await onScreen(page);
      await open(page);
      const typing = await onScreen(page);
      await close(page);
      await page.waitForTimeout(1500);
      const closed = await onScreen(page);
      // The screen shows the page from offsetTop: draw the capture shifted the same way.
      await page.evaluate(() => { document.documentElement.style.translate = `0 ${-(window as unknown as { __kb: Kb }).__kb.box.offsetTop}px`; }, null);
      await page.screenshot({ path: join(outDir, `${shell}-${name}.png`) });
      await context.close();
      const ok = closed.top === 0 && closed.bottom === closed.screen && closed.header !== null && closed.header >= 0 && !closed.keyboard && !closed.leftTail;
      const opened = typing.bottom === SCREEN.height - KEYBOARD && typing.keyboard;
      if (!ok) failures.push(`${shell} ${name}: app ${closed.top}..${closed.bottom} on a ${closed.screen} px screen, header at ${closed.header}${closed.keyboard ? ", keyboard still read as up" : ""}${closed.leftTail ? ", thread left its tail" : ""}`);
      if (!opened) failures.push(`${shell} ${name}: with the keyboard up the app ends at ${typing.bottom}, not ${SCREEN.height - KEYBOARD}${typing.keyboard ? "" : ", keyboard not read as up"}`);
      results.push({ shell, path: name, rest, typing, closed, ok: ok && opened });
    }
  }
} finally {
  await browser.close();
  await bridge.stop();
}
const summary = { label: values.label, model: { screen: SCREEN, keyboard: KEYBOARD, stuckOffset: STUCK_OFFSET }, results, failures, out: outDir };
await writeFile(join(outDir, "keyboard-close.json"), JSON.stringify(summary, null, 2));
for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${String(r.shell).padEnd(6)} ${String(r.path).padEnd(12)} closed ${JSON.stringify(r.closed)}`);
console.log(failures.length ? `\n${failures.length} failures\n${failures.join("\n")}` : "\nall paths fill the screen");
console.log(outDir);
process.exit(failures.length ? 1 : 0);
