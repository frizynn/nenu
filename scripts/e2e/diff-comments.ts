import { writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DESKTOP, launchWebkit, PHONE, userCacheDir, type Browser, type Page } from "./browser.ts";
import { startTestBridge, type TestBridge } from "./bridge.ts";
import { homeOrg, seedDiffRepo } from "./scenario.ts";

// Comments on a diff's lines, on the e2e bench: the working pane is the thread "Checkout flow" on PR
// #42 and the Codex pane coordinates its project. On the desk, a comment from the thread's Changes tab
// and one from the coordinator's Project panel (the diff of another thread: the viewer says so and
// opens that chat), both as chips over the thread's composer, then one message sent to the FakeHerdr.
// On the phone, the coordinator's PRs tab opens the viewer from "+N −M" and a tap on a line comments.
// Dark and light. `--before` captures the same diffs, for a build that has no comments.
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
let size = { additions: 0, deletions: 0 };
const bridge: TestBridge = await startTestBridge({
  port, fake: true, epoch: CAPTURE_EPOCH,
  org: (herd, now) => {
    const seed = homeOrg(herd, now, size);
    seed.projects[0]!.coordinator = { workspace_id: "w2", tab_id: "w2:t1", pane_id: herd.codex };
    return seed;
  },
  repo: (dir) => {
    size = seedDiffRepo(dir);
    writeFileSync(join(dir, ".git/info/exclude"), "/*\n!/app/\n!/docs/\n");
    writeFileSync(prs, JSON.stringify([
      { number: 42, title: "Checkout flow", url: "https://github.com/acme/shop/pull/42", headRefName: "e2e-demo", baseRefName: "main",
        isDraft: false, reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: [], ...size, updatedAt: new Date(CAPTURE_EPOCH).toISOString() },
    ]));
  },
});
const herd = bridge.herd!;
const thread = `/pane/${encodeURIComponent(herd.working)}`;
const coordinator = `/pane/${encodeURIComponent(herd.codex)}`;
const shots: string[] = [];
const seen: Record<string, unknown> = {};

async function shoot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(350);
  const path = join(outDir, `${name}.png`);
  await page.screenshot({ path, animations: "disabled" });
  shots.push(path);
}

async function open(browser: Browser, device: typeof PHONE | typeof DESKTOP, colorScheme: "dark" | "light", path: string) {
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

/** The coordinator's chat, its Project panel on PRs, the thread's pull request opened with cart.ts. */
async function projectDiff(page: Page): Promise<void> {
  const panel = page.getByRole("complementary", { name: "Session panel" });
  await page.goto(bridge.url + coordinator);
  await page.getByRole("textbox").first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(900);
  await panel.getByRole("tab", { name: /^Project/ }).click();
  await panel.getByRole("tab", { name: /^PRs/ }).click();
  await panel.getByRole("button", { name: /^Checkout flow/ }).first().click();
  await panel.getByRole("button", { name: /app\/cart\.ts/ }).first().click();
}

async function desk(browser: Browser, scheme: "dark" | "light") {
  const { page, close } = await open(browser, DESKTOP, scheme, thread);
  const panel = page.getByRole("complementary", { name: "Session panel" });
  // 1. The session panel's Changes tab: "+" on hover, the box under the line, the line marked.
  await panel.getByRole("tab", { name: /^Changes/ }).click();
  await panel.getByRole("button", { name: /app\/cart\.ts/ }).first().click();
  // Its "+" sits at the line's start: hovering there keeps the numbers in view.
  await (before ? panel.getByText(/applyCoupon/).first() : panel.getByRole("button", { name: "Comment on app/cart.ts:21" })).hover();
  await shoot(page, `desk-changes-hover-${scheme}`);
  if (before) {
    await projectDiff(page);
    await shoot(page, `desk-project-diff-${scheme}`);
    return close();
  }
  await panel.getByRole("button", { name: "Comment on app/cart.ts:21" }).click();
  await panel.getByRole("textbox", { name: "Comment on app/cart.ts:21" }).fill("Check the coupon's expiry before applying it.");
  await shoot(page, `desk-changes-box-${scheme}`);
  await page.keyboard.press("Enter");
  await shoot(page, `desk-changes-commented-${scheme}`);
  seen[`desk ${scheme} after Changes`] = await chips(page);

  // 2. The coordinator's Project panel: the PR's diff belongs to another thread, so it says where the
  // comments wait and opens that chat.
  await projectDiff(page);
  await panel.getByRole("button", { name: "Comment on app/cart.ts:42" }).click();
  await panel.getByRole("textbox", { name: "Comment on app/cart.ts:42" }).fill("Cover this branch with a test.");
  await page.keyboard.press("Enter");
  seen[`desk ${scheme} coordinator composer chips`] = await chips(page);
  seen[`desk ${scheme} banner`] = await panel.getByText(/comments? for /).first().innerText().catch(() => null);
  await shoot(page, `desk-project-banner-${scheme}`);
  await panel.getByRole("button", { name: "Open chat" }).click();
  await page.waitForTimeout(1200);
  seen[`desk ${scheme} Open chat lands on`] = decodeURIComponent(new URL(page.url()).pathname);
  seen[`desk ${scheme} thread chips`] = await chips(page);
  await shoot(page, `desk-thread-chips-${scheme}`);

  // 3. One message: the comments first, then what was typed. Sent, the chips go.
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

async function phone(browser: Browser, scheme: "dark" | "light") {
  // From the coordinator's chat: the thread's pull request, its size opening the viewer.
  const { page, close } = await open(browser, PHONE, scheme, coordinator);
  seen[`phone ${scheme} hover: none`] = await page.evaluate(() => matchMedia("(hover: none)").matches, null);
  await page.getByRole("tab", { name: /^PRs/ }).click();
  await page.locator(".project-overlay").waitFor({ timeout: 5000 });
  await page.locator(".project-overlay").getByRole("button", { name: /^View changes/ }).first().click();
  const dialog = page.getByRole("dialog", { name: "PR #42 changes" });
  await dialog.getByRole("button", { name: /app\/cart\.ts/ }).click();
  await shoot(page, `phone-viewer-${scheme}`);
  if (before) return close();
  // No hover on a phone: a tap on the line itself opens the box.
  await dialog.getByText(/applyCoupon/).first().click();
  // Playwright scrolled the long line into view; a thumb on it would not have.
  await page.evaluate(() => document.querySelectorAll("[role=dialog] .overflow-x-auto").forEach((el) => { el.scrollLeft = 0; }), null);
  await dialog.getByRole("textbox", { name: "Comment on app/cart.ts:21" }).fill("Check the coupon's expiry before applying it.");
  await shoot(page, `phone-box-${scheme}`);
  await page.keyboard.press("Enter");
  seen[`phone ${scheme} banner`] = await dialog.getByText(/comments? for /).first().innerText().catch(() => null);
  await shoot(page, `phone-commented-${scheme}`);
  await dialog.getByRole("button", { name: "Open chat" }).click();
  await page.waitForTimeout(1200);
  seen[`phone ${scheme} Open chat lands on`] = decodeURIComponent(new URL(page.url()).pathname);
  seen[`phone ${scheme} sheet still open`] = await dialog.isVisible();
  seen[`phone ${scheme} chips`] = await chips(page);
  await shoot(page, `phone-chips-${scheme}`);
  await close();
}

const browser = await launchWebkit().catch(async (error: unknown) => { await bridge.stop(); throw error; });
try {
  for (const scheme of ["dark", "light"] as const) {
    await desk(browser, scheme);
    await phone(browser, scheme);
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
