import { join } from "node:path";

import { HerdrClient } from "../../bridge/herdr-client.ts";
import { PHONE, type Browser } from "./browser.ts";
import type { TestBridge } from "./bridge.ts";
import type { Check } from "./inline-images.ts";

// The take-over bench (ADR 0112), on a phone in WebKit: a draft Nenu left in Claude's input box, the
// way the 2026-10-21 report found it. Add to my message (Take over) must bring the text into the composer and leave the
// terminal's box empty, and Type into terminal must then reach the pane, Backspace included.

export async function takeOverBench(bridge: TestBridge, browser: Browser, outDir: string): Promise<{ checks: Check[]; shots: string[] }> {
  const checks: Check[] = [];
  const shots: string[] = [];
  const check = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) });
  const fake = bridge.fake!;
  const pane = bridge.herd!.idle;
  const stranded = "/home/u/.local/state/nenu/uploads/w1_idle-mvi3xqqi-12f60762.png mira como se ve";
  await new HerdrClient(bridge.socketPath).sendPaneText(pane, stranded);
  // The input box is the last `❯` row; the transcript above echoes earlier ones.
  const draft = () => [...fake.screen(pane).matchAll(/^❯ (.*)$/gm)].at(-1)?.[1]?.trim() || null;

  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  const shoot = async (label: string) => {
    const path = join(outDir, `take-over-${label}.png`);
    await page.screenshot({ path, animations: "disabled" });
    shots.push(path);
  };
  await page.goto(`${bridge.url}/pane/${encodeURIComponent(pane)}`);
  await page.getByRole("group", { name: "Text in Claude's box" }).waitFor({ timeout: 15_000 });
  await shoot("stranded");

  await page.getByRole("button", { name: "Add to my message" }).click();
  for (let tries = 0; draft() && tries < 40; tries++) await page.waitForTimeout(100);
  const box = page.getByRole("textbox").first();
  check("Take over brings the draft into the composer", (await box.inputValue()) === stranded, await box.inputValue());
  check("Take over leaves the terminal's input box empty", !draft(), JSON.stringify(draft()));
  await shoot("taken");

  // Typing into the terminal: with the composer emptied, the + menu's row arms it.
  await box.fill("");
  const from = fake.writes().length;
  await page.getByRole("button", { name: "Message actions" }).click();
  await page.getByText("Type into terminal").first().click();
  await page.waitForTimeout(300);
  await page.keyboard.type("ab");
  await page.keyboard.press("Backspace");
  for (let tries = 0; draft() !== "a" && tries < 40; tries++) await page.waitForTimeout(100);
  const keys = fake.writes().slice(from).filter((call) => call.method === "pane.send_keys").flatMap((call) => call.params.keys as string[]);
  check("Type into terminal sends each key, Backspace included", JSON.stringify(keys) === JSON.stringify(["a", "b", "Backspace"]), JSON.stringify(keys));
  check("the terminal's input box shows what was typed", draft() === "a", JSON.stringify(draft()));
  await shoot("typed");
  await context.close();
  return { checks, shots };
}
