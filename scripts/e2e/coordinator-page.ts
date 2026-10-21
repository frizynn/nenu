import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DESKTOP, launchChrome, PHONE, userCacheDir, type Browser, type Page } from "./browser.ts";
import { startTestBridge } from "./bridge.ts";
import { seedDemoHerd, type DemoHerd, type OrgSeed } from "./scenario.ts";

// What a coordinator's page held, now inside its chat (ADR 0115), and the way in, at 1440 and 390 px with
// Google Chrome headless: a tap anywhere on a coordinator's row on the project page enters its chat; a
// desk's panel and a phone's Status view hold no report cards, a Waiting on you with only what waits on
// you, the Asked lines read as requests with a state (done ones folded, ADR 0109), and an opened
// STATUS.md that scrolls under a wheel over it.
//
//   bun scripts/e2e/coordinator-page.ts --fixture FILE [--project SLUG] [--coordinator SLUG] [--port 8873] [--out DIR]
//
// --fixture is a fake-org state (fake-org.ts's FakeState), such as copies of real projects' `overview
// --json` entries with their `routine list` and `asks --json` rows; it stays outside the repo. Without
// it the bench seeds one project with a STATUS.md as coordinators write it.

const { values } = parseArgs({ options: {
  port: { type: "string", default: "8873" }, out: { type: "string" }, fixture: { type: "string" },
  project: { type: "string" }, coordinator: { type: "string" },
} });
const port = Number(values.port);
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), `coordinator-page-${Date.now()}`);

const STATUS = `# Status
Objective: lanzar el checkout nuevo de Acme
## Asked
- [working] Pago con QR : hilo trabajando (t-0003)
- [in-progress] Cupones en el carrito : hilo trabajando (t-0004)
- [needs-decision] Lista o tarjetas para el stock : dos opciones con capturas, recomiendo lista
${Array.from({ length: 14 }, (_, n) => `- [done] Arreglo ${n + 1} del checkout : mergeado (t-00${String(n + 10).padStart(2, "0")})`).join("\n")}
## Needs your decision
## Decisions
${Array.from({ length: 30 }, (_, n) => `- 2026-10-${String(1 + (n % 20)).padStart(2, "0")} Decisión ${n + 1}: el checkout sale en partes, un PR por parte, y cada parte con capturas`).join("\n")}`;

function seed(herd: DemoHerd, now: number): OrgSeed {
  const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
  const node = (id: number, title: string, open: boolean, extra: Record<string, unknown> = {}) => ({
    id: `t-${String(id).padStart(4, "0")}`, title, parent_id: "root", role: "worker", status: open ? "open" : "resolved", group: open ? "working" : "resolved",
    group_label: open ? "Working" : "Resolved", note: "", branch: "", workspace_id: "", tab_id: "", pane_id: "", cwd: "", created: ago(3), updated: ago(open ? 0.1 : 2),
    report_unacked: false, auto_fix_ci: false, auto_merge: false, pr: null, actions: [], ...extra,
  });
  const merged = { number: 231, url: "https://github.com/acme/shop/pull/231", state: "MERGED" };
  const ask = (line: number, state: string, text: string, answer: string) => ({ project: "acme", coordinator: { id: "root", title: "" }, line, state, text, answer, links: [], actions: ["answer"], confirmed: "", mismatch: "" });
  return {
    profiles: ["claude"], answers: true,
    asks: [
      ask(4, "working", "Pago con QR", "hilo trabajando (t-0003)"),
      ask(5, "unknown", "[in-progress] Cupones en el carrito : hilo trabajando (t-0004)", ""),
      ask(6, "needs-decision", "Lista o tarjetas para el stock", "dos opciones con capturas, recomiendo lista"),
      ...Array.from({ length: 14 }, (_, n) => ask(7 + n, "done", `Arreglo ${n + 1} del checkout`, "mergeado")),
    ],
    projects: [{
      slug: "acme", name: "Acme", goal: "El checkout nuevo de Acme", status: "active", coordinator: running(herd),
      status_file: { path: "/tmp/acme/STATUS.md", text: STATUS, updated: ago(0.2) },
      threads: [
        node(3, "Pago con QR", true), node(4, "Cupones en el carrito", true),
        node(5, "Textos de la landing", true, { group: "ready-for-review", group_label: "Ready for review", status: "open", pr: merged }),
        ...Array.from({ length: 14 }, (_, n) => node(10 + n, `Arreglo ${n + 1} del checkout`, false, { verdict: "done" })),
      ],
    }],
  };
}

