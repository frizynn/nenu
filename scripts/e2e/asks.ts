import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DESKTOP, launchChrome, PHONE, userCacheDir, type Browser, type Page } from "./browser.ts";
import { startTestBridge } from "./bridge.ts";
import type { OrgSeed } from "./scenario.ts";

// Your asks and a coordinator's card on the e2e bench (ADR 0091), captured with Google Chrome headless.
// Two projects: Acme Shop, whose root coordinator and one nested coordinator each keep a STATUS.md
// with asks in every group (one waiting on you, one that does not close, one in progress, one done) and
// decisions, with token use over a cap; and Research, with an ask on a page and a line that does not
// follow the format. It checks that the asks reach the page through `/api/org/asks` and never the
// snapshot, which carries only how many wait; that the list groups them as Organizations' popup does;
// that a row opens its coordinator's card; and captures the list and both cards at 390 px.
// `--quiet` seeds an Organizations that predates all of it: no `asks`, none of the new fields, and
// none of it on screen.
//
//   bun scripts/e2e/asks.ts [--quiet] [--port 8799] [--out DIR]

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8799" },
    out: { type: "string" },
    quiet: { type: "boolean", default: false },
  },
});
const port = Number(values.port);
const quiet = values.quiet === true;
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), `asks-${Date.now()}`);

const ROOT_STATUS = `# Status
Objective: lanzar el checkout nuevo de Acme antes del viernes

## Asked
- [needs-decision] ¿Lista o tarjetas para el stock en el teléfono? : t-0011 dejó las dos opciones (t-0011)
- [done] Cupones de descuento en el carrito : aprobado y en verde (https://github.com/acme/shop/pull/1351)
- [working] Explicarlo con gráficos
- [working] Que el pago con QR funcione en prueba : falta la clave del proveedor (t-0012)
- [answered] ¿Cuánto sale el envío al interior? : $ 7.800, de 3 a 5 días

## Needs your decision
- Clave de prueba del proveedor de pagos : pasarla hoy o dejar el QR para la semana que viene

## Decisions
- 2026-10-14 El checkout sale en partes, un PR por parte`;

const CHECKOUT_STATUS = `# Status
Objective: el checkout nuevo en seis partes, cada una con su PR

## Asked
- [needs-decision] Diseño del stock a 390 px : elegí lista o tarjetas (t-0011)
- [working] Login con email : en curso (t-0015)
- [open] Revisar los textos de la landing : después del stock

## Needs your decision
- Stock : lista o tarjetas (https://github.com/acme/shop/pull/1352)`;

const RESEARCH_STATUS = `# Status
Objective: elegir el proveedor de envíos

## Asked
- [working] Comparar dos proveedores : leyendo (https://example.com/vendors)
esta línea no sigue el formato`;

const PR_STOCK = "https://github.com/acme/shop/pull/1352";
const PR_COUPONS = "https://github.com/acme/shop/pull/1351";

/** A link as `asks --json` prints it. */
const link = (kind: string, text: string, extra: Record<string, unknown> = {}) =>
  ({ kind, text, target: text, thread: "", title: "", state: "", pr: "", pr_state: "", ...extra });
const ROOT = { id: "root", title: "" };
const CHECKOUT = { id: "t-0010", title: "Rediseño del checkout" };
const ask = (project: string, coordinator: { id: string; title: string }, line: number, state: string, text: string, answer: string, extra: Record<string, unknown> = {}) =>
  ({ project, coordinator, line, state, text, answer, links: [], confirmed: "", mismatch: "", ...extra });

