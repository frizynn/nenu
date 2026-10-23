import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DESKTOP, launchChrome, PHONE, userCacheDir, type Browser, type Page } from "./browser.ts";
import { startTestBridge } from "./bridge.ts";
import { seedDemoHerd } from "./scenario.ts";

// Home's Workspaces in the order chosen (ADR 0123), over the demo herd and six more workspaces, the
// last one's agent working so it moved last. At 390x844 with a finger:
// the list is Herdr's order whatever moved last, Name sorts it, Reorder drags the third row's handle
// past the fifth, a finger on a row's body still scrolls the page and moves no row, and a reload keeps
// the order and Custom. At 1440x900 a mouse drags the first row to third. Captures every step.
// Exits 1 on any failure.
//
//   bun scripts/e2e/workspace-order.ts [--port 8871] [--out DIR]

const { values } = parseArgs({ options: { port: { type: "string", default: "8871" }, out: { type: "string" } } });
const port = Number(values.port);
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), `workspace-order-${Date.now()}`);

const names = (page: Page) => page.locator("#home-list > ul > li").evaluateAll((rows) => rows.map((row) => {
  const handle = row.querySelector("[data-reorder-handle]");
  return handle ? handle.getAttribute("aria-label")!.replace(/^Move /, "") : (row.firstElementChild?.getAttribute("aria-label") ?? "").split(",")[0]!;
}));
const moved = (list: readonly string[], from: number, to: number) => {
  const next = [...list];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
};
const same = (a: readonly string[], b: readonly string[]) => JSON.stringify(a) === JSON.stringify(b);

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const failures: string[] = [];
  const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures.push(what); };
  const bridge = await startTestBridge({ port, fake: true, seed: async (fake, ctx) => {
    const herd = await seedDemoHerd(fake, ctx);
    for (const [n, label] of ["zeta", "billing", "Search 10", "infra", "search 9", "docs"].entries()) {
      const id = `w${n + 3}`;
      fake.addWorkspace(id, label).addTab(`${id}:t1`, "main");
      fake.addPane({ paneId: `${id}:p1`, workspaceId: id, tabId: `${id}:t1`, agent: n === 5 ? "claude" : null, label: `${label} pane`, cwd: ctx.cwd, lines: [] });
    }
    fake.setStatus("w8:p1", "working");
    return herd;
  } });
  let browser: Browser | null = null;
  try {
    // Herdr's order, as the bridge hands it over: by number, which workspace.move renumbers.
    const snapshot = await (await fetch(`${bridge.url}/api/snapshot`)).json() as { workspaces: Array<{ workspaceId: string; number: number; label: string }> };
    browser = await launchChrome();
    const open = async (device: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      const context = await browser!.newContext({ ...device, ...extra, locale: "en-US" });
      const page = await context.newPage();
      await page.goto(bridge.url);
      await page.waitForTimeout(2500);
      await page.getByRole("tab", { name: "Workspaces" }).click();
      await page.waitForTimeout(500);
      return { context, page };
    };
    const shoot = (page: Page, name: string) => page.screenshot({ path: join(outDir, `${name}.png`), animations: "disabled" });

    // A phone.
    {
      const { context, page } = await open(PHONE);
      const herdr = await names(page);
      const byNumber = [...snapshot.workspaces].sort((a, b) => a.number - b.number).map((w) => w.label);
      check(herdr.length >= 5, `the demo herd lists ${herdr.length} workspaces (5 or more to drag past)`);
      check(same(herdr, byNumber.filter((label) => herdr.includes(label))), "the list is in Herdr's order");
      await shoot(page, "phone-1-herdr");
      const order = page.getByRole("combobox", { name: "Order" });
      await order.selectOption("name");
      await page.waitForTimeout(300);
      check(same(await names(page), [...herdr].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))), "Name sorts it by name");
      await shoot(page, "phone-2-name");
      await order.selectOption("herdr");
      await order.selectOption("arrange");
      await page.waitForTimeout(300);
      check(await page.locator("#home-list a").count() === 0, "while reordering a row opens nothing");
      await shoot(page, "phone-3-reorder");

      const cdp = await context.newCDPSession(page);
      const touch = async (x: number, from: number, to: number, mid?: string) => {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: from }] });
        for (let step = 1; step <= 20; step++) {
          await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: from + ((to - from) * step) / 20 }] });
          await page.waitForTimeout(16);
          if (mid && step === 12) await page.screenshot({ path: join(outDir, `${mid}.png`) });
        }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await page.waitForTimeout(400);
      };
      const handle = (await page.locator("[data-reorder-handle]").nth(2).boundingBox())!;
      const fifth = (await page.locator("[data-reorder-key]").nth(4).boundingBox())!;
      await touch(handle.x + handle.width / 2, handle.y + handle.height / 2, fifth.y + fifth.height * 0.75, "phone-4-dragging");
      const dragged = moved(herdr, 2, 4);
      check(same(await names(page), dragged), "a finger on the third row's handle drops it fifth");
      await shoot(page, "phone-5-dropped");

      const scrollTop = () => page.evaluate(() => document.querySelector("main")!.scrollTop, null);
      const top = await scrollTop();
      const row = (await page.locator("[data-reorder-key]").nth(3).boundingBox())!;
      await touch(120, row.y + 20, row.y + 20 - 250);
      check(await scrollTop() > top, "a finger on a row's body scrolls the page");
      check(same(await names(page), dragged), "and moves no row");

      await page.getByRole("button", { name: "Done" }).click();
      await page.reload();
      await page.waitForTimeout(2500);
      await page.getByRole("tab", { name: "Workspaces" }).click();
      await page.waitForTimeout(500);
      check(same(await names(page), dragged), "a reload keeps the dragged order");
      check(await page.getByRole("combobox", { name: "Order" }).inputValue() === "custom", "and Custom");
      await shoot(page, "phone-6-reloaded");
      await context.close();
    }

    // A desk, with a mouse.
    {
      const { context, page } = await open(DESKTOP);
      const herdr = await names(page);
      await shoot(page, "desk-1-herdr");
      await page.getByRole("combobox", { name: "Order" }).selectOption("arrange");
      await page.waitForTimeout(300);
      const handle = (await page.locator("[data-reorder-handle]").first().boundingBox())!;
      const third = (await page.locator("[data-reorder-key]").nth(2).boundingBox())!;
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await page.mouse.down();
      await page.mouse.move(handle.x + handle.width / 2, third.y + third.height * 0.75, { steps: 15 });
      await page.screenshot({ path: join(outDir, "desk-2-dragging.png") });
      await page.mouse.up();
      await page.waitForTimeout(300);
      check(same(await names(page), moved(herdr, 0, 2)), "a mouse drags the first row to third");
      await page.getByRole("button", { name: "Done" }).click();
      await shoot(page, "desk-3-done");
      await context.close();
    }
  } finally {
    await browser?.close();
    await bridge.stop();
  }
  console.log(`captures: ${outDir}`);
  if (failures.length) {
    console.log(`${failures.length} failed`);
    process.exit(1);
  }
}

await main();
