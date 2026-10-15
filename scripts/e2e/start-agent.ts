import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DESKTOP, launchWebkit, PHONE, userCacheDir, type Browser, type Page } from "./browser.ts";
import { startTestBridge, type TestBridge } from "./bridge.ts";

// The block that starts an agent in a shell pane, on the e2e bench. A shell at its prompt, folded and
// unfolded; the same shell running a long command, then back at its prompt; Claude Code started on
// Ask and Codex on Auto, with the argv the FakeHerdr received; a start that fails while the shell
// stays at its prompt. Phone and desk, dark and light, with the block's and the terminal's height.
// `--before` takes the shell views only, for a build without the folded block.
//
// Last, the Herdr calls one phone makes for the open shell while it sits idle for `--seconds`.
//
//   bun scripts/e2e/start-agent.ts [--before] [--port 8857] [--seconds 60] [--out DIR]

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8857" },
    out: { type: "string" },
    before: { type: "boolean", default: false },
    seconds: { type: "string", default: "60" },
  },
});
const before = values.before === true;
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), `start-agent-${Date.now()}`);
const CAPTURE_EPOCH = Date.parse("2026-10-10T14:00:00Z");
const PROMPT = "user@host:~/demo$ ";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

await mkdir(outDir, { recursive: true });
const bridge: TestBridge = await startTestBridge({ port: Number(values.port), fake: true, epoch: CAPTURE_EPOCH });
const fake = bridge.fake!;
const shots: string[] = [];
const seen: Record<string, unknown> = {};

// One workspace of shells: the one the views look at, and one per start so each launch has a fresh shell.
fake.addWorkspace("w3", "demo");
const shells = ["view", "claude", "codex", "error"].map((name, i) => {
  const tabId = `w3:t${i + 1}`;
  const paneId = `w3:${name}`;
  fake.addTab(tabId, name).addPane({
    paneId, workspaceId: "w3", tabId, agent: null, label: name, cwd: bridge.dir,
    lines: [`${PROMPT}git status`, "On branch main", "nothing to commit, working tree clean"],
  });
  return paneId;
});
const [view, claudePane, codexPane, errorPane] = shells as [string, string, string, string];
// Adding a pane emits no event, so wait for the bridge's next poll to list them before opening one.
for (let i = 0; ; i++) {
  const snap = await fetch(`${bridge.url}/api/snapshot`).then((r) => r.json() as Promise<{ shellPanes: Array<{ paneId: string }> }>);
  if (shells.every((id) => snap.shellPanes.some((p) => p.paneId === id))) break;
  if (i > 150) throw new Error("the bridge never listed the bench's shells");
  await sleep(100);
}

const block = (page: Page) => page.getByRole("region", { name: "Start a conversation" });

/** The mirror's scroller, and the part of it no chrome covers: a phone's header floats over its top. */
const terminalBox = (page: Page) => page.evaluate(() => {
  let scroller: Element | null = document.querySelector("pre");
  while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
  if (!scroller) return null;
  const box = scroller.getBoundingClientRect();
  const chrome = document.querySelector(".chat-chrome")?.getBoundingClientRect();
  const top = Math.max(box.top, chrome && chrome.bottom > box.top && chrome.top < box.bottom ? chrome.bottom : box.top);
  return { x: box.left + box.width / 2, top, bottom: box.bottom };
}, null);

/** The block's height with its margins, and the terminal's visible height. */
async function measure(page: Page) {
  const block = await page.evaluate(() => {
    const section = document.querySelector('section[aria-label="Start a conversation"]');
    const box = section?.getBoundingClientRect();
    const style = section ? getComputedStyle(section) : null;
    return box && style ? Math.round(box.height + parseFloat(style.marginTop) + parseFloat(style.marginBottom)) : 0;
  }, null);
  const terminal = await terminalBox(page);
  return { block, terminal: terminal ? Math.round(terminal.bottom - terminal.top) : null };
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(350);
  const path = join(outDir, `${name}.png`);
  await page.screenshot({ path, animations: "disabled" });
  shots.push(path);
}

async function open(browser: Browser, device: typeof PHONE | typeof DESKTOP, colorScheme: "dark" | "light", paneId: string) {
  const context = await browser.newContext({ ...device, colorScheme, timezoneId: "UTC", locale: "en-US" });
  const page = await context.newPage();
  await page.clock.install({ time: bridge.now() });
  await page.goto(`${bridge.url}/pane/${encodeURIComponent(paneId)}`);
  await page.getByRole("textbox").first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1200);
  return { page, close: () => context.close() };
}

/** Polls until `check` holds, so a step waits for the bridge and the page rather than a fixed time. */
async function until(page: Page, check: () => Promise<boolean>, what: string, ms = 15_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(150)) if (await check()) return;
  throw new Error(`timed out waiting for ${what}`);
}

/** A long command takes the terminal and keeps writing, as a VPN client does once it is connected. */
function runCommand(paneId: string): void {
  fake.appendLines(paneId, `${PROMPT}sudo openvpn --config demo.ovpn`, "Initialization Sequence Started",
    ...Array.from({ length: 24 }, (_, i) => `Route 10.8.${i}.0/24 via tun0 added`), "Initialization Sequence Completed");
  fake.setForeground(paneId, "openvpn");
}

function backToPrompt(paneId: string): void {
  fake.appendLines(paneId, "^C", "SIGINT received, process exiting");
  fake.setForeground(paneId, null);
}

