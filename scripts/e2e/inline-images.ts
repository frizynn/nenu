import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { DESKTOP, PHONE, type Browser, type Page } from "./browser.ts";
import type { TestBridge } from "./bridge.ts";

// The inline-images bench: a message with two pictures between its words, on a phone and a desk.
// The composer gets "first the red one ⟨red⟩ then the blue one ⟨blue⟩ and that is all", picked
// through the file input at the caret, and is captured before Send; Send's writes to the fake
// terminal are recorded as they reached it. A Claude row of the same message, as Claude logs one
// (its text with `[Image #N]` where each picture was, then the pictures), is captured in the
// conversation. Each check passes or fails; `--before` only records (run.ts `inline-images`).

export interface Check { name: string; ok: boolean; detail?: string }

/** A solid PNG with a white band, so the two pictures tell apart in a capture. */
function png(width: number, height: number, [r, g, b]: [number, number, number], band: [number, number]): Uint8Array {
  const row = (y: number) => {
    const bytes = [0];
    for (let x = 0; x < width; x++) {
      const white = y >= band[0] && y < band[1] && Math.floor(x / 20) % 2 === 0;
      bytes.push(...(white ? [255, 255, 255] : [r, g, b]));
    }
    return bytes;
  };
  const raw = Uint8Array.from(Array.from({ length: height }, (_, y) => row(y)).flat());
  const chunk = (type: string, data: Uint8Array) => {
    const body = new Uint8Array([...new TextEncoder().encode(type), ...data]);
    const out = new DataView(new ArrayBuffer(12 + data.length));
    out.setUint32(0, data.length);
    new Uint8Array(out.buffer).set(body, 4);
    out.setUint32(8 + data.length, Bun.hash.crc32(body));
    return new Uint8Array(out.buffer);
  };
  const header = new DataView(new ArrayBuffer(13));
  header.setUint32(0, width);
  header.setUint32(4, height);
  header.setUint8(8, 8);
  header.setUint8(9, 2);
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk("IHDR", new Uint8Array(header.buffer)),
    ...chunk("IDAT", deflateSync(raw)),
    ...chunk("IEND", new Uint8Array()),
  ]);
}

const RED = png(240, 160, [220, 30, 30], [60, 100]);
const BLUE = png(240, 160, [30, 60, 220], [20, 40]);
/** A draft as it reads: a chip's joiners (U+2060) take no room. */
const visible = (draft: string) => draft.replace(/\u2060/g, "");

const WORDS = ["first the red one ", " then the blue one ", " and that is all"] as const;

