import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DESKTOP, launchWebkit, PHONE, userCacheDir, type Page } from "./browser.ts";
import { startTestBridge } from "./bridge.ts";

// Settings → Usage on the bench, against the real bridge and its real scan. The logs are synthetic and
// neutral: Claude Code transcripts in three repos (one with a worktree) over seven weeks, Codex
// rollouts every other day, two Claude Code accounts by Nenu's own switch log (the days before the
// first switch stay Unassigned), one Codex account, and status-line snapshots for the plan limits.
// Every state is captured on a phone (390x844) and a desk (1440x900), dark and light:
//
//   off           the default: Home, a chat, Settings' group and the page, with no /api/usage request
//                 from Home or the chat
//   no-data       on, before any log exists
//   first-pass    the page fed one scanning answer (a real first pass over this little data ends in ms)
//   data          the totals, limits, map (striped before the oldest log), weeks and breakdown
//   split         Split by account: all accounts, the list, then one account picked
//   near-limit    a 5-hour window at 91 %, and the account that has room
//
// Then, on a desk with the page open: the /api/usage requests in 30 idle seconds, the squares the DOM
// redraws while the pointer crosses 60 of them, and the arrow keys walking the map.
//
//   bun scripts/e2e/usage.ts [--port 8867] [--out DIR] [--before | --edges]
//
// --before captures only Home, the chat and Settings, for a build without the group (run it from that
// build's checkout). --edges captures only the edges, each the real answer with Split on, bent one way:
// a failed first pass, a failed later scan, amounts a thousand times larger and smaller, long names,
// one account, no plan limit, a phone fourteen hours ahead of the bridge, and a desk 1024 wide.

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8867" },
    out: { type: "string" },
    before: { type: "boolean", default: false },
    edges: { type: "boolean", default: false },
  },
});
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), `usage-${stamp}`);
await mkdir(outDir, { recursive: true });
const DAY = 86_400_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const report: Record<string, unknown> = { outDir };

// ── Synthetic logs ───────────────────────────────────────────────────────────────────────────────

const ACCOUNT = { work: "a1a1a1a1a1a1a1a1", studio: "b2b2b2b2b2b2b2b2" };
const uuid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const iso = (ms: number) => new Date(ms).toISOString();
/** Midnight UTC, `days` ago. */
const dayStart = (days: number) => Math.floor(Date.now() / DAY) * DAY - days * DAY;

