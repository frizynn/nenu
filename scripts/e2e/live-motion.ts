import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DESKTOP, launchChrome, userCacheDir, type Browser, type Page } from "./browser.ts";
import { startTestBridge } from "./bridge.ts";
import { seedDemoHerd } from "./scenario.ts";

// What work in progress costs while it looks alive (ADR 0117): a desk with 40 agents working at once
// (Home and the bar) and a chat whose turn runs, quiet for --seconds each, in Chrome. The browser's
// CPU (every process this run launched, from ps) with motion allowed and with reduced motion, which
// takes every live motion out of the page, on the same build, alternated --runs times; and how many
// live motions each screen ran. Run it from another checkout to measure that build the same way.
//
//   bun scripts/e2e/live-motion.ts [--port 8879] [--seconds 30] [--runs 2] [--working 40] [--out DIR]

const { values } = parseArgs({ options: {
  port: { type: "string", default: "8879" }, seconds: { type: "string", default: "30" }, runs: { type: "string", default: "2" },
  working: { type: "string", default: "40" }, out: { type: "string" },
} });
const port = Number(values.port);
const seconds = Number(values.seconds);
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), `live-motion-${Date.now()}`);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** CPU time in ms of this process's descendants (the browser and its helpers): /proc's clock ticks on
 *  Linux, since ps rounds to whole seconds; ps elsewhere. */
async function descendantsCpuMs(): Promise<number> {
  const out = await new Response(Bun.spawn(["ps", "-axo", "pid=,ppid=,time="]).stdout).text();
  const rows = out.trim().split("\n").map((line) => line.trim().split(/\s+/)).map(([pid, ppid, time]) => ({ pid: Number(pid), ppid: Number(ppid), time: time! }));
  const mine = new Set([process.pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) if (!mine.has(row.pid) && mine.has(row.ppid)) { mine.add(row.pid); grew = true; }
  }
  mine.delete(process.pid);
  const ps = (time: string) => {
    const [clock, days] = time.includes("-") ? [time.split("-")[1]!, Number(time.split("-")[0])] : [time, 0];
    return Math.round((days * 86400 + clock.split(":").map(Number).reduce((acc, n) => acc * 60 + n, 0)) * 1000);
  };
  let total = 0;
  for (const row of rows) {
    if (!mine.has(row.pid)) continue;
    try {
      // Fields 14 and 15 (utime, stime) after the parenthesised command, in 1/100 s.
      const stat = (await Bun.file(`/proc/${row.pid}/stat`).text()).split(") ")[1]!.split(" ");
      total += (Number(stat[11]) + Number(stat[12])) * 10;
    } catch {
      total += ps(row.time);
    }
  }
  return total;
}

/** The live motions a screen runs now: glows moving, working marks turning, and any other animation. */
function liveCount(page: Page) {
  return page.evaluate(() => ({
    glows: document.querySelectorAll('[data-glow="running"]').length,
    marks: document.querySelectorAll('[data-node-state="working"][data-moving]').length,
    workingMarks: document.querySelectorAll('[data-node-state="working"]').length,
    animations: document.getAnimations().filter((a) => a.playState === "running").length,
  }), null);
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const working = Number(values.working);
  const bridge = await startTestBridge({
    port, fake: true,
    seed: async (fake, ctx) => {
      const herd = await seedDemoHerd(fake, ctx);
      fake.addWorkspace("w9", "fleet");
      for (let i = 0; i < working; i++) {
        const tab = `w9:t${i}`;
        fake.addTab(tab, `agent ${i}`);
        fake.addPane({ paneId: `w9:a${i}`, workspaceId: "w9", tabId: tab, agent: "claude", label: `Agent ${i}`, cwd: ctx.cwd, lines: [`❯ Task ${i}`, "", `● Working on task ${i}.`] });
        fake.setStatus(`w9:a${i}`, "working");
      }
      return herd;
    },
  });
  let browser: Browser | null = null;
  const results: Array<Record<string, unknown>> = [];
  try {
    browser = await launchChrome();
    for (let run = 0; run < Number(values.runs); run++) {
      for (const motion of ["no-preference", "reduce"] as const) {
        for (const [screen, path] of [["home", "/"], ["chat", `/pane/${encodeURIComponent(bridge.herd!.working)}`]] as const) {
          const context = await browser.newContext({ ...DESKTOP, reducedMotion: motion });
          const page = await context.newPage();
          await page.goto(`${bridge.url}${path}`);
          await sleep(4000);
          const live = await liveCount(page);
          if (run === 0) await page.screenshot({ path: join(outDir, `${screen}-${motion}.png`) });
          const before = await descendantsCpuMs();
          await sleep(seconds * 1000);
          const cpu = await descendantsCpuMs() - before;
          results.push({ run, motion, screen, ...live, browserCpuMs: cpu, browserCpuPercent: Math.round(cpu / (seconds * 1000) * 1000) / 10 });
          console.log(JSON.stringify(results.at(-1)));
          await context.close();
        }
      }
    }
  } finally {
    await browser?.close();
    await bridge.stop();
  }
  await writeFile(join(outDir, "live-motion.json"), JSON.stringify({ seconds, working, results }, null, 2));
  console.log(`results in ${outDir}`);
}

await main();
