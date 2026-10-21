import { writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DESKTOP, launchChrome, PHONE, userCacheDir, type Browser, type Page } from "./browser.ts";
import { startTestBridge, type TestBridge } from "./bridge.ts";
import { deskOrg, seedDiffRepo, writeChatJournal, type DemoHerd, type OrgSeed } from "./scenario.ts";

// Every screen, as one app: Home's tabs, a project's tabs and its History, a coordinator's page, a chat
// with each tab of its panel, the phone's drawer and sheets, Settings, in dark and light at 1440x900 and
// 390x844, captured with Google Chrome headless. Beside the captures, `styles.json` holds what each
// screen draws: every control's height and radius, every text's size and weight, every status colour,
// icon size and stroke and transition, counted, so a pass over the design compares numbers, not looks.
//
//   bun scripts/e2e/tour.ts [--port 8875] [--out DIR] [--only desk|phone] [--scheme dark|light]

const { values } = parseArgs({ options: {
  port: { type: "string", default: "8875" }, out: { type: "string" }, only: { type: "string" }, scheme: { type: "string" },
} });
const port = Number(values.port);
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), `tour-${Date.now()}`);
const CAPTURE_EPOCH = Date.parse("2026-10-10T14:00:00Z");

const STATUS = `# Status
Objective: the new checkout, in parts
## Asked
- [working] Checkout flow : thread working (t-0012)
- [needs-decision] Coupons in the cart or at payment : two options with captures, I recommend the cart
- [done] Cart badge : merged (t-0013)
## Decisions
- 2026-10-09 The checkout ships in parts, one PR per part`;

const MEMORY = `# Memory

- [Releases](memory/releases.md): how a release is cut and tagged
- See [the architecture](ARCHITECTURE.md) before touching the bridge.`;

function seed(herd: DemoHerd, now: number, size: { additions: number; deletions: number }): OrgSeed {
  const org = deskOrg(herd, now, size);
  const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
  const acme = org.projects[0]! as OrgSeed["projects"][number] & { detail?: Record<string, unknown> };
  acme.status_file = { path: "/srv/projects/acme-shop/STATUS.md", text: STATUS, updated: ago(0.3) };
  acme.detail = {
    instructions: "# Instructions\n\n- Every change is a thread with its own worktree.\n- Read [DEPLOYMENT.md](DEPLOYMENT.md) before a release.\n- Screenshots before and after for anything visual.\n\nA second paragraph, long enough to wrap across the panel so the line height shows: what each thread receives, where it works and who reviews it before it merges.",
    memory: MEMORY,
    memory_files: [{ name: "releases.md", text: "# Releases\n\nA tag `vX.Y.Z` on main cuts the release." }],
    repos: [{ path: "/home/dev/src/acme-shop", machine: "" }, { path: "/home/dev/src/acme-admin", machine: "build-box" }],
    coordinator_profile: "claude", thread_profile: "claude", max_parallel_threads: 4,
  };
  org.answers = true;
  org.asks = [
    { project: "acme-shop", coordinator: { id: "t-0010", title: "Checkout redesign" }, line: 4, state: "needs-decision", text: "Coupons in the cart or at payment",
      answer: "two options with captures, I recommend the cart", links: [], actions: ["answer"], confirmed: "", mismatch: "" },
    { project: "acme-shop", coordinator: { id: "t-0010", title: "Checkout redesign" }, line: 3, state: "working", text: "Checkout flow", answer: "thread working (t-0012)",
      links: [], actions: ["answer"], confirmed: "", mismatch: "" },
  ];
  return org;
}

