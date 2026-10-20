import { copyFile, cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DESKTOP, launchChrome, PHONE, userCacheDir, type Browser, type Page } from "./browser.ts";
import { startTestBridge } from "./bridge.ts";
import { seedDemoHerd } from "./scenario.ts";

// Tap to content on the screens that read the most, over projects and a conversation of real size:
// a copy of a real Organizations project read by the real herdr-organizations binary, and a real
// Claude journal behind one of its threads. The copy keeps the operator's registry untouched, and
// every Herdr socket it names is rewritten to the bench's FakeHerdr. Nothing is printed from the
// journal or the project: only times, sizes and counts.
//
//   bun scripts/e2e/perf.ts --projects ~/.herdr-projects --project awam-org --thread t-0451 \
//     --journal <a Claude .jsonl> [--coordinator-journal <another>] --cwd <that thread's worktree> [--runs 5] [--port 8798] [--out DIR] [--serve]
//
// Each run starts from a fresh page; times are from the tap to the frame that shows the content.

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8798" },
    out: { type: "string" },
    runs: { type: "string", default: "5" },
    projects: { type: "string" },
    project: { type: "string" },
    thread: { type: "string" },
    journal: { type: "string" },
    "coordinator-journal": { type: "string" },
    cwd: { type: "string" },
    label: { type: "string", default: "run" },
    serve: { type: "boolean", default: false },
  },
});
const need = (key: "projects" | "project" | "thread" | "journal" | "cwd") => {
  const value = values[key];
  if (!value) throw new Error(`--${key} is required`);
  return value;
};
const source = need("projects"), slug = need("project"), threadId = need("thread"), journal = need("journal"), threadCwd = need("cwd");
const coordinatorJournal = values["coordinator-journal"];
const runs = Number(values.runs);
/** The demo panes the thread and the project coordinator are bound to. */
const threadPane = "w1:idle", coordinatorPane = "w1:working";
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), `perf-${Date.now()}`);

/** The thread's binding and the coordinator's, pointed at the demo panes; every socket at the fake one. */
async function copyProject(root: string, { socketPath }: { socketPath: string }) {
  const dest = join(root, slug);
  await cp(join(source, slug), dest, { recursive: true, verbatimSymlinks: true });
  const rewrite = async (file: string, edit: (text: string) => string) => writeFile(file, edit(await readFile(file, "utf8")));
  const sockets = (text: string) => text.replace(/"socket":\s*"[^"]*"/g, `"socket": ${JSON.stringify(socketPath)}`).replace(/^socket = ".*"$/gm, `socket = ${JSON.stringify(socketPath)}`);
  for (const name of await readdir(join(dest, ".state"))) if (name.endsWith(".json")) await rewrite(join(dest, ".state", name), sockets);
  const bind = (pane: string, workspace: string, tab: string) => (text: string) => text
    .replace(/^pane_id = ".*"$/m, `pane_id = "${pane}"`).replace(/^workspace_id = ".*"$/m, `workspace_id = "${workspace}"`)
    .replace(/^tab_id = ".*"$/m, `tab_id = "${tab}"`).replace(/^cwd = ".*"$/m, `cwd = ${JSON.stringify(threadCwd)}`);
  await rewrite(join(dest, "threads", `${threadId}.toml`), (text) => sockets(bind(threadPane, "w1", "w1:t2")(text)));
  await rewrite(join(dest, ".state", "coordinator.json"), (text) => {
    const coordinator = JSON.parse(text) as Record<string, unknown>;
    return JSON.stringify({ ...coordinator, socket: socketPath, workspace_id: "w1", tab_id: "w1:t1", pane_id: coordinatorPane, cwd: threadCwd });
  });
}

/**
 * Tap `target`, then watch `ready` in the page on every frame: the time is the frame where it last
 * became true and stayed so for `quiet` ms (what a person sees as done), and `flips` counts how often
 * it fell back, a screen that showed something and then took it away. Both run in the page, so no
 * round trip to the bench is counted.
 */
interface Tap {
  ms: number;
  flips: number;
  /** The /api reads the tap set off before it was done, each as `route@start-end` in ms from the tap: the waterfall, which load stretches but does not reorder. */
  reads: string[];
}

