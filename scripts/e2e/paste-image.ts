import { join } from "node:path";

import { DESKTOP, PHONE, type Browser, type Page } from "./browser.ts";
import type { TestBridge } from "./bridge.ts";

// The paste-image bench: pictures pasted and picked between a draft's words, on a phone with the
// keyboard down and up and on a desk, with a short draft and a long one holding three pictures. On a
// phone with the keyboard up and a draft typed, the + gives its width to the draft; the box once laid
// the draft out beside the thumbnails at no width, so the words ran off the box's right edge and
// nothing showed (operator, 1.38.1). Each moment checks that the draft spans the box, the chips' layer
// lies on the draft, and every chip is inside it (run.ts `paste-image`).

export interface Check { name: string; ok: boolean; detail?: string }

const LONG = "este es un texto largo que sigue y sigue para ver como envuelve las lineas dentro de la caja ";

/** A picture pasted from the clipboard into the draft, as a phone's paste hands one over. */
function paste(page: Page) {
  return page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 60;
    canvas.height = 40;
    const g = canvas.getContext("2d")!;
    g.fillStyle = "#c33";
    g.fillRect(0, 0, 60, 40);
    const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
    const data = new DataTransfer();
    data.items.add(new File([blob], "image.png", { type: "image/png" }));
    document.querySelector("textarea")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, null);
}

/** Where the draft, its box, its chips' layer and each chip sit, in CSS pixels. */
function measure() {
  const rect = (el: Element | null) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width) };
  };
  const field = document.querySelector("textarea")!;
  const pills = Array.from(document.querySelectorAll(".draft-chip")).flatMap((chip) => Array.from(chip.getClientRects()).map((r) => ({ left: Math.round(r.left), right: Math.round(r.right) })));
  return {
    draft: rect(field),
    box: rect(document.querySelector(".composer-box")),
    layer: rect(document.querySelector(".draft-chip-layer")),
    pills,
    scrollLeft: field.scrollLeft,
    pictures: document.querySelectorAll('[aria-label="Attached files"] li').length,
  };
}

export async function pasteImageBench(bridge: TestBridge, browser: Browser, outDir: string): Promise<{ checks: Check[]; shots: string[]; seen: Record<string, unknown> }> {
  const checks: Check[] = [];
  const shots: string[] = [];
  const seen: Record<string, unknown> = {};
  const pane = bridge.herd!.idle;
  const moments = [
    { name: "phone", device: PHONE, keyboard: false },
    { name: "phone-keyboard", device: PHONE, keyboard: true },
    { name: "desk", device: DESKTOP, keyboard: false },
  ] as const;
  for (const moment of moments) {
    const context = await browser.newContext({ ...moment.device, colorScheme: "dark", timezoneId: "UTC", locale: "en-US" });
    const page = await context.newPage();
    await page.goto(`${bridge.url}/pane/${encodeURIComponent(pane)}`);
    const box = page.getByRole("textbox").first();
    await box.waitFor({ timeout: 20_000 });
    await page.waitForTimeout(1200);
    // The keyboard up, as useAppViewport marks it when the visual viewport shrinks.
    if (moment.keyboard) await page.evaluate(() => document.querySelector(".workbench-chat")?.setAttribute("data-keyboard-open", ""), null);
    const picker = page.locator('input[type="file"]').first();
    // Until the upload is done and no thumbnail says it is still uploading.
    const settle = () => page.waitForFunction(() => !document.querySelector('[aria-label="Attached files"] [aria-busy="true"]'), null, { timeout: 15_000 })
      .then(() => page.waitForTimeout(400));
    const look = async (label: string) => {
      const key = `${moment.name}-${label}`;
      const m = await page.evaluate(measure, null);
      seen[key] = m;
      const path = join(outDir, `paste-image-${key}.png`);
      await page.screenshot({ path, animations: "disabled" });
      shots.push(path);
      const d = m.draft!, b = m.box!;
      checks.push({ name: `${key}: the draft spans the box`, ok: d.left >= b.left && d.right <= b.right && d.width >= b.width * 0.6 && m.scrollLeft === 0, detail: JSON.stringify({ draft: d, box: b, scrollLeft: m.scrollLeft }) });
      checks.push({ name: `${key}: the chips' layer lies on the draft`, ok: m.layer !== null && m.layer.left === d.left && m.layer.width === d.width, detail: JSON.stringify({ layer: m.layer, draft: d }) });
      checks.push({ name: `${key}: every chip is inside the draft`, ok: m.pills.length > 0 && m.pills.every((p) => p.left >= d.left && p.right <= d.right), detail: JSON.stringify(m.pills) });
    };

    await box.click();
    await page.keyboard.type("antes del pegado ");
    await paste(page);
    await settle();
    await page.keyboard.type(" y despues del pegado");
    await look("short");

    await page.keyboard.type(` ${LONG.repeat(3)}`);
    await paste(page);
    await settle();
    await page.keyboard.type(" final ");
    await picker.setInputFiles({ name: "picked.png", mimeType: "image/png", buffer: Buffer.from(await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 40;
      canvas.height = 40;
      const g = canvas.getContext("2d")!;
      g.fillStyle = "#36c";
      g.fillRect(0, 0, 40, 40);
      return Array.from(new Uint8Array(await (await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"))).arrayBuffer()));
    }, null)) });
    await settle();
    await page.keyboard.type(" cola");
    await look("long");
    await context.close();
  }
  return { checks, shots, seen };
}