/** Every ask, in the order Organizations sorts them (docs/json.md, Asks). */
const ASKS = [
  ask("acme", ROOT, 5, "needs-decision", "¿Lista o tarjetas para el stock en el teléfono?", "t-0011 dejó las dos opciones", {
    links: [link("thread", "t-0011", { thread: "t-0011", title: "Panel de stock a 390 px", state: "waiting-on-you", pr: PR_STOCK, pr_state: "open" })], confirmed: "in-progress" }),
  ask("acme", CHECKOUT, 5, "needs-decision", "Diseño del stock a 390 px", "elegí lista o tarjetas", {
    links: [link("thread", "t-0011", { thread: "t-0011", title: "Panel de stock a 390 px", state: "waiting-on-you", pr: PR_STOCK, pr_state: "open" })], confirmed: "in-progress" }),
  ask("acme", ROOT, 6, "done", "Cupones de descuento en el carrito", "aprobado y en verde", {
    links: [link("pr", PR_COUPONS, { thread: "t-0014", title: "Cupones de descuento", state: "open", pr: PR_COUPONS, pr_state: "open" })],
    confirmed: "in-progress", mismatch: "a linked PR is still open" }),
  ask("acme", ROOT, 7, "working", "Explicarlo con gráficos", "", { mismatch: "no thread, PR or task is linked" }),
  ask("acme", CHECKOUT, 6, "working", "Login con email", "en curso", {
    links: [link("thread", "t-0015", { thread: "t-0015", title: "Login con email", state: "resolved" })], confirmed: "done", mismatch: "a linked thread is resolved" }),
  ask("acme", ROOT, 8, "working", "Que el pago con QR funcione en prueba", "falta la clave del proveedor", {
    links: [link("thread", "t-0012", { thread: "t-0012", title: "Pago con QR", state: "idle" })], confirmed: "stopped" }),
  ask("acme", CHECKOUT, 7, "open", "Revisar los textos de la landing", "después del stock"),
  ask("research", ROOT, 5, "working", "Comparar dos proveedores", "leyendo", { links: [link("page", "https://example.com/vendors")] }),
  ask("acme", ROOT, 9, "answered", "¿Cuánto sale el envío al interior?", "$ 7.800, de 3 a 5 días"),
  ask("research", ROOT, 6, "unknown", "esta línea no sigue el formato", ""),
];

/** The rows of `ASKS` a coordinator's status file holds, as its `asks` field prints them. */
const fileAsks = (project: string, coordinator: string) =>
  ASKS.filter((row) => row.project === project && row.coordinator.id === coordinator).sort((a, b) => a.line - b.line)
    .map(({ project: _project, coordinator: _coordinator, ...rest }) => rest);

const usage = (context: number, peak: number, compactions: number, overCap: string[] = []) =>
  ({ input: 1_200_000, output: 310_000, cache_read: 48_000_000, cache_write: 2_100_000, context, peak_context: peak, compactions, updated: "", over_cap: overCap });

function pr(url: string, review: string, checks: { passed: number; pending: number; failed: number }) {
  return {
    url, state: "OPEN", review, checks, additions: 240, deletions: 31, failing: [], comment_count: 0, draft: false, mergeable: "MERGEABLE",
    merge_blocker: review === "APPROVED" ? null : "review required", actions: review === "APPROVED" ? ["merge"] : [],
  };
}

