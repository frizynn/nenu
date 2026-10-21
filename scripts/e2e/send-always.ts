import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { HerdrClient } from "../../bridge/herdr-client.ts";
import { DESKTOP, PHONE, type Browser, type Page } from "./browser.ts";
import type { TestBridge } from "./bridge.ts";
import type { Check } from "./inline-images.ts";

// The send-always bench (ADR 0113), on a phone and a desk in WebKit, against a Claude pane that is
// working. What the 2026-10-21 reports found on 1.38.4, each one a check:
//   1. A message waiting in Nenu's queue with a picture, opened on a page that has no bubble of its
//      own for it (queued before a reload): drawn in the thread at its end, never in a section over
//      it, and its picture loads.
//   2. Send while Claude works: no question in the middle of the screen; it goes into Claude's queue.
//   3. Text in Claude's box: Send waits beside the box for Send it, Add to mine or Discard, and goes on
//      the tap. Before, a queued message waited behind it for good.
//   4. The chat's Terminal view: what is typed in the box reaches the pane, key by key.

/** A small solid PNG, so the picture's load is a real decode. */
function png(): Uint8Array {
  const width = 64;
  const height = 40;
  const raw = Uint8Array.from(Array.from({ length: height }, () => [0, ...Array.from({ length: width }, () => [40, 160, 90]).flat()]).flat());
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

/** Queue a message with a picture through the page's own routes, as another tab or an earlier load would. */
async function queueWithPicture(page: Page, paneId: string, words: string): Promise<string> {
  return page.evaluate(async ({ paneId, words, bytes }) => {
    const headers = { "x-requested-with": "XMLHttpRequest" };
    const base = `/api/pane/${encodeURIComponent(paneId)}`;
    const form = new FormData();
    form.append("file", new File([new Uint8Array(bytes)], "shot.png", { type: "image/png" }));
    const upload = await (await fetch(`${base}/upload`, { method: "POST", body: form, headers })).json() as { ok: boolean; path: string };
    const page = await (await fetch(`${base}/queue`, { headers })).json() as { scope: string };
    const text = `${upload.path} ${words}`;
    await fetch(`${base}/queue`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ scope: page.scope, action: "add", id: crypto.randomUUID(), text, deliveryMode: "afterTurn" }),
    });
    return text;
  }, { paneId, words, bytes: [...png()] });
}

