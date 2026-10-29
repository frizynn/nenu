// Approve the permission dialog an hc pane shows, through Nenu's chat, headless Chromium, phone size,
// with captures before and after. Only for an isolated hc core.
// The core is a throwaway one from scripts/e2e/hc-isolated-core.sh, which keeps agents from self-updating.
//   bun scripts/e2e/hc-approve.ts <bridge url> <out dir> <pane id> <button text>
import { launchEngine, type Page } from "./browser.ts";

const [base, out, pane, button] = process.argv.slice(2) as [string, string, string, string];
const browser = await launchEngine("chromium");
const context = await (browser as unknown as { newContext(o: unknown): Promise<{ newPage(): Promise<Page> }> })
  .newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: "dark", reducedMotion: "reduce", isMobile: true, hasTouch: true });
const page = await context.newPage();
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
await page.goto(`${base}/pane/${encodeURIComponent(pane)}?s=hc`);
await settle(5000);
await page.screenshot({ path: `${out}/f-approval-asked.png` });
// A tap refused as "the question changed" leaves the card up; up to three taps, each counted.
let taps = 0;
const card = () => page.getByRole("button", { name: button, exact: true }).first();
while (taps < 3 && (await card().count()) > 0) {
  await card().click({ timeout: 10_000 });
  taps++;
  await settle(6000);
}
console.log(`taps: ${taps}, card still up: ${(await card().count()) > 0}`);
await page.screenshot({ path: `${out}/g-approval-done.png` });
await browser.close();
