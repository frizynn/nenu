import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DESKTOP, launchWebkit, PHONE, userCacheDir, type Browser } from "./browser.ts";
import { startTestBridge, type TestBridge } from "./bridge.ts";
import { tickJournal } from "./scenario.ts";

// The e2e bench. Every command starts its own test bridge on a FakeHerdr (bridge.ts), so nothing
// here can reach the live service or a real terminal.
//
//   bun scripts/e2e/run.ts smoke    [--port 8797] [--out DIR]   Home screenshots, phone + desktop
//   bun scripts/e2e/run.ts baseline [--port 8797] [--out DIR] [--seconds 60] [--sends 5]
//   bun scripts/e2e/run.ts compare A.png B.png                  share of differing pixels
//
// Output goes outside the repo: --out, else $NENU_E2E_OUT, else <user cache>/nenu-e2e/<stamp>.

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string", default: "8797" },
    out: { type: "string" },
    seconds: { type: "string", default: "60" },
    sends: { type: "string", default: "5" },
  },
});

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), stamp);
const port = Number(values.port);
// Captures render at this instant (a Saturday afternoon, UTC) whenever they are taken.
const CAPTURE_EPOCH = Date.parse("2026-10-10T14:00:00Z");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Bridge process CPU time in ms, from ps (macOS and Linux print [[dd-]hh:]mm:ss[.cc]). */
async function cpuMs(pid: number): Promise<number> {
  const out = (await new Response(Bun.spawn(["ps", "-o", "time=", "-p", String(pid)]).stdout).text()).trim();
  const [clock, days] = out.includes("-") ? [out.split("-")[1]!, Number(out.split("-")[0])] : [out, 0];
  const parts = clock.split(":").map(Number);
  const seconds = parts.reduce((acc, n) => acc * 60 + n, 0);
  return Math.round((days * 86400 + seconds) * 1000);
}

/** `/api/pane/w1%3Aworking/history?…` → `pane/:id/history`, so counts group by route. */
function route(url: string): string | null {
  const { pathname } = new URL(url);
  if (!pathname.startsWith("/api/")) return null;
  return pathname.slice(5).replace(/^pane\/[^/]+/, "pane/:id").replace(/^tab\/[^/]+/, "tab/:id");
}

function tally(urls: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const u of urls) {
    const r = route(u);
    if (r) counts[r] = (counts[r] ?? 0) + 1;
  }
  return counts;
}

const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
const perMinute = (o: Record<string, number>, ms: number) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round((v * 60_000 / ms) * 10) / 10]));
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;

async function withBench<T>(fn: (bridge: TestBridge, browser: Browser) => Promise<T>, epoch?: number): Promise<T> {
  const bridge = await startTestBridge({ port, fake: true, epoch });
  let browser: Browser | null = null;
  try {
    browser = await launchWebkit();
    return await fn(bridge, browser);
  } finally {
    await browser?.close();
    await bridge.stop();
  }
}

/** A phone page that records every /api request it makes. */
async function phonePage(browser: Browser, opts: { rawTerminal?: string } = {}) {
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  if (opts.rawTerminal) {
    // The mirror is a per-pane display pref (use-display-prefs.ts), keyed by [session, paneId].
    await page.addInitScript((scope: string) => {
      localStorage.setItem("collie:raw-terminal-scopes:v1", JSON.stringify({ [scope]: true }));
    }, JSON.stringify(["default", opts.rawTerminal]));
  }
  const requests: Array<{ url: string; at: number }> = [];
  page.on("request", (req) => requests.push({ url: req.url(), at: Date.now() }));
  return { page, requests, close: () => context.close() };
}

