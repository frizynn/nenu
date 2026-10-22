import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DESKTOP, launchChrome, PHONE, userCacheDir, type Browser, type Page } from "./browser.ts";
import { startTestBridge } from "./bridge.ts";
import { seedDemoHerd, type DemoHerd, type OrgSeed } from "./scenario.ts";

// A project that organizes coordinators (ADR 0092), captured with Google Chrome headless at 390 and
// 1440 px: + lists the projects, a project lists its coordinators with New coordinator, a pick opens
// that coordinator's chat, and a coordinator started there opens its own; the project's page draws
// each coordinator as a row that folds over its card and work, and Move hangs a thread under another
// coordinator. Organizations is fake-org.ts, so the run reports the exact argv Nenu ran.
//
//   bun scripts/e2e/coordinators.ts [--port 8863] [--out DIR]

const { values } = parseArgs({ options: { port: { type: "string", default: "8863" }, out: { type: "string" } } });
const port = Number(values.port);
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), `coordinators-${Date.now()}`);

const CHECKOUT_STATUS = `# Status
Objective: el checkout nuevo en seis partes, cada una con su PR

## Asked
- [working] Login con email : en curso (t-0013)

## Needs your decision
- Stock : lista o tarjetas`;
const WHOLESALE_STATUS = `# Status
Objective: abrir la venta mayorista en noviembre`;
// The project coordinator never ran: its STATUS.md is the template Organizations writes.
const ROOT_STATUS = `# Status
Objective: (none)

## Asked

## Needs your decision

## Decisions`;

