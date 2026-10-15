import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DESKTOP, launchWebkit, PHONE, userCacheDir, type Page } from "./browser.ts";
import { startTestBridge } from "./bridge.ts";
import { writeChatJournal } from "./scenario.ts";

// Opening the phone keyboard on the chat, as Safari on iOS does it. Desktop WebKit opens no keyboard and
// resizes no visual viewport, so the page gets a stand-in `visualViewport` and the probe plays iOS's part:
//
// - A focus that does not carry `preventScroll` makes WebKit scroll the page to centre the field in what
//   the keyboard leaves visible, clamped to the document (WKWebView `_zoomToFocusRect`, skipped when
//   `_focusedElementInformation.preventScroll`). That scroll runs in the UI process with the keyboard's
//   own animation and carries every fixed layer, the whole app, up with it.
// - `visualViewport` reports the new height only after the keyboard has finished rising, and its
//   `scroll` only once the scroll has stopped (react-aria #8888, WebKit bug 218465), so the app can
//   follow only then.
//
// What is real: the tap's focus (a touch pointerdown, then WebKit's own mousedown, focus and click), which
// options that focus carried, and the app's layout once the viewport events arrive. What is modelled: the
// keyboard (336pt, risen over 20 frames), the scroll's size and timing, and the events' timing. The
// region above the keyboard is captured as iOS would show it under that model.
//
//   bun scripts/e2e/keyboard.ts [--port 8847] [--runs 3] [--label NAME] [--out DIR]

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8847" },
    runs: { type: "string", default: "3" },
    label: { type: "string", default: "run" },
    out: { type: "string" },
  },
});
const port = Number(values.port);
const runs = Number(values.runs);
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), `keyboard-${values.label}-${Date.now()}`);
const CAPTURE_EPOCH = Date.parse("2026-10-10T14:00:00Z");
const SCREEN = PHONE.viewport.height;
const KEYBOARD = 336;
const FRAMES = 20;
const DRAFT = "First line of the draft\nsecond line\nthird line\nfourth line";

/** The stand-in viewport, and a record of the options each focus of a text field carried. */
function model(size: { width: number; height: number }): void {
  type Box = { width: number; height: number; offsetTop: number; offsetLeft: number; pageTop: number; pageLeft: number; scale: number };
  // The screen's size, given: innerHeight is not settled yet when an init script runs.
  const box: Box = { ...size, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 };
  const viewport = new EventTarget();
  for (const key of Object.keys(box) as Array<keyof Box>) Object.defineProperty(viewport, key, { get: () => box[key] });
  Object.defineProperty(window, "visualViewport", { configurable: true, get: () => viewport });
  const kb = {
    focuses: [] as Array<{ preventScroll: boolean; refocus: boolean }>,
    set: (next: Partial<Box>) => Object.assign(box, next),
    emit: (...types: string[]) => { for (const type of types) viewport.dispatchEvent(new Event(type)); },
  };
  (window as unknown as { __kb: typeof kb }).__kb = kb;
  let current: FocusOptions | undefined;
  const focus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
    // Focusing the field that already has focus is a refocus: no event, but WebKit sends its options again.
    if (this instanceof HTMLTextAreaElement && document.activeElement === this) kb.focuses.push({ preventScroll: Boolean(options?.preventScroll), refocus: true });
    const outer = current;
    current = options ?? {};
    try { return focus.call(this, options); } finally { current = outer; }
  };
  addEventListener("focus", (event) => {
    if (event.target instanceof HTMLTextAreaElement) kb.focuses.push({ preventScroll: Boolean(current?.preventScroll), refocus: false });
  }, true);
}

type Sample = { header: number; composer: number; last: number; anchor: number | null };

/** Where the chat's pieces sit in the page (layout coordinates), and the line that was at `anchorY`. */
const measure = (page: Page, anchorY: number | null) => page.evaluate((y: number | null) => {
  const top = (selector: string, edge: "top" | "bottom") => document.querySelector(selector)?.getBoundingClientRect()[edge] ?? Number.NaN;
  const marked = document.querySelector("[data-probe-anchor]");
  if (y !== null && !marked) {
    const hit = document.elementFromPoint(195, y);
    (hit?.closest("p, li, pre, h2, h3") ?? hit)?.setAttribute("data-probe-anchor", "");
  }
  const anchor = document.querySelector("[data-probe-anchor]")?.getBoundingClientRect().top ?? null;
  const speakers = document.querySelectorAll("[data-speaker]");
  return { header: top("[data-chat-chrome]", "top"), composer: top(".composer-box", "bottom"),
    last: speakers[speakers.length - 1]?.getBoundingClientRect().bottom ?? Number.NaN, anchor };
}, anchorY);