async function shellViews(browser: Browser, device: typeof PHONE | typeof DESKTOP, deviceName: string, scheme: "dark" | "light") {
  const { page, close } = await open(browser, device, scheme, view);
  const key = `${deviceName} ${scheme}`;
  await block(page).waitFor({ timeout: 10_000 });
  seen[`${key} at prompt`] = await measure(page);
  await shoot(page, `${deviceName}-prompt-${scheme}`);
  if (!before) {
    await block(page).getByRole("button", { name: "Agent and permissions" }).click();
    seen[`${key} unfolded`] = await measure(page);
    await shoot(page, `${deviceName}-unfolded-${scheme}`);
    // A tap on the terminal folds it again. Not a locator click: that scrolls the list to the element
    // first, which reads as the operator scrolling up and stops the mirror following its tail.
    const terminal = (await terminalBox(page))!;
    await page.mouse.click(terminal.x, (terminal.top + terminal.bottom) / 2);
    seen[`${key} folded after a tap outside`] = !(await block(page).getByRole("radiogroup", { name: "Agent" }).count());
  }
  runCommand(view);
  if (before) await page.waitForTimeout(2500);
  else await until(page, async () => !(await block(page).count()), "the block to leave while a command runs");
  // The mirror still follows its tail: no "Scroll to latest" offered.
  seen[`${key} running a command`] = { ...(await measure(page)), following: !(await page.getByRole("button", { name: /^Scroll to latest/ }).count()) };
  await shoot(page, `${deviceName}-running-${scheme}`);
  backToPrompt(view);
  if (before) await page.waitForTimeout(2500);
  else await until(page, async () => (await block(page).count()) > 0, "the block to come back at the prompt");
  seen[`${key} back at prompt`] = { ...(await measure(page)), folded: !(await block(page).getByRole("radiogroup", { name: "Agent" }).count()) };
  await close();
}

/** Each start in a shell of its own: Claude Code on the remembered Ask, Codex on Auto, and a failure. */
async function starts(browser: Browser, device: typeof PHONE | typeof DESKTOP, deviceName: string) {
  {
    const { page, close } = await open(browser, device, "dark", claudePane);
    const start = block(page).getByRole("button", { name: /^Start Claude Code/ });
    seen[`${deviceName} folded label`] = await start.innerText();
    await start.click();
    await until(page, async () => fake.started.some((s) => s.paneId === claudePane), "Claude Code to start");
    await page.waitForTimeout(1500);
    await shoot(page, `${deviceName}-claude-started-dark`);
    await close();
  }
  {
    const { page, close } = await open(browser, device, "dark", codexPane);
    await block(page).getByRole("button", { name: "Agent and permissions" }).click();
    await block(page).getByRole("radio", { name: "Codex" }).click();
    await block(page).getByRole("radio", { name: "Auto" }).click();
    await shoot(page, `${deviceName}-codex-chosen-dark`);
    await block(page).getByRole("button", { name: /^Start Codex/ }).click();
    await until(page, async () => fake.started.some((s) => s.paneId === codexPane), "Codex to start");
    seen[`${deviceName} folded after start`] = !(await page.getByRole("radiogroup", { name: "Agent" }).count());
    await close();
  }
  {
    const { page, close } = await open(browser, device, "dark", errorPane);
    fake.failNextStart = { code: "timeout", message: "timed out waiting for agent startup" };
    await block(page).getByRole("button", { name: /^Start Claude Code/ }).click();
    const alert = block(page).getByRole("alert");
    await alert.waitFor({ timeout: 10_000 });
    seen[`${deviceName} start error`] = await alert.innerText();
    seen[`${deviceName} error height`] = await measure(page);
    await shoot(page, `${deviceName}-start-error-dark`);
    await close();
  }
}

/** Socket calls for the open shell, and HTTP requests, while one phone looks at it and nothing changes. */
async function idle(browser: Browser) {
  const { page, close } = await open(browser, PHONE, "dark", view);
  const requests: string[] = [];
  page.on("request", (req) => requests.push(new URL(req.url()).pathname));
  const from = fake.calls.length;
  await page.waitForTimeout(Number(values.seconds) * 1000);
  const calls = fake.calls.slice(from).filter((c) => c.params.pane_id === view);
  const byMethod: Record<string, number> = {};
  for (const c of calls) byMethod[c.method] = (byMethod[c.method] ?? 0) + 1;
  const byRoute: Record<string, number> = {};
  for (const path of requests) byRoute[path] = (byRoute[path] ?? 0) + 1;
  seen[`idle ${values.seconds}s on the open shell`] = { herdrCalls: byMethod, http: byRoute };
  await close();
}

const browser = await launchWebkit().catch(async (error: unknown) => { await bridge.stop(); throw error; });
try {
  for (const scheme of ["dark", "light"] as const) {
    await shellViews(browser, PHONE, "phone", scheme);
    await shellViews(browser, DESKTOP, "desk", scheme);
  }
  if (!before) {
    await starts(browser, PHONE, "phone");
    // The phone's shells are agents now: the desk starts in fresh ones.
    for (const paneId of [claudePane, codexPane, errorPane]) {
      fake.closePane(paneId);
      fake.addPane({ paneId, workspaceId: "w3", tabId: `w3:t${shells.indexOf(paneId) + 1}`, agent: null, label: paneId.split(":")[1], cwd: bridge.dir, lines: [] });
    }
    for (let i = 0; i < 150; i++) {
      const snap = await fetch(`${bridge.url}/api/snapshot`).then((r) => r.json() as Promise<{ shellPanes: Array<{ paneId: string }> }>);
      if ([claudePane, codexPane, errorPane].every((id) => snap.shellPanes.some((p) => p.paneId === id))) break;
      await sleep(100);
    }
    await starts(browser, DESKTOP, "desk");
  }
  await idle(browser);
} finally {
  await browser.close();
  await bridge.stop();
}
const started = fake.started.map(({ paneId, kind, args }) => ({ paneId, kind, args }));
const summary = { before, seen, started, shots };
await writeFile(join(outDir, "start-agent.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
