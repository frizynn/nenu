import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { HerdrClient } from "../../bridge/herdr-client.ts";
import { DESKTOP, launchWebkit, PHONE, userCacheDir, type Page } from "./browser.ts";
import { startTestBridge, type TestBridge } from "./bridge.ts";

// Start coordinator against a real Herdr and a real Organizations: the bench's disposable Herdr
// (`--herdr`), the Organizations binary named by --org-bin over the bench's empty registry, and a
// real agent in the pane, signed in through links into the operator's own credentials (docs/testing-e2e.md,
// "A real agent in the disposable Herdr"). Each run makes a fresh project, opens its page, taps Start
// (and, when a window asks, its Start), and records in the page when the tap showed something, when
// the "Starting" feedback went away, when a coordinator row without a chat showed, and when the page
// reached the coordinator's chat. The bridge's `open` request is timed beside it.
//
//   bun scripts/e2e/coordinator-start.ts --org-bin <path> [--harness claude|codex] [--runs 3] [--label before] [--port 8851] [--out DIR]

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8851" },
    out: { type: "string" },
    runs: { type: "string", default: "3" },
    label: { type: "string", default: "run" },
    harness: { type: "string", default: "claude" },
    "org-bin": { type: "string" },
    light: { type: "boolean", default: false },
  },
});
const orgBin = values["org-bin"];
if (!orgBin || !existsSync(orgBin)) throw new Error("pass --org-bin <a herdr-organizations binary>");
const harness = values.harness === "codex" ? "codex" : "claude";
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), `coordinator-start-${Date.now()}`);

/** What the page shows at one instant, as the recorder in the page names it. */
interface Mark { state: string; at: number }

/**
 * Sign the temporary HOME in with the operator's own credentials, by link: Claude's keychain and
 * account, Codex's auth.json, Herdr's Claude hook so the pane reports its session. Nothing is copied
 * but the account block of ~/.claude.json, which Organizations reads to call Claude signed in.
 */
async function signIn(bridge: TestBridge): Promise<void> {
  const home = bridge.home;
  await mkdir(join(home, "Library"), { recursive: true });
  if (!existsSync(join(home, "Library", "Keychains"))) await symlink(join(homedir(), "Library", "Keychains"), join(home, "Library", "Keychains"));
  await mkdir(join(home, ".codex"), { recursive: true });
  if (!existsSync(join(home, ".codex", "auth.json"))) await symlink(join(homedir(), ".codex", "auth.json"), join(home, ".codex", "auth.json"));
  await mkdir(join(home, ".claude"), { recursive: true });
  await trust(bridge, []);
  const hook = Bun.spawnSync(["herdr", "integration", "install", "claude"], { env: orgEnv(bridge) });
  if (hook.exitCode !== 0) console.error(`[e2e] herdr integration install claude: ${hook.stderr.toString().trim()}`);
}

/** ~/.claude.json with onboarding done and `dirs` trusted, so Claude opens on its prompt. */
async function trust(bridge: TestBridge, dirs: string[]): Promise<void> {
  const own = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8")) as Record<string, unknown>;
  await writeFile(join(bridge.home, ".claude.json"), JSON.stringify({
    hasCompletedOnboarding: true,
    lastOnboardingVersion: own.lastOnboardingVersion,
    oauthAccount: own.oauthAccount,
    projects: Object.fromEntries(dirs.map((dir) => [dir, { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true }])),
  }));
}

/** The environment the bridge runs Organizations with, for the commands this bench runs itself. */
function orgEnv(bridge: TestBridge): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(COLLIE|HERDR)_/.test(k)) env[k] = v;
  return Object.assign(env, {
    HOME: bridge.home,
    XDG_CONFIG_HOME: join(bridge.home, ".config"),
    HERDR_PROJECTS_ROOT: join(bridge.dir, "projects"),
    HERDR_SOCKET_PATH: bridge.socketPath,
  });
}

function org(bridge: TestBridge, argv: string[]): string {
  const run = Bun.spawnSync([orgBin!, ...argv], { env: orgEnv(bridge), cwd: bridge.home });
  if (run.exitCode !== 0) throw new Error(`herdr-organizations ${argv.join(" ")}: ${run.stderr.toString().trim()}`);
  return run.stdout.toString();
}