const frame = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())), null);
const round = (n: number | null) => (n === null || Number.isNaN(n) ? null : Math.round(n));

async function tapAndOpen(page: Page, name: string, run: number) {
  const field = await page.evaluate(() => {
    const el = document.querySelector("textarea")!.getBoundingClientRect();
    return { x: el.left + 24, y: el.top + 14, top: el.top, height: el.height };
  }, null);
  const rest = await measure(page, 300);
  const before = await page.evaluate(() => {
    const el = document.activeElement;
    const hit = document.elementFromPoint(195, 300);
    return { active: el ? `${el.tagName}.${el.className}`.slice(0, 60) : null, hit: hit ? `${hit.tagName}.${String(hit.className).slice(0, 40)}` : null, caretApi: typeof document.caretPositionFromPoint };
  }, null);
  // The finger lands: a touch pointerdown, as iOS sends at touch start, then WebKit's own press, focus and click.
  await page.evaluate(([x, y]: [number, number]) => {
    document.querySelector("textarea")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", clientX: x, clientY: y, isPrimary: true }));
  }, [field.x, field.y] as [number, number]);
  await page.mouse.click(field.x, field.y);
  const focus = await page.evaluate(() => {
    const kb = (window as unknown as { __kb: { focuses: Array<{ preventScroll: boolean; refocus: boolean }> } }).__kb;
    const el = document.querySelector("textarea")!;
    return { focuses: kb.focuses.splice(0), active: document.activeElement === el, caret: el.selectionStart };
  }, null);
  // Where WebKit itself puts the caret for that point.
  const natural = await page.evaluate(([x, y]: [number, number]) => {
    const at = document.caretPositionFromPoint?.(x, y);
    return at?.offsetNode instanceof HTMLTextAreaElement ? at.offset : null;
  }, [field.x, field.y] as [number, number]);
  // WebKit reveals the field unless every focus it was told about carried preventScroll.
  const visible = SCREEN - KEYBOARD;
  const reveals = focus.focuses.length > 0 && focus.focuses.some((f) => !f.preventScroll);
  const pan = reveals ? Math.max(0, Math.min(SCREEN - visible, field.top - (visible - field.height) / 2)) : 0;

  const frames: Array<{ header: number; composerOverKeys: number }> = [];
  for (let f = 1; f <= FRAMES; f++) {
    const t = f / FRAMES;
    const ease = 1 - (1 - t) ** 3;
    const scrolled = pan * ease;
    const keysTop = SCREEN - KEYBOARD * ease;
    await frame(page);
    const at = await measure(page, null);
    frames.push({ header: round(at.header - scrolled)!, composerOverKeys: round(keysTop - (at.composer - scrolled))! });
    if (f === FRAMES && run === 1) await page.screenshot({ path: join(outDir, `${name}-risen.png`), clip: { x: 0, y: pan, width: PHONE.viewport.width, height: visible } });
  }
  // The keyboard is up and the scroll has stopped: the viewport says so now.
  await page.evaluate(([height, top]: [number, number]) => {
    const kb = (window as unknown as { __kb: { set(next: Record<string, number>): void; emit(...types: string[]): void } }).__kb;
    kb.set({ height, offsetTop: top, pageTop: top });
    kb.emit("resize", "scroll");
  }, [visible, pan] as [number, number]);
  for (let i = 0; i < 4; i++) await frame(page);
  await page.waitForTimeout(400);
  const settled = await measure(page, null);
  const field2 = await page.evaluate(() => { const el = document.querySelector("textarea")!; return { client: el.clientHeight, scroll: el.scrollHeight }; }, null);
  if (run === 1) await page.screenshot({ path: join(outDir, `${name}-settled.png`), clip: { x: 0, y: pan, width: PHONE.viewport.width, height: visible } });
  // What else rides on the viewport: a bottom sheet's box against the keys. (The file viewer's backdrop
  // reads the same two variables, from a stylesheet that loads only with the viewer.)
  const sheet = await page.evaluate(() => {
    const el = document.createElement("div");
    el.className = "sheet-viewport fixed inset-x-0";
    document.body.append(el);
    const box = el.getBoundingClientRect();
    el.remove();
    return { top: box.top, bottom: box.bottom };
  }, null);

  // And down again.
  await page.evaluate(([height]: [number]) => {
    const kb = (window as unknown as { __kb: { set(next: Record<string, number>): void; emit(...types: string[]): void } }).__kb;
    (document.activeElement as HTMLElement | null)?.blur();
    kb.set({ height, offsetTop: 0, pageTop: 0 });
    kb.emit("resize", "scroll");
  }, [SCREEN] as [number]);
  for (let i = 0; i < 4; i++) await frame(page);
  await page.waitForTimeout(400);
  const closed = await measure(page, null);

  const worst = Math.min(...frames.map((f) => f.header));
  return {
    before,
    focus: { focuses: focus.focuses, active: focus.active, caret: focus.caret, naturalCaret: natural },
    pan: Math.round(pan),
    rest: { header: round(rest.header), composer: round(rest.composer), last: round(rest.last), anchor: round(rest.anchor) },
    rising: { headerLowest: worst, headerJump: round(rest.header - worst), framesHeaderOff: frames.filter((f) => f.header < -1).length,
      framesComposerUnderKeys: frames.filter((f) => f.composerOverKeys < -1).length },
    settled: { header: round(settled.header - pan), composerOverKeys: round(visible - (settled.composer - pan)), last: round(settled.last - pan),
      anchorMoved: settled.anchor === null || rest.anchor === null ? null : round(settled.anchor - pan - rest.anchor), field: field2,
      sheet: { top: round(sheet.top - pan), bottom: round(sheet.bottom - pan), keysTop: visible } },
    closed: { header: round(closed.header), composer: round(closed.composer), backToRest: Math.abs(closed.header - rest.header) < 1 && Math.abs(closed.composer - rest.composer) < 1 },
  };
}

