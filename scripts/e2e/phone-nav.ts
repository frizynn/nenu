import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DESKTOP, launchChrome, PHONE, userCacheDir, type Browser, type Page } from "./browser.ts";
import { startTestBridge } from "./bridge.ts";
import { orgTreeSeed, type DemoHerd, type OrgSeed } from "./scenario.ts";

// How a phone reaches a coordinator, over projects shaped like the operator's on 2026-10-21: one
// whose running project coordinator organizes open coordinators (one nested), one whose running
// coordinator only has workers, and a quiet one. Walks Home, the drawer, the project and each
// coordinator at 390x844, counting taps from Home, and captures every screen, plus Home at 1440.
//
//   bun scripts/e2e/phone-nav.ts [--port 8871] [--out DIR] [--tag before|after]

const { values } = parseArgs({ options: { port: { type: "string", default: "8871" }, out: { type: "string" }, tag: { type: "string", default: "now" } } });
const port = Number(values.port);
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), `phone-nav-${Date.now()}`);
const tag = values.tag;
const EPOCH = Date.parse("2026-10-21T03:30:00Z");

function seed(herd: DemoHerd, now: number): OrgSeed {
  const org = orgTreeSeed(herd, now, { coordinator: true });
  // The working demo pane is Nenu's coordinator here, so Acme's thread on it runs nowhere.
  const acme = org.projects[0]!;
  acme.threads = acme.threads.map((thread) => thread.id === "t-0103" ? { ...thread, workspace_id: "", tab_id: "", pane_id: "" } : thread);
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const node = (id: number, title: string, group: string, minutes: number) => ({
    id: `t-${String(id).padStart(4, "0")}`, title, parent_id: "root", role: "worker", status: group === "resolved" ? "resolved" : "open", group,
    group_label: group, note: "", branch: "", workspace_id: "", tab_id: "", pane_id: "", cwd: "", updated: ago(minutes),
    report_unacked: false, auto_fix_ci: false, auto_merge: false, pr: null,
  });
  return {
    ...org,
    answers: true,
    asks: [{ project: "acme", coordinator: { id: "root", title: "" }, line: 4, state: "needs-decision", text: "Cuotas sin interés : recomiendo 3",
      answer: "", links: [], actions: ["answer"], confirmed: "", mismatch: "" }],
    projects: [
      ...org.projects,
      {
        slug: "nenu", name: "Nenu", goal: "La app para ver y manejar los proyectos desde el celular", status: "active",
        coordinator: { pane_id: herd.working, workspace_id: herd.working.split(":")[0]!, tab_id: "w1:t1" },
        threads: [
          ...Array.from({ length: 9 }, (_, n) => node(n + 1, `Tarea cerrada ${n + 1}`, "resolved", 600 + n * 90)),
          node(11, "Simplificar el coordinador", "working", 3), node(12, "Chip Done", "ready-for-review", 25),
          node(13, "Chat al final", "working", 8), node(14, "Home con Projects", "working", 1),
        ],
      },
      { slug: "herdr-org", name: "Herdr Org", goal: "Organizations", status: "active", threads: Array.from({ length: 6 }, (_, n) => node(n + 1, `Hecha ${n + 1}`, "resolved", 3000 + n * 60)) },
    ],
  };
}