export async function sendAlwaysBench(bridge: TestBridge, browser: Browser, outDir: string): Promise<{ checks: Check[]; shots: string[] }> {
  const checks: Check[] = [];
  const shots: string[] = [];
  const check = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) });
  const fake = bridge.fake!;
  const pane = bridge.herd!.working;
  const client = new HerdrClient(bridge.socketPath);
  const draft = () => [...fake.screen(pane).matchAll(/^❯ (.*)$/gm)].at(-1)?.[1]?.trim() || null;

  for (const [device, options] of [["phone", PHONE], ["desk", DESKTOP]] as const) {
    fake.setStatus(pane, "working");
    const context = await browser.newContext({ ...options, timezoneId: "UTC", locale: "en-US" });
    const page = await context.newPage();
    const shoot = async (label: string) => {
      const path = join(outDir, `send-always-${device}-${label}.png`);
      await page.screenshot({ path, animations: "disabled" });
      shots.push(path);
    };
    await page.goto(`${bridge.url}/pane/${encodeURIComponent(pane)}`);
    const box = page.getByRole("textbox").first();
    await box.waitFor({ timeout: 15_000 });

    // 2. Send while Claude works: nothing to answer, and it goes into Claude's queue.
    const submitted = fake.submitted.length;
    await box.fill(`while you work (${device})`);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.waitForTimeout(600);
    check(`${device}: Send while Claude works asks nothing`, !(await page.getByText(/when should it read this/i).isVisible().catch(() => false)));
    for (let i = 0; i < 40 && fake.submitted.length === submitted; i++) await page.waitForTimeout(150);
    check(`${device}: and it reaches Claude`, fake.submitted.length > submitted, JSON.stringify(fake.submitted.slice(submitted)));
    await shoot("sent-while-working");

    // 1. A queued message with a picture, then a fresh load with no bubble of this page's for it.
    const words = `queued before the reload (${device})`;
    await queueWithPicture(page, pane, words);
    await page.reload();
    await box.waitFor({ timeout: 15_000 });
    const row = page.locator("[data-queue-row]").filter({ hasText: words }).first();
    await row.waitFor({ timeout: 15_000 });
    const place = await row.evaluate((element) => ({
      inThread: element.closest('section[aria-label="Live conversation"]') !== null,
      inComposer: element.closest(".composer-surface") !== null,
      chain: (() => { const labels: string[] = []; for (let e: Element | null = element; e; e = e.parentElement) labels.push(e.getAttribute("aria-label") ?? e.className.toString().slice(0, 30)); return labels.join(" < "); })(),
    }));
    check(`${device}: a queued message is drawn in the thread`, place.inThread && !place.inComposer, JSON.stringify(place));
    // Nothing of the thread sits under it: the row and every turn are siblings in one scrolling list.
    const covers = await page.evaluate(() => {
      const row = document.querySelector("[data-queue-row]")!.getBoundingClientRect();
      const turns = Array.from(document.querySelectorAll('section[aria-label="Live conversation"] [data-entry-uuid], section[aria-label="Live conversation"] p'));
      return turns.filter((turn) => {
        if (turn.closest("[data-queue-row]")) return false;
        const r = turn.getBoundingClientRect();
        return r.height > 0 && r.bottom > row.top + 1 && r.top < row.bottom - 1 && r.right > row.left && r.left < row.right;
      }).length;
    }, null);
    check(`${device}: the queued message covers no turn of the thread`, covers === 0, `${covers} overlapping`);
    const picture = row.locator("img").first();
    const loaded = await picture.waitFor({ timeout: 10_000 }).then(
      () => page.waitForFunction((selector) => {
        const img = document.querySelector(selector) as HTMLImageElement | null;
        return img !== null && img.complete && img.naturalWidth > 0;
      }, "[data-queue-row] img", { timeout: 10_000 }).then(() => true, () => false),
      () => false,
    );
    check(`${device}: its picture loads`, loaded);
    await row.scrollIntoViewIfNeeded();
    await shoot("queued-in-thread");

    // 3. Text in Claude's box: Send waits beside the box, Discard settles it, and the message goes.
    fake.setStatus(pane, "idle");
    await client.sendPaneText(pane, `typed at the desk (${device})`);
    // A build before ADR 0113 draws "Draft in terminal" with only Take over: the checks record it.
    await page.waitForFunction(() => document.querySelector('[aria-label="Text in Claude\'s box"]') !== null || document.body.innerText.includes("Draft in terminal"), null, { timeout: 15_000 });
    const before = fake.submitted.length;
    await box.fill(`mine goes after (${device})`);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const waiting = await page.getByText(/yours goes as soon as you choose/i).waitFor({ timeout: 3000 }).then(() => true, () => false);
    check(`${device}: Send over text in Claude's box waits beside the box`, waiting && fake.submitted.length === before);
    await shoot("draft-choice");
    await page.getByRole("button", { name: "Discard" }).click({ timeout: 3000 }).catch(() => {});
    for (let i = 0; i < 60 && fake.submitted.length === before; i++) await page.waitForTimeout(150);
    check(`${device}: Discard empties Claude's box and the message goes`, !draft() || draft() === null, JSON.stringify(draft()));
    check(`${device}: …as the only thing submitted`, JSON.stringify(fake.submitted.slice(before)).includes(`mine goes after (${device})`), JSON.stringify(fake.submitted.slice(before)));

    // 4. The chat's Terminal view: the box is the terminal.
    if (device === "desk") await page.getByRole("button", { name: "Show raw terminal" }).click();
    else {
      await page.getByRole("button", { name: "Conversation actions" }).click();
      await page.getByText("Terminal view").click();
    }
    const from = fake.writes().length;
    await page.getByRole("textbox").first().click();
    await page.keyboard.type("ls");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    for (let i = 0; i < 40 && fake.writes().slice(from).filter((call) => call.method === "pane.send_keys").length < 4; i++) await page.waitForTimeout(100);
    const keys = fake.writes().slice(from).filter((call) => call.method === "pane.send_keys").flatMap((call) => call.params.keys as string[]);
    check(`${device}: in the Terminal view the box types into the pane`, JSON.stringify(keys) === JSON.stringify(["l", "s", "Backspace", "Enter"]), JSON.stringify(keys));
    await shoot("terminal-view");
    // Back to the chat: the box is the chat's again.
    if (device === "desk") await page.getByRole("button", { name: "Show conversation" }).click();
    else {
      await page.getByRole("button", { name: "Conversation actions" }).click();
      await page.getByText("Terminal view").click();
    }
    const chatBox = await page.getByPlaceholder(/type into the terminal/i).waitFor({ state: "hidden", timeout: 5000 }).then(() => true, () => false);
    check(`${device}: back in the chat, the box is the chat's`, chatBox);
    await context.close();
  }
  return { checks, shots };
}