function seed(_herd: unknown, now: number, projects: string): OrgSeed {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  // An Organizations that predates the fields prints the file's text and nothing read out of it.
  const statusFile = (slug: string, file: string, text: string, minutes: number, fields: Record<string, unknown>) =>
    ({ path: join(projects, slug, file), text, updated: ago(minutes), ...(quiet ? {} : fields) });
  const used = (value: ReturnType<typeof usage>) => quiet ? {} : { usage: { ...value, updated: ago(3) } };
  const node = (id: string, title: string, parent: string, role: "worker" | "coordinator", group: string, minutes: number, extra: Record<string, unknown> = {}) => ({
    id, title, parent_id: parent, role, status: group === "resolved" ? "resolved" : "open", group, group_label: group, note: "", branch: "",
    workspace_id: "", tab_id: "", pane_id: "", cwd: "", updated: ago(minutes), report_unacked: false, auto_fix_ci: false, auto_merge: false, pr: null, ...extra,
  });
  return {
    profiles: ["claude", "codex"],
    ...(quiet ? {} : { asks: ASKS }),
    projects: [{
      slug: "acme", name: "Acme Shop", goal: "Coordinar iniciativas de Acme que requieran varios threads o PRs", status: "active",
      coordinator: { pane_id: "", workspace_id: "", tab_id: "", ...(quiet ? {} : { agent: "claude", model: "opus", state: "idle" }) },
      status_file: statusFile("acme", "STATUS.md", ROOT_STATUS, 4, {
        objective: "lanzar el checkout nuevo de Acme antes del viernes", asks: fileAsks("acme", "root"),
        needs_decision: ["Clave de prueba del proveedor de pagos : pasarla hoy o dejar el QR para la semana que viene"],
      }),
      ...used(usage(412_000, 967_000, 3, ["context_warn"])),
      threads: [
        node("t-0001", "Hotfix del login", "root", "worker", "resolved", 900, { verdict: "done" }),
        node("t-0010", "Rediseño del checkout", "root", "coordinator", "idle", 3, {
          status_file: statusFile("acme", "nodes/t-0010/STATUS.md", CHECKOUT_STATUS, 12, {
            objective: "el checkout nuevo en seis partes, cada una con su PR", asks: fileAsks("acme", "t-0010"),
            needs_decision: ["Stock : lista o tarjetas (https://github.com/acme/shop/pull/1352)"],
          }),
          ...used(usage(188_000, 240_000, 1)),
        }),
        node("t-0011", "Panel de stock a 390 px", "t-0010", "worker", "waiting-on-you", 12, { verdict: "needs-decision", pr: pr(PR_STOCK, "", { passed: 8, pending: 0, failed: 0 }), ...used(usage(120_000, 150_000, 0)) }),
        node("t-0012", "Pago con QR", "t-0010", "worker", "idle", 40, { verdict: "blocked", ...used(usage(90_000, 90_000, 0)) }),
        node("t-0013", "Landing a 390 px", "t-0010", "worker", "working", 1, used(usage(690_000, 720_000, 4, ["compaction_warn"]))),
        node("t-0014", "Cupones de descuento", "t-0010", "worker", "ready-for-review", 25, { verdict: "done", pr: pr(PR_COUPONS, "APPROVED", { passed: 12, pending: 0, failed: 0 }) }),
        node("t-0015", "Login con email", "t-0010", "worker", "resolved", 600, { verdict: "done" }),
      ],
    }, {
      slug: "research", name: "Research", goal: "Comparar proveedores antes de elegir", status: "active",
      status_file: statusFile("research", "STATUS.md", RESEARCH_STATUS, 30, { objective: "elegir el proveedor de envíos", asks: fileAsks("research", "root") }),
      threads: [],
    }],
  };
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const shots: string[] = [];
  const failures: string[] = [];
  const bridge = await startTestBridge({ port, fake: true, org: seed });
  let browser: Browser | null = null;
  try {
    // The first read paints from the files; wait for the overview, then compare what each route carries.
    const deadline = Date.now() + 15_000;
    while ((await (await fetch(`${bridge.url}/api/org/summary?project=acme`)).json() as { threads: unknown }).threads === null) {
      if (Date.now() > deadline) throw new Error("the overview was never read");
      await Bun.sleep(200);
    }
    const snapshot = await (await fetch(`${bridge.url}/api/snapshot`)).text();
    const asks = await (await fetch(`${bridge.url}/api/org/asks`)).json() as { asks: Array<{ group: string; text: string }> | null; decisions: unknown[] };
    const wire = {
      snapshotHasAskText: snapshot.includes("Cupones de descuento en el carrito"),
      waitingAsks: [...snapshot.matchAll(/"waitingAsks":(\d+)/g)].map((match) => Number(match[1])),
      groups: asks.asks?.map((row) => row.group) ?? null,
      decisions: asks.decisions.length,
    };
    if (wire.snapshotHasAskText) failures.push("the snapshot carries an ask's text");
    if (quiet) {
      if (wire.groups !== null || wire.waitingAsks.length) failures.push("an Organizations without `asks` produced asks");
    } else {
      if (wire.groups?.join() !== "waiting,waiting,unclosed,unclosed,unclosed,progress,progress,progress,done,other") failures.push(`the asks were placed ${wire.groups?.join()}`);
      // Acme: two asks and two decisions wait; Research: none.
      if (wire.waitingAsks.join() !== "4,0") failures.push(`the snapshot counted ${wire.waitingAsks.join()} waiting`);
    }

    browser = await launchChrome();
    const open = async (path: string, device: Record<string, unknown>, heading: string | RegExp) => {
      const context = await browser!.newContext({ ...device, timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      await page.goto(bridge.url + path);
      try {
        await page.getByRole("heading", { name: heading }).first().waitFor({ timeout: 15_000 });
      } catch (error) {
        await page.screenshot({ path: join(outDir, `failed-${path.replaceAll("/", "_")}.png`) });
        throw error;
      }
      await page.waitForTimeout(1200);
      return { page, context };
    };
    const shoot = async (page: Page, name: string) => {
      const path = join(outDir, `${name}${quiet ? "-quiet" : ""}.png`);
      await page.screenshot({ path, animations: "disabled" });
      shots.push(path);
    };
    /** A phone as tall as the page, so one capture holds all of it (the page scrolls inside its column). */
    const tall = { ...PHONE, viewport: { width: 390, height: 1800 } };
    const regions = (page: Page) => page.evaluate(() => Array.from(document.querySelectorAll("main section[aria-label]")).map((section) => section.getAttribute("aria-label")), null);

    const pages: Record<string, unknown> = {};
    if (!quiet) {
      for (const [name, device] of [["asks-phone", PHONE], ["asks-phone-full", tall]] as const) {
        const { page, context } = await open("/asks", device, "Your asks");
        const text = await page.locator("main").innerText();
        pages[name] = { regions: await regions(page) };
        for (const words of ["Wait on you", "Does not close", "In progress", "Done", "Other lines", "Marked done, but PR #1351 is still open.", "Acme Shop · Rediseño del checkout"]) {
          if (!text.includes(words)) failures.push(`${name}: no "${words}"`);
        }
        await shoot(page, name);
        if (name === "asks-phone") {
          await page.getByRole("link", { name: /Login con email/ }).first().click();
          await page.waitForTimeout(800);
          if (!page.url().includes("/project/acme/node/t-0010")) failures.push(`a nested coordinator's ask opened ${page.url()}`);
          await page.goBack();
          await page.getByRole("link", { name: /Cupones de descuento en el carrito/ }).first().click();
          await page.waitForTimeout(800);
          if (!page.url().includes("/project/acme/node/root")) failures.push(`a root ask opened ${page.url()}`);
        }
        await context.close();
      }
    }
    for (const [name, path, heading, device] of [
      ["card-root-phone", "/project/acme/node/root", "Coordinator", tall],
      ["card-node-phone", "/project/acme/node/t-0010", "Rediseño del checkout", tall],
      // A desk draws the card on the coordinator's Status tab (ADR 0101).
      ["card-node-desktop", "/project/acme/node/t-0010?tab=status", "Rediseño del checkout", DESKTOP],
      // Home's heading is its headline, whatever it says.
      ["home-desktop", "/", /./, DESKTOP],
    ] as const) {
      if (quiet && name === "card-root-phone") continue;
      const { page, context } = await open(path, device, heading);
      const card = page.locator('section[aria-label="Coordinator card"]');
      pages[name] = { regions: await regions(page), card: await card.count() };
      if (quiet && await card.count()) failures.push(`${name}: a card without the fields`);
      if (!quiet && name.startsWith("card") && !await card.count()) failures.push(`${name}: no card`);
      const entry = await page.getByRole("link", { name: /^Your asks/ }).count();
      // A desk reads asks on each project, so its bar has no Your asks (ADR 0101).
      if (name === "home-desktop" && entry > 0) failures.push("home-desktop: Your asks shows in the desk's bar");
      await shoot(page, name);
      await context.close();
    }

    // A phone reaches the list from its Search sheet, where the projects are listed.
    {
      const { page, context } = await open("/", PHONE, /./);
      await page.getByRole("button", { name: "Search" }).click();
      await page.waitForTimeout(800);
      const entry = page.getByRole("link", { name: /^Your asks/ });
      pages["search-phone"] = { entry: await entry.count() };
      await shoot(page, "search-phone");
      if (quiet && await entry.count()) failures.push("search-phone: Your asks shows without `asks`");
      if (!quiet) {
        if (!await entry.count()) failures.push("search-phone: no Your asks");
        else {
          await entry.first().click();
          await page.getByRole("heading", { name: "Your asks" }).waitFor({ timeout: 10_000 }).catch(() => failures.push(`search-phone: Your asks opened ${page.url()}`));
        }
      }
      await context.close();
    }

    const result = { quiet, outDir, shots, wire, pages, failures };
    await writeFile(join(outDir, `asks${quiet ? "-quiet" : ""}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser?.close();
    await bridge.stop();
  }
  if (failures.length) process.exit(1);
}

await main();
