import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { DESKTOP, PHONE, type Browser, type Page } from "./browser.ts";
import type { TestBridge } from "./bridge.ts";
import type { Check } from "./inline-images.ts";

// The usage-limit bench (ADR 0120), on a desk and a phone in WebKit, against a Claude pane whose
// account hit its usage limit: Claude's own rows from the operator's coordinator on 2026-10-21 in its
// transcript, its session file at rest, and the notice it prints under the box on screen.
//   1. The chat says "Usage limit · resets …" with Continue now; the desk's bar draws when it resets.
//   2. Send waits in Nenu's queue and says until when: nothing is typed, nothing fails, the box is empty.
//   3. Continue now types the continue prompt past the limit.
//   4. The account answers again (a reply in the transcript): the limit lifts and the waiting message
//      goes by itself.
// On 1.41.2 the same screen made Send answer "Your message didn't show in the agent's input box".

const PID = 525252;
const ROWS = join(import.meta.dir, "..", "..", "bridge", "test-support", "agent-state", "claude-2.1.306-transcript-usage-limit.jsonl");
const MESSAGE = "Haceme una foto diagrama con el fondo negro y una grilla";

/** The limit rows of the real transcript, moved to just after `after` and resetting at `resetsAt`. */
async function limitRows(after: number, resetsAt: number): Promise<string> {
  const rows = (await readFile(ROWS, "utf8")).split("\n").filter(Boolean).slice(0, 8).map((line) => JSON.parse(line) as Record<string, unknown>);
  const shift = after + 1_000 - Date.parse(rows[0]!.timestamp as string);
  return rows.map((row) => {
    const moved: Record<string, unknown> = { ...row, timestamp: new Date(Date.parse(row.timestamp as string) + shift).toISOString() };
    if (row.apiError === "usage_limit_reached") {
      const seconds = Math.floor(resetsAt / 1000);
      moved.quotaLimits = { ...(row.quotaLimits as object), resetsAt: seconds };
      moved.apiErrorParams = { rate_limit_info: { ...((row.apiErrorParams as { rate_limit_info: object }).rate_limit_info), resetsAt: seconds } };
    }
    return JSON.stringify(moved);
  }).join("\n") + "\n";
}