const running = (herd: DemoHerd) => ({ pane_id: herd.idle, workspace_id: herd.idle.split(":")[0]!, tab_id: "w1:t2", agent: "claude", state: "idle" });

/** The page's own scroller: the nearest box under `selector` that scrolls on the y axis. */
async function scroller(page: Page, selector: string): Promise<{ top: number; height: number; client: number } | null> {
  return page.evaluate((target) => {
    let el = document.querySelector(target)?.parentElement ?? null;
    while (el) {
      const style = getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight) return { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight };
      el = el.parentElement;
    }
    const root = document.scrollingElement!;
    return root.scrollHeight > root.clientHeight ? { top: root.scrollTop, height: root.scrollHeight, client: root.clientHeight } : null;
  }, selector);
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const fixture = values.fixture ? JSON.parse(await readFile(values.fixture, "utf8")) as OrgSeed : undefined;
  const projectSlug = values.project ?? fixture?.projects[0]?.slug ?? "acme";
  const coordinatorSlug = values.coordinator ?? projectSlug;
  const lines: string[] = [];
  const failures: string[] = [];
  const check = (ok: boolean, what: string) => { lines.push(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures.push(what); };
  const bridge = await startTestBridge({ port, fake: true, seed: (fake, ctx) => seedDemoHerd(fake, ctx),
    org: fixture ? (herd) => ({ ...fixture, projects: fixture.projects.map((project) => ({ ...project, coordinator: running(herd) })) }) : seed });
  let browser: Browser | null = null;
  try {
    const deadline = Date.now() + 30_000;
    while ((await (await fetch(`${bridge.url}/api/org/summary?project=${coordinatorSlug}`)).json() as { threads: unknown }).threads === null) {
      if (Date.now() > deadline) throw new Error("the overview was never read");
      await Bun.sleep(200);
    }
    browser = await launchChrome();
    const shoot = (page: Page, name: string) => page.screenshot({ path: join(outDir, `${name}.png`), animations: "disabled" });
    const coordinatorPath = `/project/${coordinatorSlug}/node/root`;

    for (const [size, device] of [["1440", DESKTOP], ["390", PHONE]] as const) {
      const context = await browser.newContext({ ...device, timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      const open = async (path: string) => { await page.goto(bridge.url + path); await page.waitForTimeout(3000); };

      // 1. The project page: a tap on the coordinator's row, away from its buttons, enters its chat. A
      // phone opens a project whose coordinator runs on its chat (ADR 0092), so it has no row to tap.
      await open(`/project/${projectSlug}`);
      await shoot(page, `1-project-${size}`);
      const name = page.locator(".desk-card-open").filter({ hasText: "Project coordinator" }).getByText("Project coordinator", { exact: true }).first();
      if (size === "390") lines.push(`390: the project page opens ${new URL(page.url()).pathname}`);
      else if (await name.count()) {
        await name.click();
        await page.waitForTimeout(1500);
        check(new URL(page.url()).pathname.startsWith("/pane/"), `${size}: a tap on the coordinator's name enters its chat (${new URL(page.url()).pathname})`);
      } else check(false, `${size}: the project page names its coordinator`);

      // 2–4. Its chat, with what its page held: a desk's panel, a phone's Status view. The node address lands there too.
      await open(coordinatorPath);
      check(new URL(page.url()).pathname.startsWith("/pane/"), `${size}: the coordinator's address lands on its chat`);
      if (size === "390") {
        // Its Status is a row of the ⋯ (ADR 0118).
        await page.getByRole("button", { name: /^Conversation actions/ }).first().click().catch(() => {});
        const row = page.getByRole("dialog", { name: "Conversation actions" }).getByRole("button", { name: /^Status/ });
        check(await row.count() === 1, "390: the chat's ⋯ has a Status row");
        await row.first().click().catch(() => {});
        await page.waitForTimeout(1200);
      }
      const held = size === "390" ? ".project-overlay" : ".session-panel";
      await shoot(page, `2-coordinator-${size}`);
      check(await page.locator(`${held} section.overview-card[aria-label='Waiting on you']`).count() === 1, `${size}: Waiting on you is in the chat's ${size === "390" ? "Status view" : "panel"}`);
      const doneCards = await page.locator(`${held} article`).count();
      check(doneCards === 0, `${size}: no report cards (${doneCards})`);
      const other = await page.locator(`${held} section[aria-label='Waiting on you'] :is(section[aria-label='Done'], section[aria-label='Other lines'], section[aria-label='Not marked'])`).count();
      check(other === 0, `${size}: Waiting on you shows nothing done and no "Other lines"`);

      // 5–6. Status: the Asked lines as requests, then the opened STATUS.md, scrolled with a wheel over it.
      const card = await page.locator(`${held} section[aria-label='Coordinator card']`).innerText().catch(() => "");
      check(!/\[in-progress\]/.test(card) && await page.locator(`${held} :is(section[aria-label='Other lines'], section[aria-label='Not marked'])`).count() === 0,
        `${size}: the card reads the Asked lines as requests: no "Other lines", no raw [in-progress]`);
      const status = page.locator(`${held} section[aria-label='Coordinator status']`);
      if (await status.count()) await status.scrollIntoViewIfNeeded();
      await shoot(page, `5-status-${size}`);
      const show = page.locator(held).getByRole("button", { name: /Show STATUS\.md/ });
      if (await show.count()) await show.click();
      await page.waitForTimeout(800);
      await shoot(page, `6-status-open-${size}`);
      const file = `${held} section[aria-label=Status]`;
      const section = page.locator(file);
      if (await section.count()) await section.scrollIntoViewIfNeeded();
      const box = await section.boundingBox();
      const before = await scroller(page, file);
      if (box && before) {
        // Over the file's text, inside the screen, away from anything fixed at its edges.
        await page.mouse.move(box.x + box.width / 2, Math.min(Math.max(box.y + 80, 120), device.viewport.height / 2));
        await page.mouse.wheel(0, 900);
        await page.waitForTimeout(600);
        const after = await scroller(page, file);
        const bottom = await section.evaluate((el) => el.getBoundingClientRect().bottom);
        lines.push(`${size}: status scroller ${before.top}→${after?.top} of ${before.height}/${before.client}, section bottom ${Math.round(bottom)}`);
        check((after?.top ?? 0) > before.top, `${size}: a wheel over the opened STATUS.md scrolls its column`);
        await shoot(page, `6-status-scrolled-${size}`);
      } else lines.push(`${size}: status ${box ? "fits without scrolling" : "not drawn"}`);
      const all = page.locator(held).getByRole("button", { name: "Show all" });
      if (await all.count()) {
        await all.click();
        await page.waitForTimeout(500);
        const text = await section.innerText();
        check(/## Decisions|Decisions/.test(text), `${size}: Show all opens the whole file`);
      }
      await context.close();
    }
  } finally {
    await browser?.close();
    await bridge.stop();
  }
  await writeFile(join(outDir, "result.txt"), lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  console.log(`captures: ${outDir}`);
  if (failures.length) process.exitCode = 1;
}

await main();
