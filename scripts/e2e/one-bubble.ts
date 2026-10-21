import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DESKTOP, launchChrome, PHONE, userCacheDir, type Browser, type Page } from "./browser.ts";
import { startTestBridge } from "./bridge.ts";

// A message sent from Nenu is on screen once, in every frame (ADR 0117). On a phone and a desk: a send
// to an idle Claude whose log then shows it, and a send while Claude works, which goes into Claude's own
// queue and is read mid-turn (an enqueue, then the queued_command Claude writes when it reads it). A
// probe in the page counts, on every animation frame, the bubbles, journal turns and queue rows that
// carry the message; a frame with two fails. Before 1.42.0 both sends showed twice for a moment.
// Exits 1 on any failure.
//
//   bun scripts/e2e/one-bubble.ts [--port 8878] [--out DIR]

const { values } = parseArgs({ options: { port: { type: "string", default: "8878" }, out: { type: "string" } } });
const port = Number(values.port);
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), `one-bubble-${Date.now()}`);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** On every frame, how many of the operator's message rows carry each watched text. */
function probe() {
  const w = window as unknown as { __watch: string[]; __frames: number; __twice: Array<{ text: string; count: number }> };
  w.__watch = [];
  w.__frames = 0;
  w.__twice = [];
  const rows = '[data-speaker="user"], [data-pending-send], [data-queue-row]';
  const tick = () => {
    w.__frames++;
    for (const text of w.__watch) {
      const count = Array.from(document.querySelectorAll(rows))
        .filter((el) => el.textContent?.includes(text) && !el.parentElement?.closest(rows)).length;
      if (count > 1) w.__twice.push({ text, count });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

let seq = 0;
const row = (fields: Record<string, unknown>) =>
  JSON.stringify({ uuid: `bb000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, parentUuid: null, timestamp: new Date().toISOString(), ...fields }) + "\n";

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const failures: string[] = [];
  const bridge = await startTestBridge({ port, fake: true });
  const fake = bridge.fake!;
  const herd = bridge.herd!;
  let browser: Browser | null = null;
  try {
    browser = await launchChrome();
    for (const [device, options] of [["desk", DESKTOP], ["phone", PHONE]] as const) {
      const context = await browser.newContext({ ...options, reducedMotion: "no-preference" });
      const page: Page = await context.newPage();
      await page.addInitScript(probe, null);
      const send = async (pane: string, text: string) => {
        await page.goto(`${bridge.url}/pane/${encodeURIComponent(pane)}`);
        const box = page.getByRole("textbox").first();
        await box.waitFor({ timeout: 15_000 });
        await page.evaluate((watched) => { (window as unknown as { __watch: string[] }).__watch.push(watched); }, text);
        const before = fake.submitted.length;
        await box.fill(text);
        await page.getByRole("button", { name: "Send", exact: true }).click();
        for (let i = 0; i < 60 && !fake.submitted.slice(before).some((s) => s.text.includes(text)); i++) await sleep(100);
        if (!fake.submitted.slice(before).some((s) => s.text.includes(text))) failures.push(`${device}: "${text}" never reached the pane`);
      };
      const settle = async (text: string, label: string) => {
        await sleep(3000);
        const seen = await page.evaluate((watched) => {
          const w = window as unknown as { __frames: number; __twice: Array<{ text: string; count: number }> };
          const rows = '[data-speaker="user"], [data-pending-send], [data-queue-row]';
          const now = Array.from(document.querySelectorAll(rows)).filter((el) => el.textContent?.includes(watched) && !el.parentElement?.closest(rows)).length;
          return { frames: w.__frames, twice: w.__twice.filter((t) => t.text === watched).length, now };
        }, text);
        await page.screenshot({ path: join(outDir, `${device}-${label}.png`) });
        console.log(JSON.stringify({ device, label, ...seen }));
        if (seen.twice > 0) failures.push(`${device} ${label}: on screen twice in ${seen.twice} of ${seen.frames} frames`);
        if (seen.now !== 1) failures.push(`${device} ${label}: ${seen.now} copies at the end, not 1`);
      };

      // An idle Claude: the send goes, then its log shows it.
      const idle = `one bubble idle ${device}`;
      await send(herd.idle, idle);
      await sleep(300);
      await appendFile(herd.journals.get(herd.idle)!, row({ type: "user", message: { role: "user", content: idle } }));
      await settle(idle, "idle");

      // A working Claude: it goes into Claude's queue, which Claude reads mid-turn.
      fake.setStatus(herd.working, "working");
      const queued = `one bubble queued ${device}`;
      await send(herd.working, queued);
      const log = herd.journals.get(herd.working)!;
      await appendFile(log, row({ type: "queue-operation", operation: "enqueue", content: queued }));
      await sleep(1500);
      await appendFile(log, row({ type: "queue-operation", operation: "dequeue" }));
      await appendFile(log, row({ type: "attachment", attachment: { type: "queued_command", prompt: queued, origin: { kind: "human" } } }));
      await settle(queued, "queued");
      await context.close();
    }
  } finally {
    await browser?.close();
    await bridge.stop();
  }
  console.log(`captures in ${outDir}`);
  if (failures.length) {
    for (const failure of failures) console.error(`✗ ${failure}`);
    process.exit(1);
  }
  console.log("✓ every message on screen once, in every frame");
}

await main();