await mkdir(outDir, { recursive: true });
const bridge = await startTestBridge({ port, fake: true, epoch: CAPTURE_EPOCH });
const herd = bridge.herd!;
await writeChatJournal(herd.journals.get(herd.idle)!, bridge.now() - 60_000, 2);
const path = `/pane/${encodeURIComponent(herd.idle)}`;
const browser = await launchWebkit();
const results: Array<Record<string, unknown>> = [];
try {
  for (let run = 1; run <= runs; run++) {
    const result: Record<string, unknown> = { run };
    for (const scenario of ["empty", "draft4"] as const) {
      const context = await browser.newContext({ ...PHONE, timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      await page.addInitScript(model, PHONE.viewport);
      await page.clock.install({ time: bridge.now() });
      await page.goto(bridge.url + path);
      await page.locator("textarea").first().waitFor({ timeout: 15_000 });
      await page.locator("[data-speaker]").first().waitFor({ timeout: 15_000 });
      if (scenario === "draft4") {
        await page.locator("textarea").first().fill(DRAFT);
        await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); (window as unknown as { __kb: { focuses: unknown[] } }).__kb.focuses.length = 0; }, null);
      }
      await page.waitForTimeout(1500);
      if (run === 1) await page.screenshot({ path: join(outDir, `${scenario}-rest.png`) });
      result[scenario] = await tapAndOpen(page, scenario, run);
      await context.close();
    }
    results.push(result);
  }
  // The desk is not touched by any of this: one capture of the same chat, to compare across builds.
  const context = await browser.newContext({ ...DESKTOP, timezoneId: "UTC", locale: "en-US" });
  const page = await context.newPage();
  await page.clock.install({ time: bridge.now() });
  await page.goto(bridge.url + path);
  await page.locator("[data-speaker]").first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(outDir, "desk-chat.png"), animations: "disabled" });
  await context.close();
} finally {
  await browser.close();
  await bridge.stop();
}
const summary = { label: values.label, model: { screen: SCREEN, keyboard: KEYBOARD, frames: FRAMES }, results, out: outDir };
await writeFile(join(outDir, "keyboard.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
