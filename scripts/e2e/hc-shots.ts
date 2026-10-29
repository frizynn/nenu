// Phone-size captures of a prototype bridge's `hc` session, headless Chromium, read only.
// Reads only; for anything that types, use a core from scripts/e2e/hc-isolated-core.sh.
//   bun scripts/e2e/hc-shots.ts <bridge url> <out dir> <pane id>
import { launchEngine } from "./browser.ts";

const [base, out, pane = "t6"] = process.argv.slice(2) as [string, string, string?];
const browser = await launchEngine("chromium");
const context = await (browser as unknown as { newContext(o: unknown): Promise<{ newPage(): Promise<import("./browser.ts").Page> }> })
  .newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: "dark", reducedMotion: "reduce", isMobile: true, hasTouch: true });
const page = await context.newPage();
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
await page.goto(`${base}/?s=hc`);
await settle(3500);
await page.screenshot({ path: `${out}/a-home-hc.png` });
await page.goto(`${base}/pane/${encodeURIComponent(pane)}?s=hc`);
await settle(5000);
await page.screenshot({ path: `${out}/b-chat-${pane}.png` });
console.log("shots in", out);
await browser.close();