/** What a screen draws, counted by value: controls, text, status colours, icons, motion. */
async function styles(page: Page) {
  return page.evaluate(() => {
    const count = (map: Record<string, number>, key: string) => { map[key] = (map[key] ?? 0) + 1; };
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    };
    const out = {
      controlHeight: {} as Record<string, number>, controlRadius: {} as Record<string, number>, controlPadX: {} as Record<string, number>,
      textSize: {} as Record<string, number>, textWeight: {} as Record<string, number>, lineHeight: {} as Record<string, number>,
      dotColor: {} as Record<string, number>, chip: {} as Record<string, number>,
      iconSize: {} as Record<string, number>, iconStroke: {} as Record<string, number>,
      transition: {} as Record<string, number>, radius: {} as Record<string, number>,
      controls: [] as string[],
    };
    for (const el of Array.from(document.querySelectorAll("button, a[href], [role=tab], [role=button], select, input:not([type=hidden]), textarea"))) {
      if (!visible(el)) continue;
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const kind = el.tagName.toLowerCase() + (el.getAttribute("role") ? `[${el.getAttribute("role")}]` : "");
      // Only boxes that look like controls: a fill, a border or a radius; plain text links are rows.
      const boxed = s.backgroundColor !== "rgba(0, 0, 0, 0)" || s.borderTopWidth !== "0px" || s.borderTopLeftRadius !== "0px";
      if (boxed && r.height < 60) {
        count(out.controlHeight, `${kind} ${Math.round(r.height)}`);
        count(out.controlRadius, `${kind} ${s.borderTopLeftRadius}`);
        count(out.controlPadX, `${kind} ${s.paddingLeft}`);
        const label = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 24);
        out.controls.push(`${Math.round(r.height)}h r${s.borderTopLeftRadius} px${s.paddingLeft} ${s.fontSize}/${s.fontWeight} .${el.className.toString().split(" ")[0]} "${label}"`);
      }
      if (s.transitionDuration !== "0s") count(out.transition, `${s.transitionDuration} ${s.transitionTimingFunction}`);
    }
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      if (!visible(el)) continue;
      const s = getComputedStyle(el);
      const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent!.trim());
      if (own) {
        count(out.textSize, s.fontSize);
        count(out.textWeight, s.fontWeight);
        count(out.lineHeight, `${s.fontSize}/${s.lineHeight}`);
      }
      const r = el.getBoundingClientRect();
      if (!own && r.width <= 10 && r.width >= 4 && Math.abs(r.width - r.height) < 1 && s.borderTopLeftRadius !== "0px" && s.backgroundColor !== "rgba(0, 0, 0, 0)") {
        count(out.dotColor, `${Math.round(r.width)}px ${s.backgroundColor}`);
      }
      if (own && /chip|badge|pill/.test(el.className.toString())) count(out.chip, `${Math.round(r.height)}px r${s.borderTopLeftRadius} ${s.fontSize}`);
      if (el.tagName.toLowerCase() === "svg" && r.width > 0) {
        count(out.iconSize, `${Math.round(r.width)}`);
        const path = el.querySelector("path, line, polyline, circle, rect");
        const stroke = path ? getComputedStyle(path).strokeWidth : s.strokeWidth;
        count(out.iconStroke, `${el.getAttribute("stroke") ?? (path && getComputedStyle(path).stroke !== "none" ? "stroke" : "fill")} ${stroke}`);
      }
      if (s.borderTopLeftRadius !== "0px" && s.borderTopLeftRadius !== "9999px" && r.height >= 40) count(out.radius, s.borderTopLeftRadius);
      if (s.transitionDuration !== "0s" && s.transitionProperty !== "all") count(out.transition, `${s.transitionDuration} ${s.transitionTimingFunction}`);
    }
    return out;
  }, null);
}

