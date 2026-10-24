import { writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DESKTOP, launchWebkit, userCacheDir, type Browser, type Page } from "./browser.ts";
import { startTestBridge, type TestBridge } from "./bridge.ts";
import { seedDiffRepo } from "./scenario.ts";

// Comments on a diff's lines, on the e2e bench: the working pane is on PR #42 "Checkout flow". On the
// desk, a comment from the session panel's Changes tab, as a chip over the chat's composer, then one
// message sent to the FakeHerdr. Dark and light. `--before` captures the same diffs, for a build that has no comments.
//
//   bun scripts/e2e/diff-comments.ts [--before] [--port 8845] [--out DIR]

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8845" },
    out: { type: "string" },
    before: { type: "boolean", default: false },
  },
});
const port = Number(values.port);
const before = values.before === true;
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), `diff-comments-${Date.now()}`);
const CAPTURE_EPOCH = Date.parse("2026-10-10T14:00:00Z");

await mkdir(outDir, { recursive: true });
const prs = join(outDir, "gh-prs.json");
process.env.NENU_E2E_GH_PRS = prs;
const bridge: TestBridge = await startTestBridge({
  port, fake: true, epoch: CAPTURE_EPOCH,
  repo: (dir) => {
    const size = seedDiffRepo(dir);
    writeFileSync(join(dir, ".git/info/exclude"), "/*\n!/app/\n!/docs/\n");
    writeFileSync(prs, JSON.stringify([
      { number: 42, title: "Checkout flow", url: "https://github.com/acme/shop/pull/42", headRefName: "e2e-demo", baseRefName: "main",
        isDraft: false, reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: [], ...size, updatedAt: new Date(CAPTURE_EPOCH).toISOString() },
    ]));
  },
});
const herd = bridge.herd!;
const chat = `/pane/${encodeURIComponent(herd.working)}`;
const shots: string[] = [];
const seen: Record<string, unknown> = {};

async function shoot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(350);
  const path = join(outDir, `${name}.png`);
  await page.screenshot({ path, animations: "disabled" });
  shots.push(path);
}

async function open(browser: Browser, device: typeof DESKTOP, colorScheme: "dark" | "light", path: string) {
  const context = await browser.newContext({ ...device, colorScheme, timezoneId: "UTC", locale: "en-US" });
  const page = await context.newPage();
  await page.clock.install({ time: bridge.now() });
  await page.goto(bridge.url + path);
  await page.getByRole("textbox").first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1200);
  return { page, close: () => context.close() };
}

/** The chips over the open chat's composer, as their labels read. */
const chips = (page: Page) => page.evaluate(() => Array.from(document.querySelectorAll('[aria-label="Comments on the diff"] li')).map((li) => li.textContent?.trim()), null);

async function desk(browser: Browser, scheme: "dark" | "light") {
  const { page, close } = await open(browser, DESKTOP, scheme, chat);
  const panel = page.getByRole("complementary", { name: "Session panel" });
  // 1. The session panel's Changes tab: "+" on hover, the box under the line, the line marked.
  await panel.getByRole("tab", { name: /^Changes/ }).click();
  await panel.getByRole("button", { name: /app\/cart\.ts/ }).first().click();
  // Its "+" sits at the line's start: hovering there keeps the numbers in view.
  await (before ? panel.getByText(/applyCoupon/).first() : panel.getByRole("button", { name: "Comment on app/cart.ts:21" })).hover();
  await shoot(page, `desk-changes-hover-${scheme}`);
  if (before) return close();
  await panel.getByRole("button", { name: "Comment on app/cart.ts:21" }).click();
  await panel.getByRole("textbox", { name: "Comment on app/cart.ts:21" }).fill("Check the coupon's expiry before applying it.");
  await shoot(page, `desk-changes-box-${scheme}`);
  await page.keyboard.press("Enter");
  await shoot(page, `desk-changes-commented-${scheme}`);
  seen[`desk ${scheme} after Changes`] = await chips(page);

  // 2. One message: the comments first, then what was typed. Sent, the chips go.
  if (scheme === "dark") {
    const from = bridge.fake!.submitted.length;
    await page.locator("textarea").last().fill("Please address these, then push.");
    await page.getByRole("button", { name: "Send" }).click();
    // A working agent takes it now, as its terminal's Enter does (ADR 0114): nothing to answer.
    for (let i = 0; i < 40 && bridge.fake!.submitted.length === from; i++) await page.waitForTimeout(250);
    seen.submitted = bridge.fake!.submitted.slice(from);
    await page.waitForTimeout(800);
    seen[`desk ${scheme} chips after send`] = await chips(page);
    await shoot(page, `desk-sent-${scheme}`);
  }
  await close();
}

const browser = await launchWebkit().catch(async (error: unknown) => { await bridge.stop(); throw error; });
try {
  for (const scheme of ["dark", "light"] as const) {
    await desk(browser, scheme);
  }
} finally {
  await browser.close();
  await bridge.stop();
}
const writes = bridge.fake!.writes().filter((call) => !(call.method === "pane.send_text" || call.method === "pane.send_keys") || call.params?.pane_id !== herd.working);
const summary = { before, seen, shots, unexpectedWrites: writes };
await writeFile(join(outDir, "diff-comments.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (writes.length) process.exit(1);