function seed(herd: DemoHerd, now: number, projects: string): OrgSeed {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const bound = (paneId: string, tabId: string) => ({ workspace_id: paneId.split(":")[0]!, tab_id: tabId, pane_id: paneId });
  const node = (id: string, title: string, parent: string, role: "worker" | "coordinator", group: string, minutes: number, extra: Record<string, unknown> = {}) => ({
    id, title, parent_id: parent, role, can_spawn: role === "coordinator", status: group === "resolved" ? "resolved" : "open", group, group_label: group, note: "",
    branch: "", workspace_id: "", tab_id: "", pane_id: "", cwd: "", updated: ago(minutes), report_unacked: false, auto_fix_ci: false, auto_merge: false, pr: null,
    // Organizations lists `move` for every open node here: each has a coordinator outside it to go under.
    actions: group === "resolved" ? [] : ["move"], ...extra,
  });
  const statusFile = (file: string, text: string, minutes: number, fields: Record<string, unknown> = {}) =>
    ({ path: join(projects, "acme", file), text, updated: ago(minutes), ...fields });
  const usage = (context: number, peak: number, compactions: number) =>
    ({ input: 900_000, output: 210_000, cache_read: 30_000_000, cache_write: 1_200_000, context, peak_context: peak, compactions, updated: ago(2), over_cap: [] });
  return {
    profiles: ["claude", "codex"],
    asks: [],
    projects: [{
      slug: "acme", name: "Acme Shop", goal: "Coordinar iniciativas de Acme que requieran varios threads o PRs", status: "active",
      coordinator: { pane_id: "", workspace_id: "", tab_id: "" },
      status_file: statusFile("STATUS.md", ROOT_STATUS, 300),
      // The tab Organizations would open for the next coordinator: the demo Codex pane.
      start_pane: bound(herd.codex, "w2:t1"),
      threads: [
        node("t-0001", "Cierre Wholesale", "root", "coordinator", "resolved", 3000),
        node("t-0002", "Extraer requisitos", "t-0001", "worker", "resolved", 3100),
        node("t-0010", "Rediseño del checkout", "root", "coordinator", "idle", 2, {
          ...bound(herd.idle, "w1:t2"), agent: "claude",
          status_file: statusFile("nodes/t-0010/STATUS.md", CHECKOUT_STATUS, 12, { objective: "el checkout nuevo en seis partes, cada una con su PR", needs_decision: ["Stock : lista o tarjetas"] }),
          usage: usage(188_000, 240_000, 1),
        }),
        node("t-0011", "Panel de stock a 390 px", "t-0010", "worker", "waiting-on-you", 4, bound(herd.blocked, "w2:t1")),
        node("t-0012", "Landing a 390 px", "t-0010", "worker", "working", 0, bound(herd.working, "w1:t1")),
        node("t-0013", "Login con email", "t-0010", "worker", "idle", 40),
        // Organizations groups a coordinator whose report has a verdict as ready for review.
        node("t-0020", "Lanzamiento mayorista", "root", "coordinator", "ready-for-review", 6, { verdict: "done",
          status_file: statusFile("nodes/t-0020/STATUS.md", WHOLESALE_STATUS, 30, { objective: "abrir la venta mayorista en noviembre" }),
        }),
        node("t-0021", "Precios por volumen", "t-0020", "worker", "working", 3),
        node("t-0022", "Facturación", "t-0020", "coordinator", "idle", 20),
        node("t-0023", "Factura A", "t-0022", "worker", "idle", 25),
        node("t-0030", "Hotfix del login", "root", "worker", "idle", 35),
      ],
    }, {
      slug: "research", name: "Research", goal: "Comparar proveedores antes de elegir", status: "active",
      threads: [node("t-0101", "Comparar dos proveedores", "root", "worker", "idle", 90)],
    }],
  };
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const shots: string[] = [];
  const failures: string[] = [];
  // Herdr reads a coordinator whose turn ended `done`, as the operator's were on 2026-10-17.
  const bridge = await startTestBridge({ port, fake: true, org: seed, seed: async (fake, ctx) => {
    const herd = await seedDemoHerd(fake, ctx);
    fake.setStatus(herd.idle, "done");
    return herd;
  } });
  let browser: Browser | null = null;
  try {
    const deadline = Date.now() + 15_000;
    while ((await (await fetch(`${bridge.url}/api/org/summary?project=acme`)).json() as { threads: unknown }).threads === null) {
      if (Date.now() > deadline) throw new Error("the overview was never read");
      await Bun.sleep(200);
    }
    browser = await launchChrome();
    const open = async (path: string, device: Record<string, unknown>) => {
      const context = await browser!.newContext({ ...device, timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      await page.goto(bridge.url + path);
      await page.waitForTimeout(1500);
      return { page, context };
    };
    const shoot = async (page: Page, name: string) => {
      const path = join(outDir, `${name}.png`);
      await page.screenshot({ path, animations: "disabled" });
      shots.push(path);
    };
    const expectPath = (page: Page, path: string, step: string) => {
      if (decodeURIComponent(new URL(page.url()).pathname) !== path) failures.push(`${step}: at ${page.url()}, not ${path}`);
    };
    // A phone's + is in its tab bar; a desk's is New chat at the top of its sidebar.
    const newButton = (page: Page, phone: boolean) => phone
      ? page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "New", exact: true })
      : page.getByRole("button", { name: "New chat" }).first();
    const tallPhone = { ...PHONE, viewport: { width: 390, height: 1500 } };
    const tallDesk = { ...DESKTOP, viewport: { width: 1440, height: 1100 } };

    // The project's page: two coordinators, one opened on its card and work, the threads apart.
    {
      const name = "proyecto-390";
      const { page, context } = await open("/project/acme", tallPhone);
      const text = await page.locator("main").innerText();
      for (const words of ["Coordinators", "Rediseño del checkout", "Lanzamiento mayorista", "Threads", "Hotfix del login", "Start project coordinator"]) {
        if (!text.includes(words)) failures.push(`${name}: no "${words}"`);
      }
      if (text.includes("Not running") || text.includes("Objective: (none)")) failures.push(`${name}: the project coordinator heads the page`);
      await shoot(page, `${name}-plegado`);
      await page.getByRole("button", { name: "Rediseño del checkout threads" }).click();
      await page.waitForTimeout(800);
      if (!await page.locator('[role="group"][aria-label="Inside Rediseño del checkout"] section[aria-label="Coordinator card"]').count()) failures.push(`${name}: no card inside the coordinator`);
      await shoot(page, `${name}-abierto`);
      await context.close();
    }
    // A desk's project is a card per coordinator holding its threads, the project coordinator's last
    // with the threads started from the project, each card folding (ADR 0102).
    {
      const name = "proyecto-1440";
      const { page, context } = await open("/project/acme", tallDesk);
      const main = page.locator("main");
      const text = await main.innerText();
      for (const words of ["Rediseño del checkout", "Lanzamiento mayorista", "Project coordinator", "Hotfix del login", "Start project coordinator"]) {
        if (!text.includes(words)) failures.push(`${name}: no "${words}"`);
      }
      const cards = await main.locator(".coord-list li").evaluateAll((list) => list.map((card) => card.getAttribute("aria-label")));
      if (cards.at(-1) !== "Project coordinator") failures.push(`${name}: the project coordinator's card is not last (${cards.join(", ")})`);
      if (!await main.getByRole("group", { name: "Project coordinator threads" }).getByText("Hotfix del login").count()) failures.push(`${name}: the top-level thread is not in the project coordinator's card`);
      await shoot(page, `${name}-abierto`);
      await main.getByRole("button", { name: /^Rediseño del checkout/ }).first().click();
      await page.waitForTimeout(600);
      if (await main.getByRole("group", { name: "Rediseño del checkout threads" }).count()) failures.push(`${name}: the card does not fold`);
      await shoot(page, `${name}-plegado`);
      await context.close();
    }

    // Move: a thread at the top level goes under a coordinator. A desk moves it from the project
    // coordinator's tree, its Threads tab (ADR 0102).
    {
      const { page, context } = await open("/project/acme/node/root", DESKTOP);
      // A desk names a row's actions while the pointer rests on it.
      await page.getByRole("button", { name: /^Hotfix del login/ }).hover();
      await page.getByRole("button", { name: "Move Hotfix del login" }).click();
      await page.getByRole("dialog", { name: "Move this thread" }).waitFor({ timeout: 5000 });
      await shoot(page, "mover-1440");
      await page.getByRole("radio", { name: "Lanzamiento mayorista" }).click();
      await page.getByRole("button", { name: "Move", exact: true }).click();
      await page.waitForTimeout(1500);
      await context.close();
    }

    // + → a project → a coordinator → its chat, on a phone and a desk.
    for (const [suffix, device] of [["390", PHONE], ["1440", DESKTOP]] as const) {
      const { page, context } = await open("/", device);
      await newButton(page, suffix === "390").click();
      await page.getByRole("dialog").waitFor({ timeout: 5000 });
      await page.waitForTimeout(500);
      await shoot(page, `paso1-proyectos-${suffix}`);
      await page.getByRole("button", { name: /^Acme Shop/ }).click();
      await page.getByRole("dialog", { name: "Acme Shop" }).waitFor({ timeout: 5000 });
      await page.waitForTimeout(400);
      await shoot(page, `paso2-coordinadores-${suffix}`);
      await page.getByRole("button", { name: /^Rediseño del checkout/ }).click();
      await page.waitForTimeout(2000);
      expectPath(page, `/pane/${bridge.herd!.idle}`, `pick ${suffix}`);
      await shoot(page, `paso3-chat-${suffix}`);
      await context.close();
    }

    // A new coordinator from the project's step opens its own chat once its pane runs.
    {
      const { page, context } = await open("/", PHONE);
      await newButton(page, true).click();
      await page.getByRole("button", { name: /^Acme Shop/ }).click();
      await page.getByRole("button", { name: /^New coordinator/ }).click();
      await page.getByLabel("Title").fill("Soporte post-venta");
      await page.getByLabel("Task").fill("Ordenar los reclamos de la semana y abrir un thread por cada uno.");
      await shoot(page, "nuevo-coordinador-390");
      await page.getByRole("button", { name: "Create coordinator" }).click();
      await page.waitForFunction(() => location.pathname.startsWith("/pane/"), null, { timeout: 20_000 }).catch(() => failures.push(`new coordinator: stayed at ${page.url()}`));
      await page.waitForTimeout(1500);
      expectPath(page, `/pane/${bridge.herd!.codex}`, "new coordinator");
      await shoot(page, "nuevo-coordinador-chat-390");
      await context.close();
    }

    const calls = await bridge.orgCalls();
    const writes = calls.filter((argv) => argv[0] === "node" && (argv[1] === "start" || (argv[1] === "move" && !argv.includes("--help"))));
    const want = [
      ["node", "move", "acme", "t-0030", "--parent=t-0020", "--json"],
      ["node", "start", "acme", "--role=coordinator", "--can-spawn", "--kind=tab", "--parent=root", "--title=Soporte post-venta", "--task-file", "-"],
    ];
    if (JSON.stringify(writes) !== JSON.stringify(want)) failures.push(`Organizations was asked ${JSON.stringify(writes)}`);
    const result = { outDir, shots, writes, failures };
    await writeFile(join(outDir, "coordinators.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser?.close();
    await bridge.stop();
  }
  if (failures.length) process.exit(1);
}

await main();
