import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DESKTOP, launchChrome, PHONE, userCacheDir, type Browser, type Page } from "./browser.ts";
import { startTestBridge } from "./bridge.ts";
import { seedDemoHerd, type DemoHerd, type OrgSeed } from "./scenario.ts";

// A desk project's page at the size of a real one (ADR 0102): Work and its finished work, Waiting on
// you, Routines and its editor, the header's two buttons. Captured with Google Chrome headless at 1440
// and 390 px; it times a card's fold (click to the next painted frame, plain and with the CPU slowed
// four times) and reports the header buttons' boxes. Organizations is fake-org.ts.
//
//   bun scripts/e2e/project-page.ts [--port 8871] [--out DIR] [--fixture FILE]
//
// --fixture is a fake-org state (fake-org.ts's FakeState) holding one project, such as a copy of a
// real project's `overview --json` entry with its `routine list` and `asks --json` rows: it stays
// outside the repo and replaces the made-up project below.

const { values } = parseArgs({ options: { port: { type: "string", default: "8871" }, out: { type: "string" }, fixture: { type: "string" } } });
const port = Number(values.port);
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), `project-page-${Date.now()}`);

/**
 * A made-up project shaped like the operator's largest on 2026-10-20: ~460 nodes, almost all finished,
 * coordinators started twice under one name (the first never ran a thread), two open coordinators,
 * decisions in the documented `<what> : <recommendation>` shape and two routines.
 */
function seed(herd: DemoHerd, now: number): OrgSeed {
  const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
  const node = (id: string, title: string, parent: string, role: "worker" | "coordinator", open: boolean, hours: number, extra: Record<string, unknown> = {}) => ({
    id, title, parent_id: parent, role, can_spawn: role === "coordinator", status: open ? "open" : "resolved", group: open ? "idle" : "resolved",
    group_label: open ? "Idle" : "Resolved", note: "", branch: "", workspace_id: "", tab_id: "", pane_id: "", cwd: "", created: ago(hours + 2), updated: ago(hours),
    report_unacked: false, auto_fix_ci: false, auto_merge: false, pr: null, actions: [], ...extra,
  });
  const threads: Array<ReturnType<typeof node>> = [];
  let next = 1;
  const id = () => `t-${String(next++).padStart(4, "0")}`;
  const fronts = ["Planes y permisos", "Landing y blog", "Calidad del código", "Pagos", "Mercado Libre", "Facturación", "Pruebas reales", "Docs", "Escapes", "Optimización"];
  fronts.forEach((front, index) => {
    // A first start that failed before running anything, then the one that ran.
    if (index % 3 === 0) threads.push(node(id(), front, "root", "coordinator", false, 90 - index * 6));
    const coordinator = id();
    threads.push(node(coordinator, front, "root", "coordinator", false, 80 - index * 6));
    for (let n = 0; n < 40; n++) threads.push(node(id(), `${front}: tarea ${n + 1}`, coordinator, "worker", false, 80 - index * 6 - n * 0.4));
  });
  const live = id();
  threads.push(node(live, "Coordinador Mi Tienda", "root", "coordinator", true, 1));
  for (let n = 0; n < 8; n++) threads.push(node(id(), `Mi Tienda: arreglo ${n + 1}`, live, "worker", n < 5, n < 5 ? n * 0.3 : 20 + n));
  for (let n = 0; n < 6; n++) threads.push(node(id(), `Suelto ${n + 1}`, "root", "worker", n < 2, n < 2 ? 0.5 : 30 + n));
  const decision = (line: number, coordinator: { id: string; title: string }, text: string, tasks: string[]) => ({
    project: "acme", coordinator, line, text, actions: ["answer"],
    links: tasks.map((task) => ({ kind: "task", text: task, target: task, state: "todo", confirmed: true, title: `${task} detalle`, thread: "", pr: "", prState: "" })),
  });
  return {
    profiles: ["claude", "codex"],
    answers: true,
    asks: [{ project: "acme", coordinator: { id: "root", title: "" }, line: 4, state: "needs-decision", text: "Cuotas sin interés", answer: "Dos opciones: 3 o 6 cuotas; recomiendo 3", links: [], actions: ["answer"], confirmed: "", mismatch: "" }],
    decisions: [
      decision(17, { id: "root", title: "" }, "Stock de Mi Tienda : que Acme sea la fuente del stock. Toca producción y es un mensaje al comercio; recomiendo sí", ["ACM-994", "ACM-736"]),
      decision(18, { id: "root", title: "" }, "Chrome compartido : entrar con tu cuenta en el perfil de Acme para los 2 chequeos del release", ["ACM-986"]),
      decision(19, { id: "root", title: "" }, "Rotar la clave que apareció en una transcripción", []),
      decision(24, { id: live, title: "Coordinador Mi Tienda" }, "Mensaje al comercio : pegar en el grupo el mensaje del 20/10", ["ACM-735"]),
    ],
    projects: [{
      slug: "acme", name: "Acme", goal: "Coordinar el trabajo de Acme: frentes, agentes, revisiones y merges", status: "active",
      coordinator: running(herd),
      threads,
      routines: [
        { name: "pr-followup", trigger: "pr", schedule: "", events: ["checks-failed", "review"], to: "owner", parent: "", repo: "", enabled: true, command: "", command_status: "none",
          prompt: "Fix the failing checks and address the new review comments on your pull request.", last_run: "", next_run: "", skipped_unhandled: 0, skipped_no_coordinator: 0 },
        { name: "standup", trigger: "schedule", schedule: "daily 09:00", events: [], to: "root", parent: "", repo: "", enabled: false, command: "", command_status: "none",
          prompt: "Summarise yesterday.", last_run: ago(20), next_run: "", skipped_unhandled: 0, skipped_no_coordinator: 0 },
      ],
    }],
  };
}

