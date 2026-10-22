import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DESKTOP, launchChrome, PHONE, userCacheDir, type Browser, type Page } from "./browser.ts";
import { startTestBridge } from "./bridge.ts";
import { seedDemoHerd, type DemoHerd, type OrgSeed } from "./scenario.ts";

// A project's coordinators and their own marks (ADR 0122), captured with Google Chrome headless at 1440
// and 390 px: the Work list with many coordinators, long names, coordinators under others and ones with no
// threads; its mark picker on a desk and as a phone's sheet. Then it picks a coordinator's glyph and colour
// on the desk and checks, after a reload and on another device, that the list, the desk's bar, the
// coordinator's chat header and its panel draw that pick. Exits 1 when a pick does not hold, two open
// coordinators share a glyph, or a row runs past the phone's edge. Organizations is fake-org.ts.
//
//   bun scripts/e2e/coordinator-marks.ts [--port 8879] [--out DIR] [--tag before|after] [--fixture FILE] [--loose]
//
// --fixture is a fake-org state holding one project, such as a copy of a real project's `overview --json`
// entry: it stays outside the repo and replaces the made-up project below. --loose records without failing,
// to capture a build that predates the marks.

const { values } = parseArgs({ options: {
  port: { type: "string", default: "8879" }, out: { type: "string" }, tag: { type: "string", default: "now" }, fixture: { type: "string" }, loose: { type: "boolean" },
} });
const port = Number(values.port);
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), `coordinator-marks-${Date.now()}`);
const tag = values.tag;
const PICK = { icon: "flag", tone: "pink" };

/** Twelve open coordinators as the operator's largest project had them on 2026-10-22: some over others, long names, some with no thread. */
function seed(herd: DemoHerd, now: number): OrgSeed {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  let next = 1;
  const threads: Array<Record<string, unknown> & { id: string }> = [];
  const node = (title: string, parent: string, role: "worker" | "coordinator", group: string, minutes: number) => {
    const id = `t-${String(next++).padStart(4, "0")}`;
    threads.push({
      id, title, parent_id: parent, role, can_spawn: role === "coordinator", status: group === "resolved" ? "resolved" : "open", group, group_label: group,
      note: "", branch: "", workspace_id: "", tab_id: "", pane_id: "", cwd: "", created: ago(minutes + 60), updated: ago(minutes),
      report_unacked: false, auto_fix_ci: false, auto_merge: false, pr: null, actions: [],
    });
    return id;
  };
  const fronts: Array<[string, Array<[string, string]>, string?]> = [
    ["Coordinador Mi Tienda", []],
    ["qa facturacion y ventas arranque mi tienda", [["Factura A con CAE", "working"], ["Venta con tarjeta", "ready-for-review"], ["Nota de crédito", "working"]], "Coordinador Mi Tienda"],
    ["implementar rediseño productos A", [["Grilla de productos", "working"], ["Ficha nueva", "ready-for-review"]], "Coordinador Mi Tienda"],
    ["Gestión de Acme · Mensajes, cuentas y prospectos, con el seguimiento de cada comercio que pidió una demo", [["Responder prospectos", "ready-for-review"]]],
    ["Coordinador mobile: panel prolijo en el celular", [["Panel del celular", "working"]]],
    ["coord-fisgon", []],
    ["coord-fisgon-productos", [["Catálogo", "idle"]], "coord-fisgon"],
    ["mercado libre completo", [["Publicaciones", "ready-for-review"], ["Preguntas", "idle"]]],
    ["coord-fisgon-ia", [["Respuestas IA", "ready-for-review"]]],
    ["coord-plataforma", []],
    ["coord-mydriasis", [["Landing", "working"]]],
    ["Landing, rubros, blog y SEO/GEO", [["Rubros", "idle"]]],
  ];
  const ids = new Map<string, string>();
  fronts.forEach(([title, work, under], index) => {
    const id = node(title, under ? ids.get(under)! : "root", "coordinator", "idle", 5 + index * 7);
    ids.set(title, id);
    work.forEach(([task, group], n) => node(`${task}`, id, "worker", group, 3 + n * 4 + index));
  });
  // Finished fronts, as a real project keeps dozens of them.
  for (let n = 0; n < 8; n++) node(`Frente cerrado ${n + 1}`, "root", "coordinator", "resolved", 3000 + n * 90);
  node("Arreglo suelto", "root", "worker", "working", 2);
  // The coordinator the bench picks for runs in the working demo pane, so it has a chat and a bar row.
  const live = threads.find((thread) => thread.title === "Coordinador mobile: panel prolijo en el celular")!;
  Object.assign(live, { pane_id: herd.working, workspace_id: herd.working.split(":")[0]!, tab_id: "w1:t1" });
  return {
    profiles: ["claude", "codex"],
    answers: true,
    asks: [{ project: "acme", coordinator: { id: ids.get("coord-fisgon")!, title: "coord-fisgon" }, line: 4, state: "needs-decision", text: "Precio del plan : recomiendo el medio", answer: "", links: [], actions: ["answer"], confirmed: "", mismatch: "" }],
    projects: [{
      slug: "acme", name: "Acme", goal: "Coordinar el trabajo de Acme: frentes, agentes, revisiones y merges", status: "active",
      coordinator: { pane_id: herd.idle, workspace_id: herd.idle.split(":")[0]!, tab_id: "w1:t2", agent: "claude", state: "idle" },
      threads,
    }],
  };
}