/** A deterministic 0..1 from a seed. */
const noise = (seed: number) => {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

async function writeLogs(dir: string): Promise<void> {
  const config = join(dir, "journals");
  const repos = join(dir, "repos");
  // Three repos and a worktree of the first, so the breakdown counts the worktree with its repo.
  for (const name of ["checkout", "docs-site", "mobile-app"]) await mkdir(join(repos, name, ".git"), { recursive: true });
  await mkdir(join(repos, "checkout", ".git", "worktrees", "ui"), { recursive: true });
  await mkdir(join(repos, "checkout-ui"), { recursive: true });
  await writeFile(join(repos, "checkout-ui", ".git"), `gitdir: ${join(repos, "checkout", ".git", "worktrees", "ui")}\n`);
  const cwds = [join(repos, "checkout"), join(repos, "checkout-ui"), join(repos, "docs-site"), join(repos, "mobile-app")];

  let id = 0;
  for (let ago = 48; ago >= 0; ago--) {
    const start = dayStart(ago);
    const weekday = new Date(start).getUTCDay();
    // Busier on weekdays and over time; a few quiet days.
    const volume = weekday === 0 || weekday === 6 ? 0.3 : 1;
    if (noise(ago) < 0.12) continue;
    for (const [r, cwd] of cwds.entries()) {
      const count = Math.round((6 + 30 * noise(ago * 7 + r)) * volume * (1 + (48 - ago) / 30));
      if (!count) continue;
      const slug = cwd.replaceAll("/", "-");
      const session = uuid(++id);
      const rows: string[] = [];
      for (let i = 0; i < count; i++) {
        const sonnet = noise(id * 31 + i) < 0.2;
        rows.push(JSON.stringify({
          parentUuid: null, isSidechain: false,
          message: {
            model: sonnet ? "claude-sonnet-5-5" : "claude-opus-5-5", id: `msg_${id}_${i}`, type: "message", role: "assistant",
            content: [{ type: "text", text: "Done." }], stop_reason: "end_turn",
            usage: {
              input_tokens: 800 + Math.round(2000 * noise(i)), cache_creation_input_tokens: 24_000, cache_read_input_tokens: 120_000 + Math.round(200_000 * noise(i + 1)),
              output_tokens: 1500 + Math.round(4000 * noise(i + 2)), cache_creation: { ephemeral_5m_input_tokens: 20_000, ephemeral_1h_input_tokens: 4_000 },
            },
          },
          requestId: `req_${id}_${i}`, type: "assistant", uuid: uuid(1_000_000 + id * 1000 + i), timestamp: iso(start + 9 * 3_600_000 + i * 120_000),
          cwd, sessionId: session, version: "2.1.0",
        }));
      }
      await mkdir(join(config, "projects", slug), { recursive: true });
      await writeFile(join(config, "projects", slug, `${session}.jsonl`), rows.join("\n") + "\n");
    }
  }

  // Codex every other day of the last three weeks, its plan limit in each rollout's last count.
  for (let ago = 20; ago >= 0; ago -= 2) {
    const start = dayStart(ago) + 14 * 3_600_000;
    const date = iso(start).slice(0, 10);
    const sub = join(config, "sessions", ...date.split("-"));
    await mkdir(sub, { recursive: true });
    const rid = uuid(500 + ago);
    const cwd = cwds[3]!;
    const lines: object[] = [
      { timestamp: iso(start), type: "session_meta", payload: { id: rid, cwd, creator_account_id: "acct-demo" } },
      { timestamp: iso(start + 1000), type: "turn_context", payload: { cwd, model: "gpt-6.1-sol" } },
    ];
    for (let i = 1; i <= 12; i++) {
      const total = [i * 90_000, i * 70_000, i * 6_000, i * 2_000];
      lines.push({
        timestamp: iso(start + i * 60_000), type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: { input_tokens: total[0], cached_input_tokens: total[1], output_tokens: total[2], reasoning_output_tokens: total[3], total_tokens: 0 }, last_token_usage: null },
          rate_limits: i === 12 ? { primary: { used_percent: 23, window_minutes: 10080, resets_at: Math.round((Date.now() + 3 * DAY) / 1000) }, secondary: null, plan_type: "plus" } : null,
        },
      });
    }
    await writeFile(join(sub, `rollout-${date}T14-00-00-${rid}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }

  // Who was signed in: Work from six weeks ago, Studio from five days ago. Before Work, Unassigned.
  const usage = join(dir, "state", "usage");
  await mkdir(usage, { recursive: true });
  const line = (at: number, account: string, label: string) => JSON.stringify({ v: 1, at: iso(at), harness: "claude", account, label, configDir: config });
  await writeFile(join(usage, "accounts.jsonl"), `${line(dayStart(42), ACCOUNT.work, "Work")}\n${line(dayStart(5), ACCOUNT.studio, "Studio")}\n`);
  await writeLimits(dir, 12);
}

/** Status-line snapshots: Studio's now at `fiveHour` %, Work's from two days ago. */
async function writeLimits(dir: string, fiveHour: number): Promise<void> {
  const status = join(dir, "state", "claude-status");
  await mkdir(status, { recursive: true });
  const now = Date.now();
  const snap = (session: string, account: string, observedAt: number, five: [number, number], week: [number, number]) => writeFile(join(status, `${session}.json`), JSON.stringify({
    observedAt, account: `claude:${account}`,
    payload: { session_id: session, rate_limits: { five_hour: { used_percentage: five[0], resets_at: Math.round(five[1] / 1000) }, seven_day: { used_percentage: week[0], resets_at: Math.round(week[1] / 1000) } } },
  }));
  await snap(uuid(9001), ACCOUNT.studio, now - 20_000, [fiveHour, now + 42 * 60_000], [fiveHour > 50 ? 64 : 21, now + 4 * DAY]);
  await snap(uuid(9002), ACCOUNT.work, now - 2 * DAY, [40, now - DAY], [9, now + 4 * DAY]);
}

// ── Bench ────────────────────────────────────────────────────────────────────────────────────────

const bridge = await startTestBridge({ port: Number(values.port), fake: true });
// One WebKit per state: a single one stopped loading pages after about 62 contexts on this bench.
let browser = await launchWebkit();
const shots: string[] = [];

type Reach = (page: Page, desk: boolean) => Promise<void>;
type Device = { viewport: { width: number; height: number } } & Record<string, unknown>;
const DEVICES: ReadonlyArray<readonly [string, Device]> = [["phone", PHONE], ["desk", DESKTOP]];
async function capture(name: string, path: string, reach: Reach = async () => {}, opts: {
  prepare?: (page: Page) => Promise<void>;
  zone?: string;
  devices?: ReadonlyArray<readonly [string, Device]>;
} = {}) {
  await browser.close();
  browser = await launchWebkit();
  for (const [deviceName, device] of opts.devices ?? DEVICES) {
    for (const scheme of ["dark", "light"] as const) {
      // A fed answer must reach the page: the service worker's own fetch would pass Playwright's route by.
      const context = await browser.newContext({ ...device, colorScheme: scheme, timezoneId: opts.zone ?? "UTC", locale: "en-US", ...(opts.prepare ? { serviceWorkers: "block" } : {}) });
      const page = await context.newPage();
      await opts.prepare?.(page);
      await page.goto(`${bridge.url}${path}`);
      await page.waitForTimeout(1200);
      const failed = await reach(page, device.viewport.width >= 1024).then(() => null, (err: Error) => err.message.split("\n")[0]!);
      await page.waitForTimeout(500);
      if (failed) ((report.failures ??= []) as string[]).push(`${name}-${deviceName}-${scheme}: ${failed}`);
      const file = join(outDir, `${name}-${deviceName}-${scheme}${failed ? "-FAILED" : ""}.png`);
      await page.screenshot({ path: file, animations: "disabled" });
      shots.push(file);
      await context.close();
    }
  }
}

type UsageAnswer = { on: boolean; scan?: { state: string; firstPass: boolean; error?: string } };
const usage = (query = "") => fetch(`${bridge.url}/api/usage${query}`).then((r) => r.json() as Promise<UsageAnswer>);
const set = (patch: object) => fetch(`${bridge.url}/api/usage`, { method: "POST", body: JSON.stringify(patch) }).then((r) => r.json());
/** Until a scan has run and none is running. */
async function settled(query = ""): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const u = await usage(query);
    if (u.scan?.state === "idle" && !u.scan.firstPass) return;
    await sleep(200);
    query = "";
  }
  throw new Error("the usage scan never settled");
}

const toMain = async (page: Page) => { await page.getByRole("main").waitFor({ timeout: 10_000 }); };
/** Settings with its Usage group in view; a build without the group shows Settings as it is. */
const toUsageGroup = async (page: Page) => {
  if (values.before) return toMain(page);
  await page.getByRole("switch", { name: "Track usage" }).waitFor({ timeout: 10_000 });
  await page.getByRole("region", { name: "Usage" }).scrollIntoViewIfNeeded();
};
const usagePage = async (page: Page) => { await page.getByRole("region", { name: /^Activity/ }).waitFor({ timeout: 10_000 }); };

// ── Edges (--edges) ──────────────────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;
type Levels = { cost: number[]; tokens: number[] };
const COUNTS = new Set(["tokens", "input", "output", "cacheWrite", "cacheRead"]);
/** Every cost times `money` and every token count times `count`, the map's levels with them. */
function scale(value: unknown, money: number, count: number): unknown {
  if (Array.isArray(value)) return value.map((v) => scale(v, money, count));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typeof v === "number"
    ? v * (k === "cost" ? money : COUNTS.has(k) ? count : 1)
    : k === "levels" ? { cost: (v as Levels).cost.map((n) => n * money), tokens: (v as Levels).tokens.map((n) => n * count) }
    : scale(v, money, count)]));
}

/** Until a scan has failed and none is running. */
async function failed(query = ""): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const u = await usage(query);
    if (u.scan?.state === "idle" && u.scan.error) return;
    await sleep(200);
    query = "";
  }
  throw new Error("the usage scan never failed");
}

/** The page open on a desk for `ms` after `act`: how many times it read /api/usage. */
async function readsWhileOpen(ms: number, act: (page: Page) => Promise<void> = async () => {}): Promise<number> {
  const context = await browser.newContext({ ...DESKTOP, timezoneId: "UTC", locale: "en-US" });
  const page = await context.newPage();
  let reads = 0;
  page.on("request", (req) => { if (new URL(req.url()).pathname === "/api/usage") reads++; });
  await page.goto(`${bridge.url}/settings/usage`);
  await act(page);
  await page.waitForTimeout(ms);
  await context.close();
  return reads;
}

/** The page, its activity map inside its own card on a desk (a phone scrolls it). */
const mapInside: Reach = async (page, desk) => {
  await usagePage(page);
  if (!desk) return;
  const past = await page.evaluate(() => {
    const card = document.querySelector(".usage-map")!.getBoundingClientRect();
    return Math.round(document.querySelector(".usage-grid")!.getBoundingClientRect().right - card.right);
  }, null);
  if (past > 0) throw new Error(`the map runs ${past}px past its card`);
};

/** A plan-limit row's own words are never the ones cut short. */
const limitRowsWhole: Reach = async (page, desk) => {
  await mapInside(page, desk);
  const cut = await page.getByRole("region", { name: "Plan limits" }).getByRole("button").evaluateAll((buttons) =>
    buttons.map((b) => b.firstElementChild as HTMLElement).filter((s) => s.scrollWidth > s.clientWidth).map((s) => s.textContent));
  if (cut.length) throw new Error(`cut short: ${cut.join(", ")}`);
};

/** Nothing in a card runs past the card, nor anything past the page; the map's scroller is a phone's to scroll. */
const contained: Reach = async (page, desk) => {
  await mapInside(page, desk);
  const out = await page.evaluate(() => {
    const main = document.querySelector("main")!;
    const past = new Set<string>();
    for (const el of Array.from(main.querySelectorAll<HTMLElement>("*"))) {
      const r = el.getBoundingClientRect();
      if (!r.width || el.closest(".usage-scroll")) continue;
      const box = (el.parentElement?.closest(".rounded-xl") ?? main).getBoundingClientRect();
      if (r.right > box.right + 1) past.add(el.textContent?.trim().slice(0, 40) || el.tagName);
    }
    return [...past].slice(0, 4);
  }, null);
  if (out.length) throw new Error(`runs past its box: ${out.join(" | ")}`);
};

async function edges(): Promise<void> {
  // A scan that cannot save: the first pass, then a later one, with the usage folder read-only.
  const store = join(bridge.dir, "state", "usage");
  await mkdir(store, { recursive: true });
  await chmod(store, 0o500);
  await set({ on: true });
  await failed();
  await capture("edge-first-pass-failed", "/settings/usage", async (page) => { await page.getByRole("heading", { name: "Couldn’t read the logs" }).waitFor({ timeout: 10_000 }); });
  report.firstPassFailed = { readsIn15sOpen: await readsWhileOpen(15_000) };
  await chmod(store, 0o700);
  await writeLogs(bridge.dir);
  await settled("?fresh=1");
  await set({ splitByAccount: true });
  await sleep(500);
  await settled();
  const base = (await usage()) as unknown as Json & { scan: Json; accounts: Json[]; limits: Json[]; periods: Json[] };

  await chmod(store, 0o500);
  await usage("?fresh=1");
  await failed();
  await capture("edge-scan-failed", "/settings/usage", async (page, desk) => {
    await mapInside(page, desk);
    await page.getByText("Couldn’t update").waitFor({ timeout: 10_000 });
  });
  report.scanFailed = { readsIn15sAfterRecalculate: await readsWhileOpen(15_000, async (page) => {
    await usagePage(page);
    await page.getByRole("button", { name: "Recalculate" }).click();
  }) };
  await chmod(store, 0o700);
  await settled("?fresh=1");

  const long = "a-repository-whose-name-runs-far-past-the-row-it-sits-in";
  const active = base.accounts.find((a) => a.active && a.agent === "claude")!;
  const bent: Array<[string, Json, Reach]> = [
    ["edge-big", scale(base, 1000, 1000) as Json, mapInside],
    ["edge-small", scale(base, 0.001, 0.001) as Json, mapInside],
    ["edge-long-names", {
      ...base,
      accounts: base.accounts.map((a) => ({ ...a, label: a.id === active.id ? "anaccountlabelwithnospacesatallanywhere" : a.agent === "claude" && a.source !== "none" ? "Platform engineering shared seat" : a.label })),
      periods: base.periods.map((p) => ({ ...p, byProject: (p.byProject as Json[]).map((r, i) => (i === 0 ? { ...r, label: long } : r)) })),
    }, async (page, desk) => { await limitRowsWhole(page, desk); await contained(page, desk); }],
    ["edge-one-account", { ...base, accounts: [active], limits: base.limits.filter((l) => l.account === active.id) }, limitRowsWhole],
    ["edge-no-limits", { ...base, limits: [] }, limitRowsWhole],
  ];
  for (const [name, answer, reach] of bent) {
    await capture(name, "/settings/usage", reach, { prepare: (page) => page.route("**/api/usage*", (route) => route.fulfill({ json: answer })) });
  }
  const [, longNames] = bent[2]!;
  await capture("edge-long-list", "/settings/usage", async (page, desk) => {
    await mapInside(page, desk);
    await page.getByRole("button", { name: "All accounts" }).click();
    await page.getByRole("option", { name: /^anaccountlabel/ }).click();
    await page.getByRole("button", { name: /^anaccountlabel/ }).waitFor({ timeout: 5000 });
    if (!desk) await page.getByRole("button", { name: /^anaccountlabel/ }).click();
    await contained(page, desk);
  }, { prepare: (page) => page.route("**/api/usage*", (route) => route.fulfill({ json: longNames })) });
  await capture("edge-long-projects", "/settings/usage", async (page, desk) => {
    await mapInside(page, desk);
    await page.getByRole("radio", { name: "Project" }).click();
    await page.getByRole("region", { name: / by$/ }).scrollIntoViewIfNeeded();
  }, { prepare: (page) => page.route("**/api/usage*", (route) => route.fulfill({ json: longNames })) });
  await capture("edge-big-settings", "/settings", toUsageGroup, { prepare: (page) => page.route("**/api/usage*", (route) => route.fulfill({ json: bent[0]![1] })) });
  await capture("edge-zone", "/settings/usage", mapInside, { zone: "Pacific/Kiritimati" });
  await capture("edge-desk", "/settings/usage", mapInside, { devices: [["1024", { ...DESKTOP, viewport: { width: 1024, height: 768 } }], ["1280", { ...DESKTOP, viewport: { width: 1280, height: 800 } }]] });
  await capture("edge-desk-accounts", "/settings/usage", async (page, desk) => {
    await usagePage(page);
    await page.getByRole("button", { name: "All accounts" }).click();
    await page.getByRole("listbox", { name: "Account" }).waitFor({ timeout: 5000 });
    await mapInside(page, desk);
  }, { devices: [["1024", { ...DESKTOP, viewport: { width: 1024, height: 768 } }], ["1280", { ...DESKTOP, viewport: { width: 1280, height: 800 } }]] });
}

try {
  if (values.edges) {
    await edges();
    throw new Error("done");
  }
  // Off, by default. Home and a chat never ask for usage; Settings does, once.
  const asked: string[] = [];
  {
    const context = await browser.newContext({ ...PHONE, timezoneId: "UTC", locale: "en-US" });
    const page = await context.newPage();
    page.on("request", (req) => { if (new URL(req.url()).pathname === "/api/usage") asked.push(`${new URL(page.url()).pathname} ${req.method()}`); });
    await page.goto(`${bridge.url}/`);
    await toMain(page);
    await page.waitForTimeout(3000);
    await page.goto(`${bridge.url}/pane/${encodeURIComponent(bridge.herd!.idle)}`);
    await page.waitForTimeout(3000);
    const beforeSettings = asked.length;
    await page.goto(`${bridge.url}/settings`);
    await toUsageGroup(page);
    await page.waitForTimeout(1500);
    report.offRequests = { homeAndChat: beforeSettings, settings: asked.length - beforeSettings, all: [...asked] };
    await context.close();
  }
  // Outside Settings nothing changes: Home and an idle chat, to compare with a build without usage.
  await capture("home", "/", toMain);
  await capture("chat", `/pane/${encodeURIComponent(bridge.herd!.idle)}`, (page) => page.waitForTimeout(1500));
  await capture("settings-off", "/settings", toUsageGroup);
  if (values.before) throw new Error("done");
  await capture("usage-off", "/settings/usage", async (page) => { await page.getByRole("heading", { name: "Usage is off" }).waitFor({ timeout: 10_000 }); });

  // On, before any log exists.
  await set({ on: true });
  await settled();
  await capture("usage-no-data", "/settings/usage", async (page) => { await page.getByRole("heading", { name: "No usage yet" }).waitFor({ timeout: 10_000 }); });

  // The first pass, from one scanning answer.
  const scanning = { ...(await usage()), scan: { state: "scanning", firstPass: true, files: 1214, totalFiles: 2048, bytes: 4.6e9, totalBytes: 7.9e9 }, days: [], periods: [] };
  await capture("usage-first-pass", "/settings/usage", async (page) => { await page.getByText("Reading logs for the first time").waitFor({ timeout: 10_000 }); }, {
    prepare: (page) => page.route("**/api/usage*", (route) => route.fulfill({ json: scanning })),
  });

  // The logs arrive; a refresh reads them.
  await writeLogs(bridge.dir);
  await settled("?fresh=1");
  report.dataAnswer = await fetch(`${bridge.url}/api/usage`).then(async (r) => ({ bytes: (await r.text()).length }));
  await capture("settings-on", "/settings", toUsageGroup);
  await capture("usage-data", "/settings/usage", usagePage);
  for (const region of ["By week", "October by"]) {
    await capture(`usage-data-${region === "By week" ? "weeks" : "breakdown"}`, "/settings/usage", async (page) => {
      await usagePage(page);
      await page.getByRole("region", { name: region }).scrollIntoViewIfNeeded();
      if (region !== "By week") await page.getByRole("radio", { name: "Project" }).click();
    });
  }
  await capture("usage-map", "/settings/usage", async (page, desk) => {
    await usagePage(page);
    const square = page.getByRole("option").last();
    if (desk) await square.hover();
    else await page.getByRole("region", { name: /^Activity/ }).scrollIntoViewIfNeeded();
  });

  // Split by account: the bridge rescans to attribute the logs.
  await set({ splitByAccount: true });
  await sleep(500);
  await settled();
  await capture("settings-split", "/settings", toUsageGroup);
  await capture("usage-split", "/settings/usage", usagePage);
  await capture("usage-accounts", "/settings/usage", async (page) => {
    await usagePage(page);
    await page.getByRole("button", { name: "All accounts" }).click();
    await page.getByRole("listbox", { name: "Account" }).waitFor({ timeout: 5000 });
  });
  await capture("usage-account-work", "/settings/usage", async (page) => {
    await usagePage(page);
    await page.getByRole("button", { name: "All accounts" }).click();
    await page.getByRole("option", { name: /^Work/ }).click();
    await page.getByRole("button", { name: "Work" }).waitFor({ timeout: 5000 });
    await page.waitForTimeout(800);
  });

  // Near a limit: Studio's 5-hour window at 91 %.
  await writeLimits(bridge.dir, 91);
  await settled("?fresh=1");
  await capture("usage-near-limit", "/settings/usage", async (page) => {
    await usagePage(page);
    await page.getByRole("alert").scrollIntoViewIfNeeded();
  });

  // A desk with the page open: what it asks for while idle, and what the pointer and keys do to the map.
  {
    const context = await browser.newContext({ ...DESKTOP, colorScheme: "dark", timezoneId: "UTC", locale: "en-US" });
    const page = await context.newPage();
    const reads: number[] = [];
    page.on("request", (req) => { if (new URL(req.url()).pathname === "/api/usage") reads.push(Date.now()); });
    await page.goto(`${bridge.url}/settings/usage`);
    await usagePage(page);
    await page.waitForTimeout(2000);
    const opened = reads.length;
    await page.waitForTimeout(30_000);
    const idle = reads.length - opened;
    await page.evaluate(() => {
      const grid = document.querySelector('[role="listbox"][aria-label^="Activity"]')!;
      const seen = { squares: 0, ring: 0 };
      (window as unknown as { __seen: typeof seen }).__seen = seen;
      new MutationObserver((records) => {
        for (const r of records) {
          const el = r.target as HTMLElement;
          if (el.classList?.contains("usage-ring")) seen.ring++;
          else if (el.dataset?.i !== undefined || r.type === "childList") seen.squares++;
        }
      }).observe(grid, { attributes: true, childList: true, subtree: true });
    }, null);
    const box = await page.evaluate(() => {
      const r = document.querySelector('[role="listbox"][aria-label^="Activity"]')!.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }, null);
    for (let i = 0; i < 60; i++) await page.mouse.move(box.x + box.w - 4 - (i % 30) * 11, box.y + 4 + Math.floor(i / 30) * 22);
    await page.waitForTimeout(300);
    const mutations = await page.evaluate(() => (window as unknown as { __seen: unknown }).__seen, null);
    // The keys a screen reader user walks the map with, and the day each one lands on, as it is read out.
    const keys: Record<string, unknown> = {};
    for (const key of ["ArrowLeft", "ArrowUp", "ArrowDown", "End", "Home"]) {
      await page.getByRole("listbox", { name: /^Activity/ }).press(key);
      keys[key] = await page.evaluate(() => {
        const grid = document.activeElement!;
        return `${grid.getAttribute("role")} → ${document.getElementById(grid.getAttribute("aria-activedescendant") ?? "")?.getAttribute("aria-label")}`;
      }, null);
    }
    await page.getByRole("listbox", { name: /^Activity/ }).press("End");
    report.idleDesk = { readsOnOpen: opened, readsIn30sIdle: idle, pointerOver60Squares: mutations, keys };
    await page.screenshot({ path: join(outDir, "usage-keyboard-desk-dark.png"), animations: "disabled" });
    await context.close();
  }
} catch (err) {
  if ((err as Error).message !== "done") {
    report.error = (err as Error).message;
    process.exitCode = 1;
  }
} finally {
  report.shots = shots.length;
  report.herdrWrites = bridge.fake?.writes() ?? [];
  await browser.close();
  await bridge.stop();
  await writeFile(join(outDir, "usage.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