/** In the page: every change of what it shows, from the moment `window.__t0` is set by the tap. */
function record(): void {
  const w = window as unknown as { __marks: Array<{ state: string; at: number }>; __t0: number };
  w.__marks = [];
  w.__t0 = 0;
  let last = "";
  const state = () => {
    const text = document.querySelector("main")?.textContent ?? "";
    const parts = [location.pathname.startsWith("/pane/") ? "chat" : "project"];
    if (/Starting/.test(text)) parts.push("starting");
    if (/Coordinator\s*shell/.test(text)) parts.push("shell-row");
    if (document.querySelector('[role="alert"]')) parts.push("error");
    if (document.querySelector('[role="dialog"]')) parts.push("window");
    return parts.join("+");
  };
  const tick = () => {
    const now = state();
    if (now !== last && w.__t0) {
      w.__marks.push({ state: now, at: Math.round(performance.now() - w.__t0) });
    }
    last = now;
  };
  setInterval(tick, 10);
  // What each snapshot said about the project's coordinator, and whether its pane was an agent.
  const w2 = window as unknown as { __snaps: string[] };
  w2.__snaps = [];
  const fetch0 = window.fetch.bind(window);
  window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await fetch0(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (w.__t0 && url.includes("/api/snapshot") && res.ok) {
      const at = Math.round(performance.now() - w.__t0);
      void res.clone().json().then((snap: { projects?: Array<{ slug: string; coordinator?: { paneId: string; agent: string } }>; agents?: Array<{ paneId: string }> }) => {
        const slug = location.pathname.split("/")[2];
        const coordinator = snap.projects?.find((project) => project.slug === slug)?.coordinator;
        const agent = coordinator && snap.agents?.some((pane) => pane.paneId === coordinator.paneId);
        w2.__snaps.push(`${at}: ${coordinator ? `${coordinator.paneId} ${coordinator.agent}${agent ? " (agent)" : ""}` : "none"}`);
      }, () => undefined);
    }
    return res;
  }, { preconnect: window.fetch.preconnect });
}

/**
 * Outside the page, every 50 ms: when Organizations recorded the coordinator's pane, when Herdr
 * listed that pane, and when Herdr saw an agent in it. Epoch ms; 0 until it happened.
 */
function watchOpen(bridge: TestBridge, slug: string) {
  const herdr = new HerdrClient(bridge.socketPath, 1000);
  const record = join(bridge.dir, "projects", slug, ".state", "coordinator.json");
  const seen = { recorded: 0, pane: 0, agent: 0 };
  let paneId = "";
  let stop = false;
  const loop = (async () => {
    while (!stop && !seen.agent) {
      if (!paneId && existsSync(record)) {
        paneId = String((JSON.parse(readFileSync(record, "utf8")) as { pane_id?: string }).pane_id ?? "");
        if (paneId) seen.recorded = Date.now();
      }
      if (paneId) {
        const panes = await herdr.sessionSnapshot().then((snap) => snap.panes, () => []);
        const pane = panes.find((candidate) => candidate.pane_id === paneId);
        if (pane && !seen.pane) seen.pane = Date.now();
        if (pane?.agent) seen.agent = Date.now();
      }
      await Bun.sleep(50);
    }
  })();
  return { seen, done: async () => { stop = true; await loop; } };
}

