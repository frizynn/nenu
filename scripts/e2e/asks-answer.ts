import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DESKTOP, launchChrome, PHONE, userCacheDir, type Browser, type Page } from "./browser.ts";
import { startTestBridge } from "./bridge.ts";
import type { DemoHerd, OrgSeed } from "./scenario.ts";

// Your asks shaped like a real registry on 2026-10-17 (ADR 0093), captured with Google Chrome headless at
// 390 and 1440 px: a decision line that is only a parenthesis, an ask whose links read as raw text, and
// asks in two projects and three coordinators. It checks the placeholder is gone from the list and the
// count, the links read as chips, a desk's old /asks link narrowed to one coordinator lands on that
// coordinator's Waiting on you and lists only its own (ADR 0102), and Answer writes through
// `asks answer` and shows the row answered. `--before` only captures.
//
//   bun scripts/e2e/asks-answer.ts [--before] [--port 8863] [--out DIR]

const { values } = parseArgs({ options: { port: { type: "string", default: "8863" }, out: { type: "string" }, before: { type: "boolean", default: false } } });
const port = Number(values.port);
const before = values.before === true;
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), `asks-answer-${Date.now()}`);
const suffix = before ? "antes" : "despues";

const PLACEHOLDER = "(nada por ahora; ninguna unidad de la primera tanda depende de lo que quedó para confirmar)";
const GESTION_STATUS = `# Status
Objective: "Mensajes dentro del admin" construida, probada y en develop, unidad por unidad

## Asked
- [needs-decision] ¿Prospectos primero o varios números? : las dos están listas para arrancar (t-0004, t-0005)
- [working] AWA-569, Fran eligió "Mensajes dentro del admin" (7 unidades) : primera tanda en marcha (task:AWA-569, t-0003, t-0004, t-0005)

## Needs your decision
- ${PLACEHOLDER}`;

const link = (kind: string, text: string, extra: Record<string, unknown> = {}) =>
  ({ kind, text, target: text, thread: "", title: "", state: "", pr: "", pr_state: "", ...extra });
const GESTION = { id: "t-0002", title: "AWAM gestión" };
// Every coordinator here runs, so Organizations takes an answer on each of its rows.
const ask = (project: string, coordinator: { id: string; title: string }, line: number, state: string, text: string, answer: string, extra: Record<string, unknown> = {}) =>
  ({ project, coordinator, line, state, text, answer, links: [], confirmed: "", mismatch: "", actions: ["answer"], ...extra });
const ASKS = [
  ask("awam", GESTION, 5, "needs-decision", "¿Prospectos primero o varios números?", "las dos están listas para arrancar", {
    links: [link("thread", "t-0004", { thread: "t-0004", title: "AWA-697 · varios números en Mensajes", state: "working" }),
      link("thread", "t-0005", { thread: "t-0005", title: "AWA-700 · Prospectos en el admin", state: "working" })], confirmed: "in-progress" }),
  ask("awam", { id: "root", title: "" }, 4, "needs-decision", "¿Publicamos el changelog de octubre?", "", { links: [link("pr", "#1361", { target: "https://github.com/acme/awam/pull/1361", state: "open" })], confirmed: "in-progress" }),
  ask("awam", GESTION, 6, "working", "AWA-569, Fran eligió \"Mensajes dentro del admin\" (7 unidades)", "primera tanda en marcha", {
    links: [link("task", "task:AWA-569", { state: "missing" }), link("thread", "t-0003", { thread: "t-0003", title: "AWA-696 · comercio AWAM", state: "idle" }),
      link("thread", "t-0004", { thread: "t-0004", title: "AWA-697 · varios números en Mensajes", state: "working" }),
      link("thread", "t-0005", { thread: "t-0005", title: "AWA-700 · Prospectos en el admin", state: "working" })], confirmed: "in-progress" }),
  ask("research", { id: "root", title: "" }, 5, "done", "Comparar dos proveedores", "elegimos el de Córdoba", { links: [link("page", "https://example.com/vendors")] }),
];
/** The decision rows Organizations 4bc9f05 prints: the placeholder is not one, a real decision carries its line and links. */
const DECISIONS = [{
  project: "awam", coordinator: GESTION, actions: ["answer"], line: 10,
  text: "Datos del comercio en el PDF : cargarlos en Facturación (recomendada) o traerlos del padrón",
  links: [link("task", "task:AWA-711", { target: "AWA-711", title: "Datos del PDF", state: "todo" })],
}];
const fileAsks = (project: string, coordinator: string) => ASKS.filter((row) => row.project === project && row.coordinator.id === coordinator)
  .map(({ project: _project, coordinator: _coordinator, ...rest }) => rest);

