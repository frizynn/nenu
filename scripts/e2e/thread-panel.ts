import { writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DESKTOP, launchWebkit, PHONE, reportModel, userCacheDir, type Page } from "./browser.ts";
import { startTestBridge } from "./bridge.ts";
import { homeOrg, seedDiffRepo } from "./scenario.ts";

// A thread's session panel on a desk: a worker with a pull request and a diff, its coordinator, and
// a thread that needs you, each with the panel as it opens, in dark and light; then the
// Changes and Files tabs, 1024 wide (the narrowest desk), and a phone, where the panel is not drawn.
//
//   bun scripts/e2e/thread-panel.ts [--port 8797] [--out DIR]

const { values } = parseArgs({ options: { port: { type: "string", default: "8797" }, out: { type: "string" } } });
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), `thread-panel-${Date.now()}`);
const CAPTURE_EPOCH = Date.parse("2026-10-10T14:00:00Z");
await mkdir(outDir, { recursive: true });

const prs = join(outDir, "gh-prs.json");
process.env.NENU_E2E_GH_PRS = prs;
let size = { additions: 0, deletions: 0 };
const bridge = await startTestBridge({
  port: Number(values.port), fake: true, epoch: CAPTURE_EPOCH,
  org: (herd, now) => homeOrg(herd, now, size),
  repo: (dir) => {
    size = seedDiffRepo(dir);
    // The bench's own files share the folder; only the seeded app is the thread's work.
    writeFileSync(join(dir, ".git/info/exclude"), "/*\n!/app/\n!/docs/\n");
    writeFileSync(prs, JSON.stringify([
      { number: 42, title: "Checkout flow", url: "https://github.com/acme/shop/pull/42", headRefName: "e2e-demo", baseRefName: "main",
        isDraft: false, reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: [], ...size, updatedAt: new Date(CAPTURE_EPOCH).toISOString() },
    ]));
  },
});
const browser = await launchWebkit().catch(async (error: unknown) => { await bridge.stop(); throw error; });
const herd = bridge.herd!;
const shots: string[] = [];

async function shoot(page: Page, name: string) {
  await page.waitForTimeout(900);
  const path = join(outDir, `${name}.png`);
  await page.screenshot({ path, animations: "disabled" });
  shots.push(path);
}

try {
  const panes = [["worker", herd.working], ["coordinator", herd.idle], ["needs-you", herd.blocked]] as const;
  for (const scheme of ["dark", "light"] as const) {
    const context = await browser.newContext({ ...DESKTOP, colorScheme: scheme, timezoneId: "UTC", locale: "en-US" });
    const page = await context.newPage();
    await reportModel(page, 22);
    await page.clock.install({ time: bridge.now() });
    for (const [name, paneId] of scheme === "dark" ? panes : panes.slice(0, 1)) {
      await page.goto(bridge.url + `/pane/${encodeURIComponent(paneId)}`);
      await page.getByRole("textbox").first().waitFor({ timeout: 15_000 });
      await shoot(page, `${name}-${scheme}`);
    }
    if (scheme === "dark") {
      await page.goto(bridge.url + `/pane/${encodeURIComponent(herd.working)}`);
      await page.getByRole("textbox").first().waitFor({ timeout: 15_000 });
      const panel = page.getByRole("complementary", { name: "Session panel" });
      for (const tab of ["Changes", "Files"]) {
        await panel.getByRole("tab", { name: new RegExp(`^${tab}`) }).click();
        await shoot(page, `worker-${tab.toLowerCase()}-dark`);
      }
      await panel.getByRole("tab").first().click();
      await page.setViewportSize({ width: 1024, height: 768 });
      await shoot(page, "worker-1024-dark");
    }
    await context.close();
  }
  const context = await browser.newContext({ ...PHONE, timezoneId: "UTC", locale: "en-US" });
  const page = await context.newPage();
  await page.clock.install({ time: bridge.now() });
  await page.goto(bridge.url + `/pane/${encodeURIComponent(herd.working)}`);
  await page.getByRole("textbox").first().waitFor({ timeout: 15_000 });
  await shoot(page, "phone-worker-dark");
  await context.close();
} finally {
  await browser.close();
  await bridge.stop();
}
console.log(shots.join("\n"));
