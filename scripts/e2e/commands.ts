import { dirname, join } from "node:path";

import { DESKTOP, PHONE, type Browser, type Page } from "./browser.ts";
import type { TestBridge } from "./bridge.ts";
import type { Check } from "./inline-images.ts";
import { writeCommandsJournal } from "./scenario.ts";

// The commands bench: the operator's demo from T3 Code (2026-10-21) as a Claude log, read on a desk
// (1440x900) and a phone (390x844). Each capture opens one more fold: the turn, the run of three
// commands, one command, the one that failed, the long output; and the turn while it runs. The checks
// pin what the transcript draws, so a later change that regroups the steps fails here.

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function commandsBench(bridge: TestBridge, browser: Browser, outDir: string, before: boolean): Promise<{ checks: Check[]; shots: string[]; seen: Record<string, unknown> }> {
  const checks: Check[] = [];
  const shots: string[] = [];
  const seen: Record<string, unknown> = {};
  const check = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) });
  const fake = bridge.fake!;
  const folder = dirname(bridge.herd!.journals.get(bridge.herd!.idle)!);
  fake.addTab("w1:cmd", "commands");
  const pane = (paneId: string, sessionId: string, status: "done" | "working") => fake.addPane({ paneId, workspaceId: "w1", tabId: "w1:cmd", agent: "claude",
    label: "Commands", sessionId, cwd: bridge.dir, status, lines: ["● Listo."] });
  const finished = { paneId: "w1:cmd-done", session: "77777777-7777-4777-8777-777777777777" };
  await writeCommandsJournal(join(folder, `${finished.session}.jsonl`), bridge.now(), "finished");
  pane(finished.paneId, finished.session, "done");
  const running = [0, 1].map((i) => ({ paneId: `w1:cmd-run${i}`, session: `8888888${i}-8888-4888-8888-888888888888` }));
  for (const run of running) {
    await writeCommandsJournal(join(folder, `${run.session}.jsonl`), bridge.now(), "running");
    pane(run.paneId, run.session, "working");
  }
  for (let tries = 0; !(await (await fetch(bridge.url + "/api/snapshot")).text()).includes(running.at(-1)!.paneId); tries++) {
    if (tries > 60) throw new Error("the bridge never listed the command panes");
    await sleep(500);
  }

  const prefix = before ? "before" : "after";
  for (const [i, [deviceName, device]] of ([["desk", DESKTOP], ["phone", PHONE]] as const).entries()) {
    const context = await browser.newContext({ ...device, colorScheme: "dark", timezoneId: "UTC", locale: "en-US" });
    const page = await context.newPage();
    await page.clock.install({ time: bridge.now() });
    const shoot = async (name: string, at?: string) => {
      if (at) await page.evaluate((text) => {
        const el = Array.from(document.querySelectorAll<HTMLElement>(".chat-thread button, .chat-thread p"))
          .find((node) => node.innerText.includes(text));
        el?.scrollIntoView({ block: "center" });
      }, at);
      // The pointer rests off the thread, so no row is caught lit by its hover.
      await page.mouse.move(0, 0);
      await page.waitForTimeout(300);
      const path = join(outDir, `${prefix}-${name}-${deviceName}.png`);
      await page.screenshot({ path, animations: "disabled" });
      shots.push(path);
    };
    /** Taps the last button that says `text`, as the operator would; false when none does. */
    const tap = async (text: string | RegExp) => {
      const button = page.locator(".chat-thread button", { hasText: text }).last();
      if (!(await button.count())) return false;
      await button.click();
      await page.waitForTimeout(400);
      return true;
    };
    const lines = (p: Page) => p.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(".chat-thread [data-work-turn]")).at(-1)?.innerText.split("\n").map((l) => l.trim()).filter(Boolean) ?? [], null);

    await page.goto(`${bridge.url}/pane/${encodeURIComponent(finished.paneId)}`);
    await page.getByText("Listo, corrí 5 comandos").waitFor({ timeout: 15_000 });
    await page.waitForTimeout(1200);
    seen[`${deviceName}-folded`] = await lines(page);
    await shoot("folded", "hola usa comandos");
    seen[`${deviceName}-turn-tapped`] = await tap(/^Work(ed|ing)/);
    seen[`${deviceName}-turn-open`] = await lines(page);
    await shoot("turn-open", "hola usa comandos");
    seen[`${deviceName}-group-tapped`] = await tap(/Ran 3 commands/i);
    seen[`${deviceName}-group-open`] = await lines(page);
    await shoot("group-open", "Ran 3 commands");
    seen[`${deviceName}-command-tapped`] = await tap("date && uname");
    await shoot("command-open", "date && uname");
    // The failed command and the long one are the second run of calls: its line opens first.
    await tap(/Ran 2 commands/i);
    seen[`${deviceName}-error-tapped`] = await tap("carpeta-que-no-existe");
    seen[`${deviceName}-error-open`] = await lines(page);
    await shoot("error-open", "carpeta-que-no-existe");
    seen[`${deviceName}-long-tapped`] = await tap("git log --oneline");
    await shoot("long-output", "git log --oneline");
    if (!before) {
      const open = (seen[`${deviceName}-turn-open`] as string[]).join("\n");
      check(`${deviceName}: the finished turn reads "Worked for"`, (seen[`${deviceName}-folded`] as string[])[0]?.startsWith("Worked for") ?? false, JSON.stringify(seen[`${deviceName}-folded`]));
      check(`${deviceName}: folded, the turn shows only its answer`, !(seen[`${deviceName}-folded`] as string[]).some((l) => l.includes("Ran 3 commands")), JSON.stringify(seen[`${deviceName}-folded`]));
      check(`${deviceName}: three parallel commands read as one group`, open.includes("Ran 3 commands") && !open.includes("pwd && ls -la"), open);
      check(`${deviceName}: a thought is its own row`, open.includes("The user just wants to see how commands render"), open);
      const group = (seen[`${deviceName}-group-open`] as string[]).join("\n");
      check(`${deviceName}: the group opens onto one row per command`, ["pwd && ls -la", "date && uname -a && sw_vers", "for i in 1 2 3"].every((c) => group.includes(c)), group);
      const failed = (seen[`${deviceName}-error-open`] as string[]).join("\n");
      check(`${deviceName}: a failed command says its exit code`, failed.includes("Error: Exit code 1") && failed.includes("No such file or directory"), failed);
    }
    await context.close();

    // The same turn while it runs, then the rest of it landing while the operator watches.
    const run = running[i]!;
    const live = await browser.newContext({ ...device, colorScheme: "dark", timezoneId: "UTC", locale: "en-US" });
    const watch = await live.newPage();
    await watch.clock.install({ time: bridge.now() });
    await watch.goto(`${bridge.url}/pane/${encodeURIComponent(run.paneId)}`);
    await watch.getByText("Sumo uno que falla").waitFor({ timeout: 15_000 });
    await watch.waitForTimeout(1200);
    seen[`${deviceName}-working`] = await lines(watch);
    const path = join(outDir, `${prefix}-working-${deviceName}.png`);
    await watch.screenshot({ path, animations: "disabled" });
    shots.push(path);
    if (!before) check(`${deviceName}: a running turn reads "Working for"`, (seen[`${deviceName}-working`] as string[])[0]?.startsWith("Working for") ?? false, JSON.stringify(seen[`${deviceName}-working`]));
    await writeCommandsJournal(join(folder, `${run.session}.jsonl`), bridge.now(), "finished");
    fake.setStatus(run.paneId, "done");
    await watch.getByText("Listo, corrí 5 comandos").waitFor({ timeout: 15_000 });
    await watch.waitForTimeout(1200);
    const landed = join(outDir, `${prefix}-landed-${deviceName}.png`);
    await watch.screenshot({ path: landed, animations: "disabled" });
    shots.push(landed);
    await live.close();
  }
  return { checks, shots, seen };
}