export async function inlineImagesBench(bridge: TestBridge, browser: Browser, outDir: string, before: boolean): Promise<{ checks: Check[]; shots: string[]; sent: Record<string, unknown> }> {
  const checks: Check[] = [];
  const shots: string[] = [];
  const sent: Record<string, unknown> = {};
  const check = (name: string, ok: boolean, detail?: string) => { if (!before) checks.push({ name, ok, ...(detail ? { detail } : {}) }); };
  const herd = bridge.herd!;
  const pane = herd.idle;
  const now = bridge.now();

  // The conversation: the message as Claude logged one sent this way (measured on 2.1.304).
  const pictures = join(bridge.dir, "pictures");
  await mkdir(pictures, { recursive: true });
  await writeFile(join(pictures, "red.png"), RED);
  await writeFile(join(pictures, "blue.png"), BLUE);
  const image = (bytes: Uint8Array) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from(bytes).toString("base64") } });
  const rows = [
    { type: "user", uuid: "00000000-0000-4000-8000-0000000a0001", message: { role: "user", content: [
      { type: "text", text: "first the red one [Image #1] then the blue one [Image #2] and that is all" }, image(RED), image(BLUE),
    ] } },
    { type: "assistant", uuid: "00000000-0000-4000-8000-0000000a0002", message: { role: "assistant", content: [{ type: "text", text: "Red first, then blue: two solid pictures with a white band each." }] } },
  ];
  let parent: string | null = null;
  for (const [i, row] of rows.entries()) {
    await appendFile(herd.journals.get(pane)!, JSON.stringify({ ...row, parentUuid: parent, timestamp: new Date(now - 60_000 + i * 5_000).toISOString() }) + "\n");
    parent = row.uuid;
  }

  for (const [name, device] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
    const context = await browser.newContext({ ...device, timezoneId: "UTC", locale: "en-US" });
    const page = await context.newPage();
    await page.clock.install({ time: now });
    await page.goto(`${bridge.url}/pane/${encodeURIComponent(pane)}`);
    const box = page.getByRole("textbox").first();
    await box.waitFor({ timeout: 15_000 });
    await page.getByRole("img", { name: /Image 2/ }).first().waitFor({ timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const shoot = async (label: string) => {
      const path = join(outDir, `inline-images-${label}-${name}.png`);
      await page.screenshot({ path, animations: "disabled" });
      shots.push(path);
    };
    await shoot("transcript");

    // The bubble draws each picture where its token was: red between the first words and the second.
    const order = await page.evaluate(() => {
      const bubble = Array.from(document.querySelectorAll("[data-speaker=\"user\"]")).find((el) => el.textContent?.includes("first the red one"));
      if (!bubble) return null;
      const out: string[] = [];
      const walk = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      for (let node = walk.nextNode(); node; node = walk.nextNode()) {
        if (node instanceof HTMLImageElement) out.push(`<${node.alt}>`);
        else if (node.nodeType === Node.TEXT_NODE && node.textContent!.trim()) out.push(node.textContent!.trim());
      }
      return out.join(" ");
    }, null);
    sent[`transcript-${name}`] = order;
    check(`${name}: the transcript draws each picture in its place`, order !== null && /first the red one <Image 1> then the blue one <Image 2> and that is all/.test(order), order ?? "no bubble");

    const picker = page.locator('input[type="file"]').first();
    const pick = async (file: string, bytes: Uint8Array) => {
      await picker.setInputFiles({ name: file, mimeType: "image/png", buffer: Buffer.from(bytes) });
    };
    await box.click();
    await page.keyboard.type(WORDS[0]);
    await pick("red.png", RED);
    await page.keyboard.type(WORDS[1]);
    await pick("blue.png", BLUE);
    await page.keyboard.type(WORDS[2]);
    const send = page.getByRole("button", { name: "Send" });
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled, null, { timeout: 15_000 });
    await page.waitForTimeout(400);
    await shoot("composer");
    const draft = await box.inputValue();
    sent[`draft-${name}`] = draft;
    check(`${name}: the draft holds a chip where each picture went`, /^first the red one .*Image\s#1.* then the blue one .*Image\s#2.* and that is all$/s.test(visible(draft)), JSON.stringify(draft));
    const thumbs = await page.getByRole("list", { name: "Attached files" }).getByRole("listitem").allTextContents();
    check(`${name}: the thumbnails are numbered as their chips`, thumbs.length === 2 && thumbs[0]!.includes("#1") && thumbs[1]!.includes("#2"), JSON.stringify(thumbs));

    const from = bridge.fake!.writes().length;
    const submitted = bridge.fake!.submitted.length;
    await send.click();
    for (let tries = 0; bridge.fake!.submitted.length === submitted && tries < 60; tries++) await page.waitForTimeout(250);
    const typed = bridge.fake!.writes().slice(from).filter((call) => call.method === "pane.send_text").map((call) => (call.params as { text?: string }).text ?? "");
    const message = bridge.fake!.submitted.at(-1)?.text ?? null;
    sent[`writes-${name}`] = typed;
    sent[`submitted-${name}`] = message;
    check(`${name}: the terminal holds each picture where it was`, message !== null && /^first the red one \[Image #\d+\]\s+then the blue one \[Image #\d+\]\s+and that is all$/.test(message.trim()), JSON.stringify(message));
    await page.waitForTimeout(800);
    await shoot("sent");

    // A chip taken out takes its picture with it, and the rest renumber.
    if (!before) {
      await box.click();
      await page.keyboard.type("x ");
      await pick("red.png", RED);
      await page.keyboard.type(" y ");
      await pick("blue.png", BLUE);
      await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled, null, { timeout: 15_000 });
      await page.getByRole("button", { name: "Remove Image #1" }).click();
      await page.waitForTimeout(200);
      const after = await box.inputValue();
      const left = await page.getByRole("list", { name: "Attached files" }).getByRole("listitem").allTextContents();
      check(`${name}: removing a thumbnail removes its chip and renumbers`, !after.includes("#2") && /x\s+y .*Image\s#1/.test(visible(after)) && left.length === 1 && left[0]!.includes("#1"), JSON.stringify({ after, left }));
      await shoot("removed");
      await clearDraft(page);
    }
    await context.close();
  }
  return { checks, shots, sent };
}

async function clearDraft(page: Page) {
  const box = page.getByRole("textbox").first();
  await box.fill("");
}