export async function usageLimitBench(bridge: TestBridge, browser: Browser, outDir: string): Promise<{ checks: Check[]; shots: string[] }> {
  const checks: Check[] = [];
  const shots: string[] = [];
  const check = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) });
  const fake = bridge.fake!;
  const herd = bridge.herd!;
  const pane = herd.idle;
  const transcript = herd.journals.get(pane)!;
  const sessionId = transcript.split("/").at(-1)!.replace(/\.jsonl$/, "");
  const sessions = join(bridge.dir, "journals", "sessions");
  await mkdir(sessions, { recursive: true });
  const writeSession = (status: string) =>
    writeFile(join(sessions, `${PID}.json`), JSON.stringify({ pid: PID, sessionId, kind: "interactive", version: "2.1.306", status, statusUpdatedAt: Date.now(), updatedAt: Date.now() }));

  const resetsAt = Date.now() + 2 * 3_600_000;
  // The transcript's clock: each row the bench writes comes after the last, as Claude's do.
  let clock = 0;
  const tick = () => new Date(clock = Math.max(clock + 1_000, Date.now())).toISOString();
  const row = (value: object) => appendFile(transcript, JSON.stringify(value) + "\n");
  // Claude logs every message it takes; with the limit on, the limit refuses it at once (measured).
  let limited = true;
  let logged = 0;
  // A turn flips the session file busy and back, which is when the bridge reads the transcript.
  let logging = Promise.resolve();
  const logger = setInterval(() => {
    for (const { text } of fake.submitted.slice(logged)) logging = logging.then(() => claudeTakes(text));
    logged = fake.submitted.length;
  }, 50);
  const claudeTakes = async (text: string) => {
    await writeSession("busy");
    await row({ type: "user", timestamp: tick(), message: { role: "user", content: text } });
    if (limited) await row({ type: "assistant", timestamp: tick(), apiError: "usage_limit_reached", isApiErrorMessage: true, quotaLimits: { resetsAt: Math.floor(resetsAt / 1000) }, message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "You've hit your session limit" }] } });
    else await row({ type: "assistant", timestamp: tick(), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "On it." }] } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await writeSession("idle");
  };
  // After the demo conversation's last row: a reply later than the limit would lift it, as it should.
  const latest = Math.max(...(await readFile(transcript, "utf8")).split("\n").filter(Boolean).map((line) => Date.parse((JSON.parse(line) as { timestamp?: string }).timestamp ?? "") || 0));
  const rows = await limitRows(latest, resetsAt);
  await appendFile(transcript, rows);
  clock = Math.max(...rows.split("\n").filter(Boolean).map((line) => Date.parse((JSON.parse(line) as { timestamp: string }).timestamp)));
  await writeSession("idle");
  fake.processes.set(pane, [{ pid: PID, argv: ["claude"] }]);
  fake.usageLimit.set(pane, "3:20am");
  fake.setStatus(pane, "done");

  const open = async (device: "desk" | "phone") => {
    const context = await browser.newContext({ ...(device === "phone" ? PHONE : DESKTOP), timezoneId: "UTC", locale: "en-US" });
    const page = await context.newPage();
    await page.goto(`${bridge.url}/pane/${encodeURIComponent(pane)}`);
    await page.getByRole("textbox").first().waitFor({ timeout: 15_000 });
    return { page, close: () => context.close() };
  };
  const shoot = async (page: Page, label: string) => {
    const path = join(outDir, `usage-limit-${label}.png`);
    await page.screenshot({ path, animations: "disabled" });
    shots.push(path);
  };
  const seen = (page: Page, text: string | RegExp, timeout = 8_000) => page.getByText(text).first().waitFor({ timeout }).then(() => true, () => false);

  // 1. A desk: the chat's line and the bar's row.
  const desk = await open("desk");
  const turn = await waitForTurn(desk.page, pane);
  check("the bridge reads the limit from Claude's log", typeof (turn as { limit?: { resetsAt?: number } } | null)?.limit?.resetsAt === "number", JSON.stringify(turn));
  check("desk: the chat names the limit and when it resets", await seen(desk.page, /^Usage limit · resets /));
  check("desk: the bar's row says when it resets", await desk.page.locator("[data-limit]").first().waitFor({ timeout: 5_000 }).then(() => true, () => false));
  await shoot(desk.page, "desk");
  await desk.close();

  // 2. A phone: Send waits in Nenu's queue.
  const phone = await open("phone");
  const { page } = phone;
  check("phone: the chat names the limit, with Continue now", await seen(page, /^Usage limit · resets /) && await page.getByRole("button", { name: "Continue now" }).isVisible());
  await shoot(page, "phone-limited");
  const before = fake.submitted.length;
  await page.getByRole("textbox").first().fill(MESSAGE);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  check("phone: the message waits and says until when", await seen(page, /Goes when Claude is back, ~/));
  await page.waitForTimeout(2_500);
  const draft = [...fake.screen(pane).matchAll(/^❯ (.*)$/gm)].at(-1)?.[1]?.trim() ?? "";
  check("phone: nothing was typed into Claude's box, nothing failed", fake.submitted.length === before && draft === "" && !(await page.getByText(/nothing was sent/i).isVisible()), `submitted ${fake.submitted.length - before}, box "${draft}"`);
  await shoot(page, "phone-queued");

  // 3. The account is switched; Continue now types the continue prompt past the limit, Claude answers,
  //    the limit lifts and the waiting message goes by itself.
  limited = false;
  fake.usageLimit.delete(pane);
  const clicked = await page.getByRole("button", { name: "Continue now" }).click({ timeout: 5_000 }).then(() => true, (err: Error) => err.message.split("\n")[0]);
  const continued = await waitFor(() => fake.submitted.slice(before).some((r) => r.text.startsWith("Continue the task you were working on")), 8_000);
  const sent = () => JSON.stringify(fake.submitted.slice(before).map((r) => r.text.slice(0, 40)));
  check("phone: Continue now types the continue prompt", continued, `${clicked} ${sent()}`);
  const delivered = await waitFor(() => fake.submitted.slice(before).some((r) => r.text === MESSAGE), 15_000);
  check("phone: the waiting message goes once the limit lifts, after the continue prompt", delivered && fake.submitted.slice(before).map((r) => r.text)[1] === MESSAGE, sent());
  check("phone: the line is gone", await page.getByText(/^Usage limit · resets /).first().waitFor({ state: "hidden", timeout: 5_000 }).then(() => true, () => false));
  await page.waitForTimeout(1_500);
  await shoot(page, "phone-resumed");
  await phone.close();
  clearInterval(logger);
  return { checks, shots };
}

/** The pane's `turn` from the snapshot, once it names a limit or after a few seconds. */
async function waitForTurn(page: Page, paneId: string): Promise<unknown> {
  let turn: unknown = null;
  for (let i = 0; i < 30; i++) {
    turn = await page.evaluate(async (id: string) => {
      const snapshot = await (await fetch("/api/snapshot")).json() as { agents: Array<{ paneId: string; turn?: unknown }> };
      return snapshot.agents.find((agent) => agent.paneId === id)?.turn ?? null;
    }, paneId);
    if ((turn as { limit?: unknown } | null)?.limit) break;
    await page.waitForTimeout(300);
  }
  return turn;
}

async function waitFor(test: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 100))) if (test()) return true;
  return test();
}
