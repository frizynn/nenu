import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DESKTOP, launchChrome, PHONE, userCacheDir, type Browser, type Page } from "./browser.ts";
import { startTestBridge, type TestBridge } from "./bridge.ts";
import type { DemoHerd, OrgSeed } from "./scenario.ts";

// Whether Home and the bars say "Projects" only to someone who has a project. Four herds, each the
// demo herd: one project (fake Organizations), Organizations with none, no Organizations at all, and
// an Organizations that never answers over no project folder. For each, at 390x844 and 1440x900:
// Home's tabs and the one it opens on, also from a remembered Projects; every set of tabs drawn from
// the first paint on, so a tab that shows and then goes (or comes) counts as a jump; and on a desk the
// bar's Projects row, its Projects section and the folded rail's Projects button. Exits 1 on any failure.
//
//   bun scripts/e2e/no-projects.ts [--port 8871] [--out DIR] [--tag before|after]

const { values } = parseArgs({ options: { port: { type: "string", default: "8871" }, out: { type: "string" }, tag: { type: "string", default: "now" } } });
const port = Number(values.port);
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), `no-projects-${Date.now()}`);
const tag = values.tag;
const EPOCH = Date.parse("2026-10-21T15:00:00Z");

const oneProject = (herd: DemoHerd, now: number): OrgSeed => ({
  profiles: ["claude"],
  projects: [{
    slug: "acme", name: "Acme Shop", goal: "La tienda", status: "active",
    threads: [{
      id: "t-0001", title: "Checkout", parent_id: "root", role: "worker", status: "open", group: "working", group_label: "working", note: "",
      branch: "", workspace_id: herd.working.split(":")[0]!, tab_id: "w1:t1", pane_id: herd.working, cwd: "", updated: new Date(now - 60_000).toISOString(),
      report_unacked: false, auto_fix_ci: false, auto_merge: false, pr: null,
    }],
  }],
});

interface Herd { name: string; projects: boolean; start: (port: number) => Promise<TestBridge> }

async function hanging(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nenu-e2e-hang-"));
  const bin = join(dir, "herdr-organizations");
  await writeFile(bin, "#!/bin/sh\nsleep 60\n");
  await chmod(bin, 0o755);
  return bin;
}

const HERDS: Herd[] = [
  { name: "projects", projects: true, start: (port) => startTestBridge({ port, fake: true, epoch: EPOCH, org: oneProject }) },
  { name: "empty", projects: false, start: (port) => startTestBridge({ port, fake: true, epoch: EPOCH, org: () => ({ profiles: ["claude"], projects: [] }) }) },
  { name: "absent", projects: false, start: (port) => startTestBridge({ port, fake: true, epoch: EPOCH }) },
  { name: "hanging", projects: false, start: async (port) => startTestBridge({ port, fake: true, epoch: EPOCH, orgBin: await hanging() }) },
];

// Every distinct set of Home's tabs, from the first paint on, with the one selected.
function watchTabs(): void {
  const seen: string[] = [];
  (window as unknown as { __tabs: string[] }).__tabs = seen;
  const read = () => {
    const tabs = Array.from(document.querySelectorAll('[role=tablist][aria-label="Your work"] [role=tab]'))
      .map((tab) => `${tab.textContent}${tab.getAttribute("aria-selected") === "true" ? "*" : ""}`).join("|");
    if (tabs && seen[seen.length - 1] !== tabs) seen.push(tabs);
  };
  new MutationObserver(read).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-selected"] });
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const shots: string[] = [];
  const failures: string[] = [];
  const seen: Record<string, unknown> = {};
  let browser: Browser | null = null;
  try {
    browser = await launchChrome();
    for (const herd of HERDS) {
      const bridge = await herd.start(port);
      try {
        for (const [size, device] of [["390", PHONE], ["1440", DESKTOP]] as const) {
          for (const remembered of [false, true]) {
            const context = await browser.newContext({ ...device, timezoneId: "America/Argentina/Buenos_Aires", locale: "en-US" });
            const page: Page = await context.newPage();
            await page.addInitScript(watchTabs, undefined);
            if (remembered) await page.addInitScript(() => localStorage.setItem("nenu:home-list:v2", "projects"), undefined);
            await page.clock.install({ time: bridge.now() });
            await page.goto(bridge.url + "/");
            // Past the first snapshot and a few polls, and past the hanging Organizations' first read.
            await page.waitForTimeout(6000);
            const key = `${herd.name}-${size}${remembered ? "-remembered" : ""}`;
            const drawn = await page.evaluate(() => (window as unknown as { __tabs: string[] }).__tabs, undefined);
            const want = herd.projects ? "Projects*|Recents|Workspaces" : "Recents*|Workspaces";
            if (drawn.length !== 1 || drawn[0] !== want) failures.push(`${key}: Home drew ${JSON.stringify(drawn)}, want only ${want}`);
            const record: Record<string, unknown> = { drawn };
            if (size === "1440") {
              const bar = page.getByRole("navigation", { name: "Projects and chats" });
              record.projectsRow = await bar.locator("a.nav-row").filter({ hasText: /^Projects$/ }).count();
              record.projectsSection = await bar.locator('section[aria-label="Projects"]').count();
              await page.getByRole("button", { name: "Collapse sidebar" }).first().click();
              await page.waitForTimeout(500);
              record.railButton = await page.locator('nav[aria-label="Collapsed sidebar"] a[aria-label="Projects"]').count();
              if (!remembered) await shoot(page, `${herd.name}-1440-rail`);
              await page.getByRole("button", { name: "Expand sidebar" }).first().click();
              await page.waitForTimeout(500);
              const want = herd.projects ? 1 : 0;
              for (const place of ["projectsRow", "projectsSection", "railButton"] as const) {
                if (record[place] !== want) failures.push(`${key}: ${place} ${record[place]}, want ${want}`);
              }
            }
            if (!remembered) await shoot(page, `${herd.name}-${size}`);
            seen[key] = record;
            await context.close();
          }
        }
      } finally {
        await bridge.stop();
      }
    }
  } finally {
    await browser?.close();
  }

  async function shoot(page: Page, name: string) {
    const path = join(outDir, `${tag}-${name}.png`);
    await page.screenshot({ path, animations: "disabled" });
    shots.push(path);
  }

  const result = { tag, shots, seen, failures };
  await writeFile(join(outDir, `${tag}-no-projects.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (failures.length) process.exit(1);
}

if (import.meta.main) await main();