function seed(herd: DemoHerd, now: number, projects: string): OrgSeed {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const bound = (paneId: string, tabId: string) => ({ workspace_id: paneId.split(":")[0]!, tab_id: tabId, pane_id: paneId });
  const node = (id: string, title: string, parent: string, role: "worker" | "coordinator", group: string, minutes: number, extra: Record<string, unknown> = {}) => ({
    id, title, parent_id: parent, role, status: group === "resolved" ? "resolved" : "open", group, group_label: group, note: "", branch: "",
    workspace_id: "", tab_id: "", pane_id: "", cwd: "", updated: ago(minutes), report_unacked: false, auto_fix_ci: false, auto_merge: false, pr: null, ...extra,
  });
  return {
    profiles: ["claude", "codex"],
    asks: ASKS,
    ...(before ? {} : { decisions: DECISIONS }),
    projects: [{
      slug: "awam", name: "AWAM", goal: "Coordinar el trabajo de AWAM: frentes, agentes, revisiones y merges", status: "active",
      coordinator: { pane_id: "", workspace_id: "", tab_id: "" },
      status_file: { path: join(projects, "awam", "STATUS.md"), text: "# Status\nObjective: (none)\n\n## Asked\n- [needs-decision] ¿Publicamos el changelog de octubre? (#1361)", updated: ago(60), asks: fileAsks("awam", "root") },
      threads: [
        node("t-0002", "AWAM gestión", "root", "coordinator", "idle", 5, {
          ...bound(herd.idle, "w1:t2"),
          status_file: { path: join(projects, "awam", "nodes/t-0002/STATUS.md"), text: GESTION_STATUS, updated: ago(8),
            objective: "\"Mensajes dentro del admin\" construida, probada y en develop, unidad por unidad", asks: fileAsks("awam", "t-0002"), needs_decision: [PLACEHOLDER] },
        }),
        node("t-0003", "AWA-696 · comercio AWAM", "t-0002", "worker", "idle", 10),
        node("t-0004", "AWA-697 · varios números en Mensajes", "t-0002", "worker", "working", 1, bound(herd.working, "w1:t1")),
        node("t-0005", "AWA-700 · Prospectos en el admin", "t-0002", "worker", "working", 0),
      ],
    }, {
      slug: "research", name: "Research", goal: "Comparar proveedores antes de elegir", status: "active",
      status_file: { path: join(projects, "research", "STATUS.md"), text: "# Status\nObjective: elegir proveedor", updated: ago(90), objective: "elegir proveedor", asks: fileAsks("research", "root") },
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
    const deadline = Date.now() + 15_000;
    while ((await (await fetch(`${bridge.url}/api/org/summary?project=awam`)).json() as { threads: unknown }).threads === null) {
      if (Date.now() > deadline) throw new Error("the overview was never read");
      await Bun.sleep(200);
    }
    browser = await launchChrome();
    const open = async (path: string, device: Record<string, unknown>) => {
      const context = await browser!.newContext({ ...device, timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      await page.goto(bridge.url + path);
      await page.waitForTimeout(2000);
      return { page, context };
    };
    const shoot = async (page: Page, name: string) => {
      const path = join(outDir, `${name}-${suffix}.png`);
      await page.screenshot({ path, animations: "disabled" });
      shots.push(path);
    };
    const tallPhone = { ...PHONE, viewport: { width: 390, height: 1300 } };
    const tallDesk = { ...DESKTOP, viewport: { width: 1440, height: 1000 } };

    // A desk reads asks on each coordinator's Waiting on you, where an old /asks link narrowed to one
    // lands (ADR 0102); a phone keeps the page with its selectors.
    const GESTION_ASKS = `/asks?project=awam&coordinator=${GESTION.id}`;
    for (const [width, device] of [["390", tallPhone], ["1440", tallDesk]] as const) {
      const { page, context } = await open(width === "1440" ? GESTION_ASKS : "/asks", device);
      const text = await page.locator("main").innerText();
      if (!before) {
        if (text.includes("(nada por ahora")) failures.push(`asks ${width}: the placeholder line shows`);
        if (text.includes("task:AWA-569 missing")) failures.push(`asks ${width}: links read as raw text`);
      }
      await shoot(page, `asks-${width}`);
      if (!before && width === "1440") {
        // One coordinator's asks, then the one that waits on you there answered.
        const landed = new URL(page.url());
        if (landed.pathname !== `/project/awam/node/${GESTION.id}` || landed.searchParams.get("tab") !== "waiting") failures.push(`asks 1440: ${GESTION_ASKS} did not land on the coordinator's Waiting on you`);
        const narrowed = await page.locator("main").innerText();
        if (narrowed.includes("Comparar dos proveedores") || narrowed.includes("changelog de octubre")) failures.push("the filter kept other coordinators' asks");
        await shoot(page, "asks-filtrado-1440");
        await page.getByRole("button", { name: "Answer ¿Prospectos primero o varios números?" }).click();
        await page.getByLabel("Your answer").fill("Prospectos primero, varios números después.");
        await shoot(page, "asks-respondiendo-1440");
        await page.getByRole("button", { name: "Send answer" }).click();
        await page.waitForTimeout(2500);
        if (!(await page.locator("main").innerText()).includes("Answered")) failures.push("the answered row does not say so");
        await shoot(page, "asks-respondido-1440");
        // A fresh read, as a reload brings it: the answered ask stays out of what waits on you.
        await page.goto(`${bridge.url}${GESTION_ASKS}`);
        await page.waitForTimeout(2000);
        const after = await page.locator("main").innerText();
        if (await page.getByRole("button", { name: "Answer ¿Prospectos primero o varios números?" }).count()) failures.push("after a reload the answered ask waits on you again");
        if (!/Answered \d+[smh]? ?ago|Answered just now|Answered/.test(after)) failures.push("after a reload the answered ask does not say so");
        await shoot(page, "asks-respondido-recarga-1440");
        // A decision line answers the same way, on its own line, its links as chips.
        await page.goto(`${bridge.url}${GESTION_ASKS}`);
        await page.waitForTimeout(2000);
        const decision = await page.locator("main").innerText();
        if (decision.includes("(task:AWA-711)") || !decision.includes("AWA-711")) failures.push("the decision's links do not read as chips");
        await page.getByRole("button", { name: /^Answer Datos del comercio/ }).click();
        await page.getByLabel("Your answer").fill("Cargarlos en Facturación.");
        await page.getByRole("button", { name: "Send answer" }).click();
        await page.waitForTimeout(2500);
        await page.goto(`${bridge.url}${GESTION_ASKS}`);
        await page.waitForTimeout(2000);
        if (await page.getByRole("button", { name: /^Answer Datos del comercio/ }).count()) failures.push("after a reload the answered decision waits on you again");
        await shoot(page, "asks-decision-respondida-1440");
      }
      await context.close();
    }
    for (const [width, device] of [["390", tallPhone], ["1440", tallDesk]] as const) {
      const { page, context } = await open("/project/awam/node/t-0002", device);
      await shoot(page, `coordinador-${width}`);
      await context.close();
    }

    const calls = await bridge.orgCalls();
    const answers = calls.filter((argv) => argv[0] === "asks" && argv[1] === "answer" && !argv.includes("--help"));
    if (!before && JSON.stringify(answers) !== JSON.stringify([
      ["asks", "answer", "awam", "t-0002", "--line=5", "--text-file", "-", "--json"],
      ["asks", "answer", "awam", "t-0002", "--line=10", "--text-file", "-", "--json"],
    ])) {
      failures.push(`Organizations was asked ${JSON.stringify(answers)}`);
    }
    const snapshot = await (await fetch(`${bridge.url}/api/snapshot`)).json() as { projects: Array<{ slug: string; waitingAsks?: number }> };
    const result = { before, outDir, shots, answers, waiting: snapshot.projects.map((p) => [p.slug, p.waitingAsks]), failures };
    await writeFile(join(outDir, `asks-answer-${suffix}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser?.close();
    await bridge.stop();
  }
  if (failures.length) process.exit(1);
}

await main();