/** A real project's copy: its coordinator in the idle pane, its first open coordinator in the working one. */
function fromFixture(fixture: OrgSeed, herd: DemoHerd): OrgSeed {
  const project = fixture.projects[0]!;
  let bound = false;
  const threads = project.threads.map((thread) => {
    const unbound = { ...thread, pane_id: "", workspace_id: "", tab_id: "" };
    if (bound || thread.role !== "coordinator" || thread.status === "resolved") return unbound;
    bound = true;
    return { ...unbound, pane_id: herd.working, workspace_id: herd.working.split(":")[0]!, tab_id: "w1:t1" };
  });
  return { ...fixture, projects: [{ ...project, threads, coordinator: { pane_id: herd.idle, workspace_id: herd.idle.split(":")[0]!, tab_id: "w1:t2", agent: "claude", state: "idle" } }] };
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const fixture = values.fixture ? JSON.parse(await readFile(values.fixture, "utf8")) as OrgSeed : undefined;
  const lines: string[] = [];
  const failures: string[] = [];
  let slug = "acme";
  let target: { id: string; title: string; paneId: string } | undefined;
  const bridge = await startTestBridge({
    port, fake: true, seed: (fake, ctx) => seedDemoHerd(fake, ctx),
    org: (herd, now) => {
      const org = fixture ? fromFixture(fixture, herd) : seed(herd, now);
      const project = org.projects[0]!;
      slug = project.slug;
      const live = project.threads.find((thread) => thread.role === "coordinator" && thread.pane_id === herd.working)!;
      target = { id: live.id, title: String(live.title), paneId: herd.working };
      return org;
    },
  });
  let browser: Browser | null = null;
  try {
    const deadline = Date.now() + 20_000;
    while ((await (await fetch(`${bridge.url}/api/org/summary?project=${slug}`)).json() as { threads: unknown }).threads === null) {
      if (Date.now() > deadline) throw new Error("the overview was never read");
      await Bun.sleep(200);
    }
    browser = await launchChrome();
    const open = async (path: string, device: Record<string, unknown>, colorScheme: "dark" | "light" = "dark") => {
      const context = await browser!.newContext({ ...device, colorScheme, timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      await page.goto(bridge.url + path);
      await page.waitForTimeout(2500);
      return { page, context };
    };
    const shoot = async (page: Page, name: string, fullPage = false) => {
      await page.screenshot({ path: join(outDir, `${tag}-${name}.png`), animations: "disabled", fullPage });
    };
    const fail = (what: string) => (values.loose ? lines : failures).push(values.loose ? `(loose) ${what}` : what);
    const markOf = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => {
      const svg = el.matches("svg[data-glyph]") ? el : el.querySelector("svg[data-glyph]");
      return svg ? `${svg.getAttribute("data-glyph")}/${svg.getAttribute("data-hue")}` : "none";
    }).catch(() => "missing");
    const row = (title: string) => `li[aria-label="${title.replace(/"/g, '\\"')}"]`;
    const t = target!;

    // The list, before any pick: a desk and a phone, dark and light.
    {
      const { page, context } = await open(`/project/${slug}`, DESKTOP);
      await shoot(page, "work-desk");
      await shoot(page, "work-desk-full", true);
      const glyphs = await page.locator(".coord-list li .mark-tile svg").evaluateAll((list) => list.map((svg) => svg.getAttribute("data-glyph")));
      lines.push(`desk: ${glyphs.length} coordinator rows, ${new Set(glyphs).size} distinct glyphs`);
      if (glyphs.length < 2) fail("the Work list draws no coordinator marks");
      else if (new Set(glyphs).size !== glyphs.length) fail(`two coordinators share a glyph: ${glyphs.join(" ")}`);
      const fold = page.locator(".coord-list .coord-fold[aria-expanded]").first();
      if (await fold.count()) {
        await fold.click();
        await page.waitForTimeout(400);
        await shoot(page, "work-desk-folded-open");
      }
      await context.close();
    }
    {
      const { page, context } = await open(`/project/${slug}`, DESKTOP, "light");
      await shoot(page, "work-desk-light");
      await context.close();
    }
    {
      const { page, context } = await open(`/project/${slug}`, PHONE);
      await shoot(page, "work-phone");
      await shoot(page, "work-phone-full", true);
      const past = await page.locator(".coord-list li").evaluateAll((list) => list.filter((li) => li.getBoundingClientRect().right > window.innerWidth + 0.5).length);
      const wide = await page.locator("html").evaluate((html) => html.scrollWidth - window.innerWidth);
      lines.push(`phone: ${past} rows past the edge, page ${wide}px wider than the screen`);
      if (past > 0 || wide > 0) fail(`the phone's list runs past its edge (${past} rows, ${wide}px)`);
      // The picker as a phone's sheet: two taps from the list.
      const tile = page.locator(`${row(t.title)} .mark-tile-button`);
      if (await tile.count()) {
        await tile.click();
        await page.waitForTimeout(500);
        await shoot(page, "picker-phone");
      } else fail("the phone's row has no mark to pick from");
      await context.close();
    }

    // Pick on the desk: a glyph, then a colour, both taps from the open picker.
    {
      const { page, context } = await open(`/project/${slug}`, DESKTOP);
      const tile = page.locator(`${row(t.title)} .mark-tile-button`);
      if (await tile.count()) {
        lines.push(`${t.title}: own mark ${await markOf(page, `${row(t.title)} .mark-tile`)}`);
        await tile.click();
        await page.waitForTimeout(300);
        await shoot(page, "picker-desk");
        await page.getByRole("radio", { name: PICK.icon, exact: true }).click();
        await page.getByRole("radio", { name: PICK.tone, exact: true }).click();
        await page.waitForTimeout(800);
        await shoot(page, "picker-desk-picked");
        await page.keyboard.press("Escape");
      } else fail("the desk's row has no mark to pick from");
      await context.close();
    }

    // What the pick reaches: a reload on another device, the desk's bar, the chat's header and its panel.
    const want = `${PICK.icon}/${PICK.tone}`;
    const check = (where: string, got: string) => {
      lines.push(`${where}: ${got}`);
      if (got !== want) fail(`${where} draws ${got}, not the pick ${want}`);
    };
    {
      const { page, context } = await open(`/project/${slug}`, DESKTOP);
      check("list after a reload", await markOf(page, `${row(t.title)} .mark-tile`));
      check("desk bar", await markOf(page, `.nav-chats a:has-text("${t.title.slice(0, 24)}") .nav-lead`));
      await shoot(page, "work-desk-picked");
      await page.goto(`${bridge.url}/pane/${encodeURIComponent(t.paneId)}`);
      await page.waitForTimeout(3000);
      check("chat header", await markOf(page, "header"));
      check("panel overview", await markOf(page, '.overview-row:has-text("Icon") .mark-tile'));
      await shoot(page, "chat-desk-picked");
      await context.close();
    }
    {
      const { page, context } = await open(`/project/${slug}`, PHONE);
      check("phone list", await markOf(page, `${row(t.title)} .mark-tile`));
      await shoot(page, "work-phone-picked");
      await context.close();
    }
    lines.push(`organizations argv: ${[...new Set((await bridge.orgCalls()).map((argv) => argv.slice(0, 2).join(" ")))].join(", ")}`);
  } finally {
    await browser?.close();
    await bridge.stop();
  }
  lines.push(`captures: ${outDir}`);
  if (failures.length) lines.push("", "FAILED:", ...failures.map((failure) => `  - ${failure}`));
  await writeFile(join(outDir, `${tag}-result.txt`), `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
  if (failures.length) process.exit(1);
}

await main();
