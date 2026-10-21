import { appendFile, copyFile, readFile, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { DESKTOP, PHONE, type Browser, type Page } from "./browser.ts";
import type { TestBridge } from "./bridge.ts";
import type { Check } from "./inline-images.ts";
import { writeLongJournal } from "./scenario.ts";

// The live-journal bench: an open conversation must show a line its agent just wrote, however long
// the log behind it already is. A chat on a large Claude log (the 2026-10-22 report: 40 MB, two days of
// pictures and compactions) is opened on a phone and a desk, then lines are appended to the log while
// it is on screen; each line's latency is the time from the append to its text in the DOM.
// `source` is a log to start from (a copy of a real one; never written to), cut at the last line
// boundary below each size; without it a synthetic long session is grown to each size.
//
// On the largest log a second scenario replays what the report's screenshot showed: a message the
// bridge answered as not sent, which the agent did receive, joined to text its box still held. Its
// failed bubble used to stay under every newer turn, so the chat's end never moved again. Each new
// line's latency there is the time until it is the chat's last line, on screen, with nothing under it.

const SIZES_MB = (process.env.NENU_E2E_LIVE_SIZES ?? "1,10,40").split(",").map(Number);
const LINES_PER_VIEW = 4;
/** One line must show within this; a fallback poll is 10 s, the live path well under a second. */
const LIMIT_MS = 3_000;

export interface LiveJournalResult {
  checks: Check[];
  rows: Array<{ sizeMb: number; view: string; latenciesMs: number[]; bridgeCpuMs: number; bridgeRssMb: number }>;
  shots: string[];
}

/** Bytes of `from` up to the last newline at or below `bytes`. */
async function cutAtLine(from: string, to: string, bytes: number): Promise<number> {
  const all = await readFile(from);
  const end = all.lastIndexOf(10, Math.min(bytes, all.length) - 1) + 1;
  await copyFile(from, to);
  await truncate(to, end);
  return end;
}

/** A synthetic long session of at least `bytes`. */
async function grow(to: string, bytes: number, at: number): Promise<number> {
  // writeLongJournal's turns are about 3.4 KB each.
  await writeLongJournal(to, Math.ceil(bytes / 3_400), at);
  return (await readFile(to)).length;
}

/** CPU time (ms) and resident memory (MB) of a process, from /proc. */
async function usage(pid: number): Promise<{ cpuMs: number; rssMb: number }> {
  const stat = (await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1]!.split(" ");
  const tick = 1000 / 100; // USER_HZ
  const status = await readFile(`/proc/${pid}/status`, "utf8");
  const rss = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
  return { cpuMs: (Number(stat[11]) + Number(stat[12])) * tick, rssMb: Math.round(rss / 1024) };
}

const UNSEEN = "Your message didn't show in the agent's input box, so nothing was sent.";
const SENT = "Haceme una foto diagrama con el fondo negro y una grilla cuadriculada";
const LEFTOVER = "Se cortó por el límite de la cuenta y ya cambió. Continuá desde donde quedaste.";

let lineSeq = 0;
function liveLine(text: string, at: number, role: "user" | "assistant" = "assistant"): string {
  const uuid = `99999999-0000-4000-8000-${String(++lineSeq).padStart(12, "0")}`;
  const message = role === "user" ? { role, content: text } : { role, content: [{ type: "text", text }], stop_reason: null };
  return JSON.stringify({ type: role, uuid, parentUuid: null, timestamp: new Date(at).toISOString(), message }) + "\n";
}

/** Ms from appending each line until it shows (`end`: until it is the chat's last line, on screen). */
async function appendLines(page: Page, file: string, now: () => number, label: string, end: boolean): Promise<number[]> {
  const latencies: number[] = [];
  for (let i = 0; i < LINES_PER_VIEW; i++) {
    const marker = `${label}-${i}-${Date.now()}`;
    const t0 = Date.now();
    await appendFile(file, liveLine(marker, now()));
    const shown = end
      ? await page.waitForFunction(({ marker, unseen }) => {
        const line = Array.from(document.querySelectorAll("p")).find((p) => p.textContent?.includes(marker));
        const bottom = line?.getBoundingClientRect().bottom ?? Infinity;
        return line !== undefined && bottom <= window.innerHeight && !document.body.textContent?.includes(unseen);
      }, { marker, unseen: UNSEEN }, { timeout: 15_000 }).then(() => true, () => false)
      : await page.getByText(marker).first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
    latencies.push(shown ? Date.now() - t0 : Infinity);
    await page.waitForTimeout(1_200);
  }
  return latencies;
}

const shownWithin = (latencies: number[]) => latencies.map((ms) => (Number.isFinite(ms) ? `${ms} ms` : "never")).join(", ");

/**
 * The report's send: the bridge answers that nothing was sent, the log then holds the message joined
 * to the text the box held, and the agent goes on working.
 */
async function joinedSend(page: Page, file: string, now: () => number, label: string, shot: string, shots: string[]): Promise<Check> {
  await page.route("**/api/pane/*/send*", (route) => route.fulfill({ status: 409, json: {
    ok: false, requestId: (route.request().postDataJSON() as { requestId: string }).requestId, stage: "verify", textDelivered: true,
    error: `${UNSEEN} If any of it is in the agent's box, it shows above yours with Send it first and Discard.`,
  } }));
  await page.getByRole("textbox").first().fill(SENT);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const failed = await page.getByText(UNSEEN).first().waitFor({ timeout: 10_000 }).then(() => true, () => false);
  await appendFile(file, liveLine(`${SENT}${LEFTOVER}`, now(), "user"));
  const latencies = await appendLines(page, file, now, "after-joined-send", true);
  await page.screenshot({ path: shot, animations: "disabled" });
  shots.push(shot);
  return {
    name: `${label}: after a send the agent got joined to its box's text, each new line ends the chat within ${LIMIT_MS} ms`,
    ok: failed && Math.max(...latencies) <= LIMIT_MS,
    detail: failed ? shownWithin(latencies) : "the send never showed as failed",
  };
}

export async function liveJournalBench(bridge: TestBridge, browser: Browser, outDir: string, source?: string): Promise<LiveJournalResult> {
  const checks: Check[] = [];
  const rows: LiveJournalResult["rows"] = [];
  const shots: string[] = [];
  const pane = bridge.herd!.idle;
  const file = bridge.herd!.journals.get(pane)!;
  for (const sizeMb of SIZES_MB) {
    const size = source ? await cutAtLine(source, file, sizeMb * 1e6) : await grow(file, sizeMb * 1e6, bridge.now() - 86_400_000);
    for (const [view, device] of [["phone", PHONE], ["desk", DESKTOP]] as const) {
      // No service worker: the joined-send scenario answers /send itself, and a worker would take it first.
      const context = await browser.newContext({ ...device, serviceWorkers: "block" });
      const page = await context.newPage();
      await page.goto(`${bridge.url}/pane/${encodeURIComponent(pane)}`);
      await page.getByRole("textbox").first().waitFor({ timeout: 60_000 });
      await page.waitForTimeout(3_000);
      const before = await usage(bridge.pid);
      const latencies = await appendLines(page, file, bridge.now, `live-line-${sizeMb}mb-${view}`, false);
      const after = await usage(bridge.pid);
      const path = join(outDir, `live-journal-${sizeMb}mb-${view}.png`);
      await page.screenshot({ path, animations: "disabled" });
      shots.push(path);
      rows.push({ sizeMb, view, latenciesMs: latencies, bridgeCpuMs: after.cpuMs - before.cpuMs, bridgeRssMb: after.rssMb });
      checks.push({
        name: `${sizeMb} MB log (${(size / 1e6).toFixed(1)} MB), ${view}: every new line shows within ${LIMIT_MS} ms`,
        ok: Math.max(...latencies) <= LIMIT_MS,
        detail: shownWithin(latencies),
      });
      if (sizeMb === SIZES_MB.at(-1)) checks.push(await joinedSend(page, file, bridge.now, `${sizeMb} MB log, ${view}`, join(outDir, `live-journal-joined-${view}.png`), shots));
      await context.close();
    }
  }
  await writeFile(join(outDir, "live-journal-rows.json"), JSON.stringify(rows, null, 2));
  return { checks, rows, shots };
}
