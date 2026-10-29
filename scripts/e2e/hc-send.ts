// Send one chat message through Nenu's composer to an hc pane, headless Chromium, phone size, with
// captures before, just after Send and once the reply is in. Only for an isolated hc core.
//   bun scripts/e2e/hc-send.ts <bridge url> <out dir> <pane id> <message> <reply text>
import { launchEngine, type Page } from "./browser.ts";

const [base, out, pane, message, reply] = process.argv.slice(2) as [string, string, string, string, string];
const browser = await launchEngine("chromium");
const context = await (browser as unknown as { newContext(o: unknown): Promise<{ newPage(): Promise<Page> }> })
  .newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: "dark", reducedMotion: "reduce", isMobile: true, hasTouch: true });
const page = await context.newPage();
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
await page.goto(`${base}/pane/${encodeURIComponent(pane)}?s=hc`);
await settle(4000);
await page.screenshot({ path: `${out}/c-before-send.png` });
const box = page.getByPlaceholder(/type a reply/i);
await box.fill(message);
await page.getByRole("button", { name: "Send", exact: true }).click();
await settle(700);
await page.screenshot({ path: `${out}/d-message-out.png` });
const deadline = Date.now() + 60_000;
let seen = false;
while (Date.now() < deadline && !seen) {
  await settle(1000);
  seen = (await page.getByText(reply, { exact: true }).count()) > 0;
}
await settle(1500);
await page.screenshot({ path: `${out}/e-reply-in.png` });
console.log(seen ? "reply seen" : "reply NOT seen within 60s");
await browser.close();