async function run(bridge: TestBridge, device: typeof PHONE | typeof DESKTOP, slug: string, shotPrefix: string | null) {
  const browser = await launchWebkit();
  const context = await browser.newContext({ ...device, colorScheme: values.light ? "light" : "dark", timezoneId: "UTC", locale: "en-US" });
  const page: Page = await context.newPage();
  await page.addInitScript(record, undefined);
  let openStart = 0;
  let openEnd = 0;
  let openStatus = "";
  page.on("request", (req) => { if (req.url().includes("/api/org/project/open")) openStart = Date.now(); });
  (page as unknown as { on(e: "response", fn: (r: { url(): string; status(): number }) => void): void }).on("response", (res) => {
    if (res.url().includes("/api/org/project/open")) { openEnd = Date.now(); openStatus = String(res.status()); }
  });
  await page.goto(`${bridge.url}/project/${slug}`);
  await page.getByRole("button", { name: "Start coordinator" }).first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(800);
  if (shotPrefix) await page.screenshot({ path: join(outDir, `${shotPrefix}-0-project.png`), animations: "disabled" });

  // A window that asks for the harness first is answered with its preselection; the clock starts
  // at the tap that runs `open`.
  const watch = watchOpen(bridge, slug);
  const startClock = () => page.evaluate(() => { (window as unknown as { __t0: number }).__t0 = performance.now(); }, undefined);
  await startClock();
  let tapped = Date.now();
  await page.getByRole("button", { name: "Start coordinator" }).first().click();
  const dialog = page.getByRole("dialog");
  const asked = await dialog.waitFor({ timeout: 1000 }).then(() => true, () => false);
  if (asked) {
    if (shotPrefix) await page.screenshot({ path: join(outDir, `${shotPrefix}-1-window.png`), animations: "disabled" });
    await page.evaluate(() => { (window as unknown as { __marks: unknown[] }).__marks = []; }, undefined);
    await startClock();
    tapped = Date.now();
    await dialog.getByRole("button", { name: /^Start/ }).last().click();
  }
  if (shotPrefix) {
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(outDir, `${shotPrefix}-2-tapped.png`), animations: "disabled" });
  }
  // The "stuck" frame, if there is one: the project page again, without its "Starting" feedback.
  const stuck = await page.waitForFunction(() => !location.pathname.startsWith("/pane/") && !/Starting/.test(document.querySelector("main")?.textContent ?? ""), undefined, { timeout: 15_000 }).then(() => true, () => false);
  if (stuck && shotPrefix && !page.url().includes("/pane/")) await page.screenshot({ path: join(outDir, `${shotPrefix}-3-no-feedback.png`), animations: "disabled" });
  await page.waitForFunction(() => location.pathname.startsWith("/pane/"), undefined, { timeout: 90_000 }).catch(() => undefined);
  const arrived = page.url().includes("/pane/");
  if (shotPrefix) {
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(outDir, `${shotPrefix}-4-chat.png`), animations: "disabled" });
  }
  await page.waitForTimeout(500);
  const marks = await page.evaluate(() => (window as unknown as { __marks: Mark[] }).__marks, undefined);
  const snaps = await page.evaluate(() => (window as unknown as { __snaps: string[] }).__snaps, undefined);
  // The page's own reads after the tap: which snapshot or pane read brought the coordinator.
  const reads = await page.evaluate(() => {
    const t0 = (window as unknown as { __t0: number }).__t0;
    return (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
      .filter((entry) => entry.startTime >= t0 && /\/api\/(snapshot|pane|org)/.test(entry.name))
      .map((entry) => `${new URL(entry.name).pathname.replace(/^\/api\//, "").slice(0, 24)} ${Math.round(entry.startTime - t0)}-${Math.round(entry.responseEnd - t0)}`);
  }, undefined);
  for (let i = 0; i < 300 && !openEnd; i++) await page.waitForTimeout(100);
  await context.close();
  await browser.close();
  await watch.done();
  const since = (at: number) => at ? at - tapped : null;
  return {
    slug, asked, arrived, marks, snaps, reads,
    recordedMs: since(watch.seen.recorded), paneListedMs: since(watch.seen.pane), agentSeenMs: since(watch.seen.agent),
    openRequestMs: openStart && openEnd ? openEnd - openStart : null,
    openStartAfterTapMs: openStart ? openStart - tapped : null,
    openStatus,
  };
}

await mkdir(outDir, { recursive: true });
const bridge = await startTestBridge({ port: Number(values.port), herdr: true, orgBin });
const results: unknown[] = [];
try {
  await signIn(bridge);
  const repo = join(bridge.dir, "repo");
  await mkdir(repo, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", "-b", "main", repo]);
  const runs = Number(values.runs);
  const slugs = Array.from({ length: runs }, (_, i) => `demo-${i + 1}`);
  for (const slug of slugs) org(bridge, ["new", slug, "--goal", "Bench project", "--repo", repo]);
  for (const slug of slugs) org(bridge, ["set", slug, "coordinator_profile", harness]);
  await trust(bridge, slugs.map((slug) => realpathSync(join(bridge.dir, "projects", slug))));
  const t = Date.now();
  org(bridge, ["overview", "--json"]);
  console.log(JSON.stringify({ overviewJsonMs: Date.now() - t }));
  for (const [i, slug] of slugs.entries()) {
    const device = i % 2 === 0 ? DESKTOP : PHONE;
    const name = device === DESKTOP ? "desktop" : "phone";
    const result = await run(bridge, device, slug, i < 2 ? `${values.label}-${name}` : null);
    results.push({ device: name, ...result });
    console.log(JSON.stringify({ device: name, ...result }));
  }
} finally {
  await writeFile(join(outDir, `${values.label}.json`), JSON.stringify({ harness, orgBin, results }, null, 2));
  await bridge.stop();
  // `open` starts Organizations' ticker over the bench's registry; it outlives the bridge.
  Bun.spawnSync(["pkill", "-f", join(bridge.dir, "projects")]);
}
console.log(`[e2e] ${outDir}`);