async function smoke(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const result = await withBench(async (bridge, browser) => {
    const shots: string[] = [];
    for (const [name, device] of [["home-phone", PHONE], ["home-desktop", DESKTOP]] as const) {
      const context = await browser.newContext({ ...device, timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      await page.clock.install({ time: bridge.now() });
      await page.goto(bridge.url + "/");
      await page.getByText("Working Claude").first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1500);
      const path = join(outDir, `${name}.png`);
      await page.screenshot({ path, animations: "disabled" });
      shots.push(path);
      await context.close();
    }
    // The temp registry is empty; a project here means the operator's real one leaked in.
    const { projects } = await fetch(`${bridge.url}/api/snapshot`).then((r) => r.json() as Promise<{ projects?: unknown[] }>);
    return { shots, projects: projects?.length ?? 0, herdrCalls: bridge.fake!.counts(), unexpectedWrites: bridge.fake!.writes() };
  }, CAPTURE_EPOCH);
  await writeFile(join(outDir, "smoke.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (result.unexpectedWrites.length || result.projects) process.exit(1);
}

async function baseline(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const windowMs = Number(values.seconds) * 1000;
  const sends = Number(values.sends);

  const report = await withBench(async (bridge, browser) => {
    const fake = bridge.fake!;
    const herd = bridge.herd!;
    const stopJournal = tickJournal(herd.journals.get(herd.working)!, bridge.now);
    const out: Record<string, unknown> = {
      measuredAt: new Date().toISOString(),
      against: "FakeHerdr (bridge/test-support/fake-herdr.ts), demo herd in scripts/e2e/scenario.ts",
      browser: "WebKit (playwright-core 1.60.0, webkit-2287), iPhone viewport 390x844",
      windowSeconds: windowMs / 1000,
    };

    // 1. Socket calls the bridge makes on its own, with no browser attached.
    await sleep(3000);
    fake.resetCounts();
    let cpu0 = await cpuMs(bridge.pid);
    await sleep(windowMs);
    const idleCalls = fake.counts();
    out.noClients = {
      herdrCallsPerMinute: perMinute(idleCalls, windowMs),
      socketCallsPerPoll: Math.round((sum(idleCalls) / Math.max(1, idleCalls["session.snapshot"] ?? 0)) * 10) / 10,
      bridgeCpuPercent: Math.round(((await cpuMs(bridge.pid)) - cpu0) / windowMs * 1000) / 10,
    };

    // 2. One phone per view, measured over the same window after a warm-up.
    const views: Array<[string, string, { rawTerminal?: string }]> = [
      ["home", "/", {}],
      ["chatWorking", `/pane/${encodeURIComponent(herd.working)}`, {}],
      ["mirrorWorking", `/pane/${encodeURIComponent(herd.working)}`, { rawTerminal: herd.working }],
      ["dialogOnScreen", `/pane/${encodeURIComponent(herd.blocked)}`, {}],
    ];
    const perView: Record<string, unknown> = {};
    for (const [name, path, opts] of views) {
      const phone = await phonePage(browser, opts);
      await phone.page.goto(bridge.url + path);
      await sleep(5000);
      const from = Date.now();
      fake.resetCounts();
      cpu0 = await cpuMs(bridge.pid);
      await sleep(windowMs);
      const http = tally(phone.requests.filter((r) => r.at >= from).map((r) => r.url));
      perView[name] = {
        httpRequestsPerMinute: Math.round(sum(http) * 60_000 / windowMs),
        byRoute: perMinute(http, windowMs),
        herdrCallsPerMinute: perMinute(fake.counts(), windowMs),
        bridgeCpuPercent: Math.round(((await cpuMs(bridge.pid)) - cpu0) / windowMs * 1000) / 10,
      };
      await phone.close();
    }
    out.perPhone = perView;

    // 3. Tap Send to Enter on the idle Claude pane: the guarded reply's full client choreography.
    {
      const phone = await phonePage(browser);
      await phone.page.goto(bridge.url + `/pane/${encodeURIComponent(herd.idle)}`);
      const box = phone.page.getByPlaceholder("Type a reply…").first();
      await box.waitFor({ timeout: 15_000 });
      await sleep(2000);
      const samples: Array<{ tapToEnterMs: number; httpTrips: number; byRoute: Record<string, number> }> = [];
      for (let i = 0; i < sends; i++) {
        const text = `baseline send ${i + 1}`;
        await box.fill(text);
        const before = fake.submitted.length;
        const t0 = Date.now();
        await phone.page.getByRole("button", { name: "Send", exact: true }).click();
        while (fake.submitted.length === before && Date.now() - t0 < 15_000) await sleep(5);
        const enter = fake.submitted[before];
        if (!enter || enter.text !== text) throw new Error(`send ${i + 1} never reached Enter (saw ${JSON.stringify(enter)})`);
        const trips = tally(phone.requests.filter((r) => r.at >= t0 && r.at <= enter.at).map((r) => r.url));
        samples.push({ tapToEnterMs: enter.at - t0, httpTrips: sum(trips), byRoute: trips });
        await sleep(1500);
      }
      const ms = samples.map((s) => s.tapToEnterMs);
      out.send = { pane: "claude idle", runs: sends, p50Ms: pct(ms, 0.5), maxMs: Math.max(...ms), samples };
      await phone.close();
    }

    // 4. Answer the permission dialog from the pane view: HTTP trips from the tap to the key.
    {
      const phone = await phonePage(browser);
      await phone.page.goto(bridge.url + `/pane/${encodeURIComponent(herd.blocked)}`);
      const yes = phone.page.getByRole("button", { name: /^1\.?\s*Yes$|^Yes$/ }).first();
      await yes.waitFor({ timeout: 15_000 });
      await sleep(2000);
      const t0 = Date.now();
      await yes.click();
      while (fake.answered.length === 0 && Date.now() - t0 < 15_000) await sleep(5);
      const answer = fake.answered[0];
      if (!answer) throw new Error("the dialog answer never reached the fake terminal");
      await sleep(2000);
      const toKey = tally(phone.requests.filter((r) => r.at >= t0 && r.at <= answer.at).map((r) => r.url));
      const settled = tally(phone.requests.filter((r) => r.at >= t0).map((r) => r.url));
      out.dialogAnswer = {
        key: answer.key, tapToKeyMs: answer.at - t0,
        httpTripsToKey: sum(toKey), byRouteToKey: toKey,
        httpTripsWithin2sAfter: sum(settled), byRouteWithin2sAfter: settled,
      };
      await phone.close();
    }

    stopJournal();
    // The only writes this run drives: the sends on the idle pane and the dialog key on the blocked one.
    const expected = new Set([`pane.send_text ${herd.idle}`, `pane.send_keys ${herd.idle}`, `pane.send_keys ${herd.blocked}`]);
    out.unexpectedWrites = fake.writes().filter((c) => !expected.has(`${c.method} ${String(c.params.pane_id)}`));
    return out;
  });

  const file = join(outDir, "baseline.json");
  await writeFile(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`\n[e2e] baseline written to ${file}`);
}

/** Share of differing pixels between two same-size PNGs, decoded by WebKit itself. */
async function compare(a: string, b: string): Promise<void> {
  const browser = await launchWebkit();
  try {
    const page = await (await browser.newContext({})).newPage();
    const toUrl = async (p: string) => `data:image/png;base64,${Buffer.from(await Bun.file(p).arrayBuffer()).toString("base64")}`;
    const result = await page.evaluate(async ([ua, ub]: string[]) => {
      const load = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
      });
      const [ia, ib] = await Promise.all([load(ua!), load(ub!)]);
      if (ia.width !== ib.width || ia.height !== ib.height) return { sameSize: false, differing: 1 };
      const pixels = (img: HTMLImageElement) => {
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, c.width, c.height).data;
      };
      const pa = pixels(ia), pb = pixels(ib);
      let diff = 0;
      for (let i = 0; i < pa.length; i += 4) {
        if (Math.abs(pa[i]! - pb[i]!) + Math.abs(pa[i + 1]! - pb[i + 1]!) + Math.abs(pa[i + 2]! - pb[i + 2]!) > 24) diff++;
      }
      return { sameSize: true, differing: diff / (pa.length / 4) };
    }, [await toUrl(a), await toUrl(b)]);
    console.log(JSON.stringify({ a, b, ...result, differingPercent: Math.round(result.differing * 10000) / 100 }));
  } finally {
    await browser.close();
  }
}

const command = positionals[0];
if (command === "smoke") await smoke();
else if (command === "baseline") await baseline();
else if (command === "compare" && positionals[2]) await compare(positionals[1]!, positionals[2]);
else {
  console.error("usage: bun scripts/e2e/run.ts smoke|baseline [--port 8797] [--out DIR] | compare A.png B.png");
  process.exit(2);
}