async function tour(bridge: TestBridge, browser: Browser, device: "desk" | "phone", scheme: "dark" | "light", report: Record<string, unknown>, failures: string[]) {
  const herd = bridge.herd!;
  const context = await browser.newContext({ ...(device === "desk" ? DESKTOP : PHONE), colorScheme: scheme, timezoneId: "UTC", locale: "en-US" });
  const page = await context.newPage();
  await page.clock.install({ time: bridge.now() });
  const shot = async (name: string) => {
    const key = `${device}-${scheme}-${name}`;
    await page.waitForTimeout(900);
    await page.screenshot({ path: join(outDir, `${key}.png`), animations: "disabled" });
    report[key] = await styles(page);
  };
  const visit = async (path: string, ready: string) => {
    await page.goto(bridge.url + path);
    await page.locator(`${ready} >> visible=true`).first().waitFor({ timeout: 30_000 });
  };
  const run = async (name: string, act: () => Promise<unknown>) => {
    try { await act(); await shot(name); } catch (error) {
      failures.push(`${device}-${scheme}-${name}: ${String(error).split("\n")[0]}`);
      await page.screenshot({ path: join(outDir, `FAIL-${device}-${scheme}-${name}.png`) }).catch(() => {});
    }
  };
  const tab = (name: string | RegExp) => page.getByRole("tab", { name }).first().click({ timeout: 5000 });
  const escape = () => page.keyboard.press("Escape");

  await run("home-projects", () => visit("/", "main"));
  for (const name of ["Recents", "Workspaces", "PRs"]) await run(`home-${name.toLowerCase()}`, () => tab(name));
  if (device === "phone") {
    await run("drawer", async () => { await visit("/", "main"); await page.getByRole("button", { name: "Open navigation" }).first().click(); });
    await escape();
  }
  await run("project-work", () => visit("/project/acme-shop", "main"));
  if (device === "desk") {
    await run("project-waiting", () => tab(/^Waiting on you/));
    await run("project-routines", () => tab(/^Routines/));
    await run("project-context", async () => {
      await tab("Context");
      await page.getByRole("button", { name: /MEMORY\.md/ }).click({ timeout: 8000 });
      await page.getByRole("button", { name: /PROJECT\.md/ }).click({ timeout: 8000 });
    });
    await run("project-history", () => visit("/project/acme-shop?work=finished", "main"));
  }
  await run("coordinator", () => visit("/project/acme-shop/node/t-0010", "main"));
  if (device === "desk") {
    await run("coordinator-waiting", () => tab(/^Waiting on you/));
    await run("coordinator-status", () => tab("Status"));
  }
  const chat = `/pane/${encodeURIComponent(herd.working)}`;
  await run("chat", async () => { await visit(chat, "main"); await page.locator("textarea >> visible=true").first().waitFor({ timeout: 30_000 }); });
  if (device === "desk") {
    const panel = page.getByRole("complementary", { name: "Session panel" });
    await run("panel-changes", async () => {
      await panel.getByRole("tab", { name: /Changes/ }).click({ timeout: 5000 });
      await panel.getByRole("button", { name: /app\/checkout\.tsx/ }).click({ timeout: 8000 });
    });
    await run("panel-files", () => panel.getByRole("tab", { name: /Files/ }).click({ timeout: 5000 }));
    await run("panel-artifacts", () => panel.getByRole("radio", { name: "Artifacts" }).click({ timeout: 5000 }));
    await run("panel-terminal", () => panel.getByRole("tab", { name: /Terminal/ }).click({ timeout: 5000 }));
    await run("panel-overview", () => panel.getByRole("tab", { name: /^Overview/ }).click({ timeout: 5000 }));
    await run("palette", () => page.keyboard.press("ControlOrMeta+k"));
    await escape();
  }
  await run("chat-more", async () => { await page.getByRole("button", { name: "Conversation actions" }).first().click({ timeout: 8000 }); });
  await escape();
  if (device === "phone") {
    await run("chat-plus", async () => { await visit("/settings", "main"); await visit(chat, "main"); await page.locator("textarea >> visible=true").first().waitFor({ timeout: 30_000 }); await page.getByRole("button", { name: "Message tools" }).first().click({ timeout: 8000 }); });
    await escape();
  }
  await run("settings", () => visit("/settings", "main"));
  await context.close();
}

await mkdir(outDir, { recursive: true });
const prs = join(outDir, "gh-prs.json");
process.env.NENU_E2E_GH_PRS = prs;
let size = { additions: 0, deletions: 0 };
const bridge = await startTestBridge({
  port, fake: true, epoch: CAPTURE_EPOCH,
  org: (herd, now) => seed(herd, now, size),
  repo: (dir) => {
    size = seedDiffRepo(dir);
    writeFileSync(join(dir, ".git/info/exclude"), "/*\n!/app/\n!/docs/\n");
    writeFileSync(prs, JSON.stringify([
      { number: 42, title: "Checkout flow", url: "https://github.com/acme/shop/pull/42", headRefName: "e2e-demo", baseRefName: "main",
        isDraft: false, reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: [], ...size, updatedAt: new Date(CAPTURE_EPOCH).toISOString() },
    ]));
  },
});
const report: Record<string, unknown> = {};
const failures: string[] = [];
let browser: Browser | null = null;
try {
  await writeChatJournal(bridge.herd!.journals.get(bridge.herd!.working)!, bridge.now(), 2, "running");
  browser = await launchChrome();
  for (const device of ["desk", "phone"] as const) {
    if (values.only && values.only !== device) continue;
    for (const scheme of ["dark", "light"] as const) {
      if (values.scheme && values.scheme !== scheme) continue;
      await tour(bridge, browser, device, scheme, report, failures);
    }
  }
} finally {
  await browser?.close();
  await bridge.stop();
}
await writeFile(join(outDir, "styles.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ out: outDir, captures: Object.keys(report).length, failures }, null, 2));
