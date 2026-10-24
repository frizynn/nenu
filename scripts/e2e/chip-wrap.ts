import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { DESKTOP, PHONE, type Browser, type Page } from "./browser.ts";
import type { TestBridge } from "./bridge.ts";

// The chip-wrap bench: a picture's chip in the draft walked along a line, one letter at a time, until
// it has crossed the line's end, on a phone and a desk. A chip is one unit: at every step its pill is
// one box, its icon sits inside that box at the text's height, and the chips' layer wraps the draft
// exactly where the textarea does. The operator saw the chip split at a line's end on an iPhone
// (2.0.0): the icon alone in an empty pill, "Image" outside it and "#2" in a pill on the next line
// (run.ts `chip-wrap`, which runs it under WebKit and Chromium). Chromium reproduces the break after
// the blank cells; Playwright's WebKit breaks at neither place, so the break iOS Safari's textarea
// takes at a no-break space is held only by the chip's exact form (message-images.test.ts).

export interface Check { name: string; ok: boolean; detail?: string }

const BEFORE = "lo mismo con los 3 puntitos ";
const AFTER = " hay cosas que ya se pueden hacer";

/** Each chip's pill boxes and icon from the draft's top (the box grows upward as it fills), and
 *  whether the chips' layer and the textarea wrap alike. */
function measure() {
  const field = document.querySelector("textarea")!;
  const layer = document.querySelector<HTMLElement>(".draft-chip-layer");
  const top = field.getBoundingClientRect().top - field.scrollTop;
  const round = (r: DOMRect) => ({ left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top - top), bottom: Math.round(r.bottom - top) });
  const chips = Array.from(document.querySelectorAll(".draft-chip")).map((chip) => ({
    boxes: Array.from(chip.getClientRects()).map(round),
    icon: round(chip.querySelector(".draft-chip-icon")!.getBoundingClientRect()),
  }));
  return { chips, field: field.scrollHeight, layer: layer?.scrollHeight ?? null };
}

async function pngOf(page: Page, colour: string): Promise<Buffer> {
  return Buffer.from(await page.evaluate(async (fill: string) => {
    const canvas = document.createElement("canvas");
    canvas.width = 40;
    canvas.height = 40;
    const g = canvas.getContext("2d")!;
    g.fillStyle = fill;
    g.fillRect(0, 0, 40, 40);
    return Array.from(new Uint8Array(await (await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"))).arrayBuffer()));
  }, colour));
}

export async function chipWrapBench(bridge: TestBridge, browser: Browser, engine: string, outDir: string): Promise<{ checks: Check[]; shots: string[]; seen: Record<string, unknown> }> {
  const checks: Check[] = [];
  const shots: string[] = [];
  const seen: Record<string, unknown> = {};
  const pane = bridge.herd!.idle;
  for (const [name, device] of [["phone", PHONE], ["desk", DESKTOP]] as const) {
    const context = await browser.newContext({ ...device, timezoneId: "UTC", locale: "en-US" });
    const page = await context.newPage();
    await page.goto(`${bridge.url}/pane/${encodeURIComponent(pane)}`);
    const box = page.getByRole("textbox").first();
    await box.waitFor({ timeout: 20_000 });
    await page.waitForTimeout(1200);
    const picker = page.locator('input[type="file"]').first();
    const settle = () => page.waitForFunction(() => !document.querySelector('[aria-label="Attached files"] [aria-busy="true"]'), null, { timeout: 15_000 })
      .then(() => page.waitForTimeout(300));

    await box.click();
    await page.keyboard.type("una ");
    await picker.setInputFiles({ name: "uno.png", mimeType: "image/png", buffer: await pngOf(page, "#c33") });
    await settle();
    await page.keyboard.type(` ${BEFORE}`);
    await picker.setInputFiles({ name: "dos.png", mimeType: "image/png", buffer: await pngOf(page, "#36c") });
    await settle();
    await page.keyboard.type(AFTER);

    // Walk the second chip to the right one letter at a time, typed before the words ahead of it, until it
    // has moved down a line: a split can be narrower than two letters.
    const startTop = (await page.evaluate(measure, null)).chips[1]!.boxes[0]!.top;
    const bad: unknown[] = [];
    const save = async (label: string, bytes: Uint8Array) => {
      const path = join(outDir, `chip-wrap-${engine}-${name}-${label}.png`);
      await writeFile(path, bytes);
      shots.push(path);
    };
    let steps = 0;
    let edge: Uint8Array | null = null;
    for (; steps < 400; steps++) {
      const m = await page.evaluate(measure, null);
      const frame = await page.screenshot({ animations: "disabled" });
      const split = m.chips.filter((c) => c.boxes.length !== 1 || c.icon.left < c.boxes[0]!.left || c.icon.right > c.boxes[0]!.right || c.icon.top < c.boxes[0]!.top || c.icon.bottom > c.boxes[0]!.bottom);
      if (split.length || m.field !== m.layer) {
        if (!bad.length) await save("split", frame);
        bad.push({ steps, ...m });
      }
      // The last moment on the line and the first on the next, as the eye sees them.
      if (m.chips[1]!.boxes[0]!.top > startTop + 4) {
        if (edge) await save("edge", edge);
        await save("moved", frame);
        break;
      }
      edge = frame;
      await page.evaluate((at: number) => {
        const field = document.querySelector("textarea")!;
        field.focus();
        field.setSelectionRange(at, at);
      }, (await box.inputValue()).indexOf(BEFORE));
      await page.keyboard.type("x");
    }
    seen[`${engine}-${name}`] = { steps, bad: bad.slice(0, 3), last: await page.evaluate(measure, null) };
    checks.push({ name: `${engine} ${name}: the chip crossed a line's end`, ok: steps < 400, detail: `${steps} steps` });
    checks.push({ name: `${engine} ${name}: every chip stayed one pill with its icon inside, and the layer wrapped as the draft`, ok: bad.length === 0, detail: JSON.stringify(bad.slice(0, 2)) });
    await context.close();
  }
  return { checks, shots, seen };
}