/** The project coordinator, running in the demo's idle Claude pane, so the page offers Project chat. */
const running = (herd: DemoHerd) => ({ pane_id: herd.idle, workspace_id: herd.idle.split(":")[0]!, tab_id: "w1:t2", agent: "claude", state: "idle" });

/** Click to the next painted frame, in ms. */
async function foldTime(page: Page, selector: string): Promise<number> {
  return page.evaluate(async (target) => {
    const button = document.querySelector<HTMLElement>(target);
    if (!button) return Number.NaN;
    const start = performance.now();
    button.click();
    await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
    return performance.now() - start;
  }, selector);
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const fixture = values.fixture ? JSON.parse(await readFile(values.fixture, "utf8")) as OrgSeed : undefined;
  const slug = fixture?.projects[0]?.slug ?? "acme";
  const lines: string[] = [];
  const failures: string[] = [];
  const bridge = await startTestBridge({ port, fake: true, org: fixture ? (herd) => ({ ...fixture, projects: fixture.projects.map((project) => ({ ...project, coordinator: running(herd) })) }) : seed, seed: (fake, ctx) => seedDemoHerd(fake, ctx) });
  let browser: Browser | null = null;
  try {
    const deadline = Date.now() + 20_000;
    while ((await (await fetch(`${bridge.url}/api/org/summary?project=${slug}`)).json() as { threads: unknown }).threads === null) {
      if (Date.now() > deadline) throw new Error("the overview was never read");
      await Bun.sleep(200);
    }
    browser = await launchChrome();
    const open = async (path: string, device: Record<string, unknown>) => {
      const context = await browser!.newContext({ ...device, timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      await page.goto(bridge.url + path);
      await page.waitForTimeout(2500);
      return { page, context };
    };
    const shoot = async (page: Page, name: string, fullPage = false) => {
      await page.screenshot({ path: join(outDir, `${name}.png`), animations: "disabled", fullPage });
    };
    const desk = { ...DESKTOP, reducedMotion: "no-preference" };

    {
      const { page, context } = await open(`/project/${slug}`, desk);
      await shoot(page, "work-1440");
      // The header's buttons: one height, one radius, one baseline.
      const boxes = await page.locator("main header button").evaluateAll((list) => list.map((button) => {
        const box = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return `${(button as HTMLElement).innerText.trim() || button.getAttribute("aria-label")}: ${Math.round(box.width)}x${box.height} top ${box.top} radius ${style.borderRadius} padding ${style.paddingLeft}/${style.paddingRight} font ${style.fontSize}`;
      }));
      lines.push(`header buttons: ${boxes.join(" | ")}`);
      const heights = new Set(boxes.map((box) => box.match(/x([\d.]+)/)?.[1]));
      if (heights.size > 1) failures.push(`header buttons differ in height: ${[...heights].join(", ")}`);
      const head = await page.locator("main header").boundingBox();
      if (head) await page.screenshot({ path: join(outDir, "header-1440.png"), clip: { x: head.x - 8, y: head.y - 8, width: head.width + 16, height: head.height + 70 } });

      // A card's fold, timed on the Open cards and on the finished work.
      const cdp = await context.newCDPSession(page);
      for (const [label, query] of [["open", ""], ["finished", "?work=finished"]] as const) {
        await page.goto(`${bridge.url}/project/${slug}${query}`);
        await page.waitForTimeout(2000);
        const toggle = "main .coord-list .coord-fold[aria-expanded]";
        if (!await page.locator(toggle).count()) { lines.push(`fold ${label}: no card to fold`); continue; }
        for (const rate of [1, 4]) {
          await cdp.send("Emulation.setCPUThrottlingRate", { rate });
          const times: number[] = [];
          for (let n = 0; n < 8; n++) times.push(await foldTime(page, toggle));
          lines.push(`fold ${label} cpu/${rate}: median ${median(times).toFixed(1)} ms, max ${Math.max(...times).toFixed(1)} ms (${times.map((time) => time.toFixed(0)).join(" ")})`);
        }
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
        const rows = await page.locator("main [role=group] button, main li button").count();
        lines.push(`${label}: ${await page.locator("main .coord-list li").count()} cards, ${rows} rows`);
        await shoot(page, `work-${label}-1440`);
      }
      // Finished work as History: searched by a coordinator's name.
      const search = page.getByRole("searchbox");
      if (await search.count()) {
        await search.fill(fixture ? "Calidad" : "Pagos");
        await page.waitForTimeout(400);
        await shoot(page, "work-history-search-1440");
      }
      await context.close();
    }
    {
      const { page, context } = await open(`/project/${slug}?tab=waiting`, desk);
      await shoot(page, "waiting-1440");
      const answer = page.getByRole("button", { name: /^Answer/ }).first();
      if (await answer.count()) {
        await answer.click();
        await page.waitForTimeout(400);
        await shoot(page, "waiting-answer-1440");
      }
      await context.close();
    }
    {
      const { page, context } = await open(`/project/${slug}?tab=routines`, desk);
      await shoot(page, "routines-1440");
      // The first routine opens on its own; closed, a tap opens it again and its detail slides in.
      const close = page.getByRole("button", { name: "Close routine" });
      const first = page.locator("main li button[aria-expanded]").first();
      if (await close.count()) {
        await close.click();
        await page.waitForTimeout(300);
        await shoot(page, "routines-closed-1440");
        await first.click();
        await page.waitForTimeout(60);
        await shoot(page, "routines-opening-1440");
        await page.waitForTimeout(600);
        await shoot(page, "routines-detail-1440");
        const edit = page.getByRole("button", { name: "Edit" });
        if (await edit.count()) {
          await edit.first().click();
          await page.waitForTimeout(500);
          await shoot(page, "routines-edit-1440");
        } else lines.push("routines: no Edit");
      }
      await context.close();
    }
    for (const path of [`/project/${slug}`, "/asks"]) {
      const { page, context } = await open(path, PHONE);
      await shoot(page, `phone${path.replaceAll("/", "-")}-390`);
      await context.close();
    }
    lines.push(`organizations argv: ${[...new Set((await bridge.orgCalls()).map((argv) => argv.slice(0, 2).join(" ")))].join(", ")}`);
  } finally {
    await browser?.close();
    await bridge.stop();
  }
  await writeFile(join(outDir, "result.txt"), [...lines, ...failures.map((failure) => `FAIL ${failure}`)].join("\n") + "\n");
  console.log(lines.join("\n"));
  for (const failure of failures) console.log(`FAIL ${failure}`);
  console.log(`captures: ${outDir}`);
  if (failures.length) process.exitCode = 1;
}

await main();