interface Step { at: string; path: string; taps: number }

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const shots: string[] = [];
  const failures: string[] = [];
  const seen: Record<string, unknown> = {};
  const bridge = await startTestBridge({ port, fake: true, epoch: EPOCH, org: (herd, now) => seed(herd, now) });
  let browser: Browser | null = null;
  try {
    browser = await launchChrome();
    const open = async (device: Record<string, unknown>, path = "/", height?: number) => {
      const context = await browser!.newContext({ ...device, ...(height ? { viewport: { width: (device.viewport as { width: number }).width, height } } : {}),
        timezoneId: "America/Argentina/Buenos_Aires", locale: "en-US" });
      const page = await context.newPage();
      await page.clock.install({ time: bridge.now() });
      await page.goto(bridge.url + path);
      await page.waitForTimeout(2500);
      return { page, context };
    };
    const shoot = async (page: Page, name: string) => {
      const path = join(outDir, `${tag}-${name}.png`);
      await page.screenshot({ path, animations: "disabled" });
      shots.push(path);
    };
    const here = (page: Page) => { const url = new URL(page.url()); return url.pathname + url.search; };
    const text = async (page: Page) => (await page.locator("main").first().innerText().catch(() => "")).split("\n").filter(Boolean).slice(0, 60);

    for (const [name, device, height] of [["390", PHONE, undefined], ["390-full", PHONE, 2200], ["1440", DESKTOP, undefined]] as const) {
      const { page, context } = await open(device, "/", height);
      await shoot(page, `home-${name}`);
      if (name === "390") seen.homeText = await text(page);
      await context.close();
    }

    // The drawer, as ☰ opens it.
    {
      const { page, context } = await open(PHONE);
      await page.getByRole("button", { name: "Open navigation" }).first().click().catch(() => failures.push("no ☰ on Home"));
      await page.waitForTimeout(800);
      await shoot(page, "drawer-390");
      seen.drawerText = (await page.locator("[role=dialog]").first().innerText().catch(() => "")).split("\n").filter(Boolean).slice(0, 60);
      await context.close();
    }

    // Each coordinator, reached from Home and from the drawer: where each tap lands, and how many it took.
    // A coordinator is reached on its page (/project/<slug>/node/<id>), or, for a project whose only
    // coordinator is its own, on that coordinator's chat, which the project opens on (ADR 0092).
    const walks: Record<string, Step[]> = {};
    const reached = (path: string, slug: string) => path.startsWith(`/project/${slug}/node/`) || (slug === "nenu" && path.startsWith("/pane/"));
    const targets = [["acme", "Acme Shop", "Project coordinator"], ["acme", "Acme Shop", "Migración de stock"], ["acme", "Acme Shop", "Rediseño mobile"], ["nenu", "Nenu", ""]] as const;
    for (const [slug, project, coordinator] of targets) {
      const name = coordinator || `${project} coordinator`;
      const steps: Step[] = [];
      // From Home: its Projects tab, the project's row, then the coordinator's row.
      {
        const { page, context } = await open(PHONE);
        let taps = 0;
        const tab = page.getByRole("tab", { name: "Projects" });
        if (await tab.count() && (await tab.first().getAttribute("aria-selected")) !== "true") { await tab.first().click(); taps++; await page.waitForTimeout(500); }
        const row = page.locator("[role=tabpanel] a, section[aria-labelledby=home-projects] a").filter({ hasText: project }).first();
        if (await row.count()) { await row.click(); taps++; await page.waitForTimeout(2500); }
        steps.push({ at: "home → project", path: here(page), taps });
        if (coordinator && !reached(here(page), slug)) {
          const entry = page.locator(".task-main", { hasText: coordinator }).first();
          if (await entry.count()) { await entry.click(); taps++; await page.waitForTimeout(2500); }
          steps.push({ at: `home → ${coordinator}`, path: here(page), taps });
        }
        if (!reached(here(page), slug) || taps > 2) failures.push(`home: ${name} took ${taps} taps and landed on ${here(page)}`);
        await shoot(page, `reach-${slug}-${(coordinator || "own").split(" ")[0]!.toLowerCase()}-home-390`);
        await context.close();
      }
      // From the drawer: ☰, unfold the project, the coordinator's row.
      {
        const { page, context } = await open(PHONE);
        let taps = 0;
        await page.getByRole("button", { name: "Open navigation" }).first().click(); taps++;
        await page.waitForTimeout(800);
        const drawer = page.getByRole("navigation", { name: "Projects and chats" });
        const unfold = drawer.getByRole("button", { name: `${project} tasks` });
        if (await unfold.count() && (await unfold.first().getAttribute("aria-expanded")) !== "true") { await unfold.first().click(); taps++; await page.waitForTimeout(500); }
        const label = coordinator === "Project coordinator" || !coordinator ? "Coordinator" : coordinator;
        await shoot(page, `drawer-${slug}-390`);
        const link = drawer.locator(`section[aria-label="${project}"] a`).filter({ hasText: new RegExp(`^${label}`) }).first();
        if (await link.count()) { await link.click(); taps++; await page.waitForTimeout(2500); }
        steps.push({ at: `drawer → ${name}`, path: here(page), taps });
        if (!reached(here(page), slug) || taps > 3) failures.push(`drawer: ${name} took ${taps} taps and landed on ${here(page)}`);
        await context.close();
      }
      walks[name] = steps;
    }
    // The project and coordinator pages as a phone draws them.
    for (const [name, path] of [["project-acme", "/project/acme"], ["coordinator-root", "/project/acme/node/root"], ["coordinator-migracion", "/project/acme/node/t-0101"],
      ["coordinator-rediseno", "/project/acme/node/t-0102"]] as const) {
      const { page, context } = await open(PHONE, path);
      await shoot(page, `${name}-390`);
      seen[`${name}Text`] = await text(page);
      await context.close();
    }
    seen.walks = walks;
  } finally {
    await browser?.close();
    await bridge.stop();
  }
  const result = { tag, shots, seen, failures };
  await writeFile(join(outDir, `${tag}-phone-nav.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) await main();