async function tapTo(page: Page, target: string, ready: string, timeout = 30_000, quiet = 1500): Promise<Tap> {
  return page.evaluate(async ({ target, ready, timeout, quiet }) => {
    const element = new Function(`return (${target})`)() as HTMLElement | null;
    if (!element) throw new Error(`no target: ${target}`);
    const holds = new Function(`return Boolean(${ready})`) as () => boolean;
    const start = performance.now();
    element.click();
    const reads = (until: number) => (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
      .filter((entry) => entry.startTime >= start && entry.startTime <= until && entry.name.includes("/api/") && !entry.name.includes("/api/events"))
      .map((entry) => `${new URL(entry.name).pathname.replace(/^\/api\/pane\/[^/]+/, "pane").replace(/^\/api\//, "")}@${Math.round(entry.startTime - start)}-${Math.round(entry.responseEnd - start)}`);
    return new Promise<Tap>((resolve, reject) => {
      let since: number | null = null;
      let flips = 0;
      const tick = () => {
        const now = performance.now();
        if (holds()) {
          since ??= now;
          if (now - since >= quiet) return resolve({ ms: Math.round(since - start), flips, reads: reads(since) });
        } else if (since !== null) {
          flips++;
          since = null;
        }
        if (now - start > timeout) reject(new Error(`not ready: ${ready}`));
        else requestAnimationFrame(tick);
      };
      tick();
    });
  }, { target, ready, timeout, quiet });
}

const stats = (xs: Tap[]) => {
  const sorted = xs.map((x) => x.ms).sort((a, b) => a - b);
  return { runs: xs.map((x) => x.ms), median: sorted[Math.floor(sorted.length / 2)]!, min: sorted[0]!, max: sorted.at(-1)!, flips: xs.map((x) => x.flips), reads: xs.map((x) => x.reads) };
};

interface Surface {
  name: string;
  /**
   * The page a run starts on, taps made there first, each followed by what it must show (a tab, a
   * visit to another tab and back), and what must be on screen before the measured tap. `hover`
   * brings a pointer over the target that long before the tap, as a hand does.
   */
  start: string;
  prepare?: Array<{ tap: string; until: string }>;
  settled: string;
  hover?: number;
  target: string;
  ready: string;
}

const project = `/project/${slug}`;
const tab = (name: string) => `[...document.querySelectorAll('[role=tab]')].find((e) => e.textContent.trim() === ${JSON.stringify(name)})`;
const chat = `document.querySelectorAll('[data-turn]').length > 0`;
const contextFiles = `document.querySelector('section[aria-label="Every thread receives"] button[aria-expanded]')`;
const folder = `document.querySelector('ul[aria-label="Working directory files"] li')`;
const artifacts = (pane: string): Surface => ({
  name: `panel-artifacts-${pane === threadPane ? "thread" : "coordinator"}`,
  start: `/pane/${encodeURIComponent(pane)}`,
  settled: `${chat} && ${folder}`,
  prepare: [{ tap: tab("Files"), until: folder }],
  target: `[...document.querySelectorAll('[role=radio]')].find((e) => e.textContent.trim() === 'Artifacts')`,
  ready: `document.querySelector('[role=radio][aria-checked=true]')?.textContent.trim() === 'Artifacts' && ![...document.querySelectorAll('[role=tabpanel] [role=status]')].some((e) => /Reading|Checking/.test(e.textContent)) && /Delivered by the agent|Images|From Claude|named outside|No artifacts/.test(document.querySelector('[role=tabpanel]').textContent)`,
});
const surfaces = (desk: boolean): Surface[] => desk ? [
  { name: "context", start: project, settled: tab("Context"), target: tab("Context"), ready: contextFiles },
  { name: "context-after-hover", start: project, settled: tab("Context"), hover: 200, target: tab("Context"), ready: contextFiles },
  {
    name: "context-return",
    start: project,
    prepare: [{ tap: tab("Context"), until: contextFiles }, { tap: tab("Work"), until: `document.querySelector('.desk-card')` }],
    settled: tab("Context"),
    target: tab("Context"),
    ready: contextFiles,
  },
  {
    name: "work-finished-unfold",
    start: `${project}?work=finished`,
    settled: `document.querySelector('.desk-card [aria-expanded=false]')`,
    target: `document.querySelector('.desk-card [aria-expanded=false]')`,
    ready: `document.querySelector('.desk-card [role=group] .desk-row')`,
  },
  {
    name: "open-coordinator-page",
    start: `${project}?work=finished`,
    settled: `document.querySelector('.desk-card button[aria-label^="Open "]')`,
    target: `document.querySelector('.desk-card button[aria-label^="Open "]')`,
    ready: `location.pathname.includes('/node/') && document.querySelector('[role=tabpanel] .desk-card, [role=tabpanel] .desk-row')`,
  },
  {
    name: "open-thread",
    start: project,
    settled: `[...document.querySelectorAll('.desk-row')].find((e) => e.textContent.includes(window.__threadTitle))`,
    target: `[...document.querySelectorAll('.desk-row')].find((e) => e.textContent.includes(window.__threadTitle))`,
    ready: `location.pathname.startsWith('/pane/') && ${chat}`,
  },
  {
    name: "open-project-chat",
    start: project,
    settled: `[...document.querySelectorAll('button')].find((e) => e.textContent.trim() === 'Project chat')`,
    target: `[...document.querySelectorAll('button')].find((e) => e.textContent.trim() === 'Project chat')`,
    ready: `location.pathname.startsWith('/pane/') && ${chat}`,
  },
  { name: "panel-files", start: `/pane/${encodeURIComponent(threadPane)}`, settled: `${chat} && ${tab("Files")}`, target: tab("Files"), ready: folder },
  artifacts(threadPane),
  artifacts(coordinatorPane),
] : [
  // A phone has no project tabs nor session panel (ADR 0102): opening a thread and the chat's files sheet.
  {
    name: "open-thread",
    start: project,
    settled: `[...document.querySelectorAll('a, button')].find((e) => e.textContent.includes(window.__threadTitle))`,
    target: `[...document.querySelectorAll('a, button')].find((e) => e.textContent.includes(window.__threadTitle))`,
    ready: `location.pathname.startsWith('/pane/') && ${chat}`,
  },
];

async function measure(browser: Browser, url: string, title: string, form: "desk" | "phone") {
  const results: Record<string, ReturnType<typeof stats>> = {};
  for (const surface of surfaces(form === "desk")) {
    const times: Tap[] = [];
    for (let run = 0; run < runs; run++) {
      // The probes are strings evaluated in the page, which the strict CSP would refuse.
      const context = await browser.newContext({ ...(form === "desk" ? DESKTOP : PHONE), bypassCSP: true });
      const page = await context.newPage();
      try {
        await page.goto(`${url}${surface.start}`, { waitUntil: "load" });
        await page.evaluate((t) => { (window as unknown as { __threadTitle: string }).__threadTitle = t; }, title);
        const holds = (s: string) => page.waitForFunction((x) => new Function(`return Boolean(${x})`)(), s, { timeout: 30_000 });
        for (const step of surface.prepare ?? []) {
          await holds(step.tap);
          await page.evaluate((x) => (new Function(`return (${x})`)() as HTMLElement).click(), step.tap);
          await holds(step.until);
        }
        await holds(surface.settled);
        // Let the first reads settle, as a person would look at the page before tapping.
        await page.waitForTimeout(1500);
        if (surface.hover) {
          await page.evaluate((x) => (new Function(`return (${x})`)() as HTMLElement).dispatchEvent(new PointerEvent("pointerover", { bubbles: true })), surface.target);
          await page.waitForTimeout(surface.hover);
        }
        times.push(await tapTo(page, surface.target, surface.ready));
      } catch (error) {
        console.error(`[perf] ${form} ${surface.name} run ${run}: ${(error as Error).message.split("\n")[0]}`);
      } finally {
        await context.close();
      }
    }
    if (times.length) results[surface.name] = stats(times);
    const { reads: _reads, ...shown } = results[surface.name] ?? { reads: [] };
    console.log(`[perf] ${form} ${surface.name}: ${results[surface.name] ? JSON.stringify(shown) : null}`);
  }
  return results;
}

async function sizes(url: string) {
  const read = async (path: string) => {
    const start = performance.now();
    const response = await fetch(`${url}${path}`, { headers: { "accept-encoding": "gzip" } });
    const body = await response.arrayBuffer();
    return { ms: Math.round(performance.now() - start), status: response.status, bytes: body.byteLength };
  };
  const out: Record<string, Array<{ ms: number; status: number; bytes: number }>> = {};
  for (const path of [`/api/org/context?project=${slug}`, `/api/pane/w1%3Aidle/files?path=.`, `/api/pane/w1%3Aidle/history?limit=120`, `/api/pane/w1%3Aworking/history?limit=60`, `/api/snapshot`]) {
    out[path] = [];
    for (let i = 0; i < runs; i++) out[path].push(await read(path));
  }
  return out;
}

await mkdir(outDir, { recursive: true });
const bridge = await startTestBridge({
  port: Number(values.port),
  fake: true,
  orgBin: process.env.NENU_E2E_ORG_BIN ?? "herdr-organizations",
  seed: async (fake, ctx) => {
    const herd = await seedDemoHerd(fake, { ...ctx, cwd: threadCwd });
    await copyFile(journal, herd.journals.get(threadPane)!);
    if (coordinatorJournal) await copyFile(coordinatorJournal, herd.journals.get(coordinatorPane)!);
    return herd;
  },
  projects: copyProject,
});
if (values.serve) {
  // The same bridge, kept up for a look by hand.
  console.log(`[perf] serving ${bridge.url} (Ctrl-C stops it)`);
  process.on("SIGINT", () => void bridge.stop().then(() => process.exit(0)));
  process.on("SIGTERM", () => void bridge.stop().then(() => process.exit(0)));
  await new Promise(() => {});
}
let browser: Browser | null = null;
try {
  const overview = JSON.parse(await (await fetch(`${bridge.url}/api/snapshot`)).text()) as { projects?: Array<{ slug: string; threads: Array<{ id: string; title: string; paneId?: string }> }> };
  const thread = overview.projects?.find((candidate) => candidate.slug === slug)?.threads.find((candidate) => candidate.id === threadId);
  if (!thread?.paneId) console.error(`[perf] ${threadId} is not bound to a live pane; open-thread will fail`);
  browser = await launchChrome();
  const report = {
    label: values.label,
    at: new Date().toISOString(),
    load: (await Bun.$`uptime`.text()).trim(),
    api: await sizes(bridge.url),
    desk: await measure(browser, bridge.url, thread?.title ?? "", "desk"),
    phone: await measure(browser, bridge.url, thread?.title ?? "", "phone"),
  };
  const file = join(outDir, `perf-${values.label}.json`);
  await writeFile(file, JSON.stringify(report, null, 2));
  console.log(`[perf] wrote ${file}`);
} finally {
  await browser?.close();
  await bridge.stop();
}
