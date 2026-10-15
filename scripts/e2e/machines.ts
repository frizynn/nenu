import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import type { FakeHerdr } from "../../bridge/test-support/fake-herdr.ts";
import { DESKTOP, launchWebkit, PHONE, userCacheDir, type Page } from "./browser.ts";
import { startTestBridge, type TestBridge } from "./bridge.ts";
import { writeJournal, type DemoHerd } from "./scenario.ts";

// Two machines on one host: two test bridges, each on its own FakeHerdr. The local one (--port) has
// Herdr's saved machines from the bench (a `machine list --json`), and its `ssh` is fake-ssh.ts, which
// runs the probe in a real shell with the remote bridge's HOME and pipes the tunnel's sockets; the
// remote one (--remote-port) is an ordinary bridge whose peer.sock answers. A third machine, `lab`,
// is saved but unreachable. Cases: both listed on every screen, a remote chat read and sent to, Stop,
// an agent started on the remote shell, the remote going down, and three restarts (one SIGKILL)
// counting the ssh processes left. `--one` runs the local bridge alone for the one-machine captures,
// which must match a build without machines.
//
//   bun scripts/e2e/machines.ts [--port 8858] [--remote-port 8859] [--out DIR] [--one]

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8858" },
    "remote-port": { type: "string", default: "8859" },
    out: { type: "string" },
    one: { type: "boolean", default: false },
  },
});
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = values.out ?? join(process.env.NENU_E2E_OUT ?? join(userCacheDir(), "nenu-e2e"), `machines-${stamp}`);
await mkdir(outDir, { recursive: true });
const CAPTURE_EPOCH = Date.parse("2026-10-10T14:00:00Z");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The remote machine's herd: two Claudes in `infra` (one working) and a shell, with their journals. */
async function seedBuildBox(fake: FakeHerdr, ctx: { claudeRoot: string; cwd: string; shift: number }): Promise<DemoHerd> {
  const sessions = { release: "44444444-4444-4444-8444-444444444444", flaky: "55555555-5555-4555-8555-555555555555" };
  const dir = join(ctx.claudeRoot, "-srv-infra");
  await mkdir(dir, { recursive: true });
  const journals = new Map<string, string>();
  for (const [paneId, session, task] of [["w1:release", sessions.release, "Draft the release notes"], ["w1:flaky", sessions.flaky, "Find the flaky checkout test"]] as const) {
    const file = join(dir, `${session}.jsonl`);
    journals.set(paneId, file);
    await writeJournal(file, [["user", task], ["assistant", `On it: ${task.toLowerCase()}.`]], Date.now() + ctx.shift);
  }
  fake.addWorkspace("w1", "infra").addTab("w1:t1", "release").addTab("w1:t2", "ops");
  fake.addPane({ paneId: "w1:release", workspaceId: "w1", tabId: "w1:t1", agent: "claude", label: "Release notes", sessionId: sessions.release, cwd: ctx.cwd, lines: ["❯ Draft the release notes", "", "● On it."] });
  fake.addPane({ paneId: "w1:flaky", workspaceId: "w1", tabId: "w1:t1", agent: "claude", label: "Flaky test", sessionId: sessions.flaky, cwd: ctx.cwd, lines: ["❯ Find the flaky checkout test", "", "● On it."] });
  fake.addPane({ paneId: "w1:deploy", workspaceId: "w1", tabId: "w1:t2", agent: null, label: "deploy", cwd: ctx.cwd, lines: [] });
  fake.setStatus("w1:release", "working");
  return { working: "w1:release", idle: "w1:flaky", blocked: "", codex: "", shell: "w1:deploy", journals, dialog: "" };
}

const MACHINES = [
  { id: "a1b2c3d4e5f60718293a4b5c6d7e8f90", label: "build-box", target: "build-box", session: "default", enabled: true, selected: false },
  { id: "0f1e2d3c4b5a69788796a5b4c3d2e1f0", label: "lab", target: "lab", session: "default", enabled: true, selected: false },
];

const sshProcesses = (): number => {
  const out = Bun.spawnSync(["ps", "-axo", "command"]).stdout.toString();
  return out.split("\n").filter((line) => line.includes("fake-ssh.ts")).length;
};

type Snapshot = { machines?: Array<{ label: string; state: string; detail?: string }> };
async function machineState(bridge: TestBridge, label: string): Promise<{ state: string; detail?: string } | undefined> {
  const snap = await (await fetch(`${bridge.url}/api/snapshot`)).json() as Snapshot;
  return snap.machines?.find((m) => m.label === label);
}
async function waitState(bridge: TestBridge, label: string, state: string, timeoutMs = 20_000): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if ((await machineState(bridge, label).catch(() => undefined))?.state === state) return Date.now() - t0;
    await sleep(100);
  }
  throw new Error(`${label} never became ${state}: ${JSON.stringify(await machineState(bridge, label))}`);
}

const report: Record<string, unknown> = { outDir };

// Every bridge this run starts stops with it, also when a step throws.
const started = new Set<TestBridge>();
async function launch(opts: Parameters<typeof startTestBridge>[0]): Promise<TestBridge> {
  const bridge = await startTestBridge(opts);
  const stop = bridge.stop;
  bridge.stop = async () => {
    if (!started.delete(bridge)) return;
    await stop();
  };
  started.add(bridge);
  return bridge;
}
const shots: string[] = [];
const browser = await launchWebkit();

async function capture(bridge: TestBridge, name: string, path: string, reach: (page: Page) => Promise<void>) {
  for (const [deviceName, device] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
    for (const scheme of ["dark", "light"] as const) {
      const context = await browser.newContext({ ...device, colorScheme: scheme, timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      await page.clock.install({ time: bridge.now() });
      await page.goto(`${bridge.url}${path}`);
      await page.waitForTimeout(1500);
      const failed = await reach(page).then(() => null, (err: Error) => err.message.split("\n")[0]!);
      await page.waitForTimeout(800);
      if (failed) (report.failures ??= [] as string[]) && (report.failures as string[]).push(`${name}-${deviceName}-${scheme}: ${failed}`);
      const file = join(outDir, `${name}-${deviceName}-${scheme}${failed ? "-FAILED" : ""}.png`);
      await page.screenshot({ path: file, animations: "disabled" });
      shots.push(file);
      await context.close();
    }
  }
}

const isPhone = async (page: Page) => (await page.evaluate(() => window.innerWidth, null)) < 1024;
const openDrawer = async (page: Page) => {
  if (await isPhone(page)) await page.getByRole("button", { name: "Open navigation" }).click();
};
const openSearch = (query: string) => async (page: Page) => {
  if (await isPhone(page)) await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Search" }).click();
  else await page.getByRole("navigation", { name: "Projects and chats" }).getByRole("button", { name: /^Search/ }).click();
  await page.waitForTimeout(300);
  await page.keyboard.type(query);
};
const nothing = async () => {};

const local = values.one ? null : await (async () => {
  const remote = await launch({ port: Number(values["remote-port"]), fake: true, epoch: CAPTURE_EPOCH, seed: seedBuildBox });
  const machinesFile = join(outDir, "machines.json");
  const hostsFile = join(outDir, "ssh-hosts.json");
  await writeFile(machinesFile, JSON.stringify(MACHINES));
  await writeFile(hostsFile, JSON.stringify({ "build-box": { HOME: remote.home, COLLIE_STATE_DIR: join(remote.dir, "state") }, lab: null }));
  const env = { NENU_E2E_MACHINES: machinesFile, NENU_E2E_SSH_HOSTS: hostsFile, COLLIE_MACHINE_LABEL: "studio" };
  const t0 = Date.now();
  const bridge = await launch({ port: Number(values.port), fake: true, epoch: CAPTURE_EPOCH, env });
  report.connectMs = (Date.now() - t0) + await waitState(bridge, "build-box", "connected");
  await waitState(bridge, "lab", "offline");
  report.lab = await machineState(bridge, "lab");
  return { bridge, remote, env };
})();

try {
  if (!local) {
    const bridge = await launch({ port: Number(values.port), fake: true, epoch: CAPTURE_EPOCH });
    const snap = await (await fetch(`${bridge.url}/api/snapshot`)).json() as Snapshot;
    report.machinesField = "machines" in snap;
    await capture(bridge, "one-home", "/", nothing);
    await capture(bridge, "one-nav", "/", openDrawer);
    await capture(bridge, "one-search", "/", openSearch("claude"));
    await capture(bridge, "one-chat", `/pane/${encodeURIComponent("w1:idle")}`, nothing);
    await bridge.stop();
  } else {
    const { bridge, remote } = local;
    const fakeB = remote.fake!;
    const R = "%40build-box";

    // Reads through the tunnel against reads here, same route, five each.
    const time = async (url: string) => { const t = performance.now(); const r = await fetch(url, { headers: { "x-collie-seen": "1" } }); await r.arrayBuffer(); return Math.round(performance.now() - t); };
    const here: number[] = [];
    const there: number[] = [];
    for (let i = 0; i < 5; i++) {
      here.push(await time(`${bridge.url}/api/pane/${encodeURIComponent("w1:idle")}`));
      there.push(await time(`${bridge.url}/api/pane/${encodeURIComponent("w1:flaky")}?session=${R}`));
    }
    report.paneReadMs = { here, there };
    const herd = await (await fetch(`${bridge.url}/api/snapshot`)).json() as { machines?: Array<{ label: string; herd?: { workspaces: Array<{ label: string }>; agents: unknown[] } }> };
    report.listed = herd.machines?.map((m) => ({ label: m.label, workspaces: m.herd?.workspaces.map((w) => w.label), agents: m.herd?.agents.length }));

    await capture(bridge, "two-home", "/", nothing);
    await capture(bridge, "two-nav", "/", openDrawer);
    await capture(bridge, "two-search", "/", openSearch("flaky"));
    await capture(bridge, "two-remote-chat", `/pane/${encodeURIComponent("w1:flaky")}?s=${R}`, nothing);
    await capture(bridge, "two-new-chat", "/", async (page) => {
      if (await isPhone(page)) await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /New/ }).first().click();
      else await page.getByRole("button", { name: "New chat" }).click();
      await page.getByRole("button", { name: /^In a new folder/ }).click();
      await page.getByRole("radio", { name: "build-box" }).click({ timeout: 5000 });
    });

    // A remote chat: read, send from its composer, the remote FakeHerdr receives the text.
    {
      const context = await browser.newContext({ ...PHONE, timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      await page.goto(`${bridge.url}/pane/${encodeURIComponent("w1:flaky")}?s=${R}`);
      const box = page.getByRole("textbox").first();
      await box.waitFor({ timeout: 15_000 });
      report.readTranscript = await page.getByText("On it: find the flaky checkout test.").first().waitFor({ timeout: 10_000 }).then(() => true, () => false);
      await box.fill("Run it ten times and report the failures");
      const t0 = performance.now();
      await page.getByRole("button", { name: "Send", exact: true }).click();
      for (let i = 0; i < 100 && !fakeB.submitted.some((s) => s.paneId === "w1:flaky"); i++) await sleep(50);
      report.send = { remoteReceived: fakeB.submitted.filter((s) => s.paneId === "w1:flaky").map((s) => s.text), tapToEnterMs: Math.round(performance.now() - t0) };
      report.localReceivedNothing = local.bridge.fake!.submitted.length === 0;
      await context.close();
    }

    // Stop on the remote working Claude: one Escape on the remote FakeHerdr.
    {
      const context = await browser.newContext({ ...DESKTOP, timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      await page.goto(`${bridge.url}/pane/${encodeURIComponent("w1:release")}?s=${R}`);
      const stop = page.getByRole("button", { name: "Stop", exact: true });
      const shown = await stop.waitFor({ timeout: 15_000 }).then(() => true, () => false);
      if (shown) await stop.click();
      for (let i = 0; i < 60 && fakeB.interrupted.length === 0; i++) await sleep(50);
      report.stop = { shown, remoteEscapes: fakeB.interrupted.map((s) => s.paneId) };
      await context.close();
    }

    // Start Claude Code in the remote shell from its start block: the argv the remote FakeHerdr gets.
    {
      const context = await browser.newContext({ ...PHONE, timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      await page.goto(`${bridge.url}/pane/${encodeURIComponent("w1:deploy")}?s=${R}`);
      const start = page.getByRole("region", { name: "Start a conversation" }).getByRole("button", { name: /^Start Claude Code/ });
      const shown = await start.waitFor({ timeout: 15_000 }).then(() => true, () => false);
      if (shown) await start.click();
      for (let i = 0; i < 100 && fakeB.started.length === 0; i++) await sleep(50);
      report.start = { shown, remote: fakeB.started.map(({ paneId, kind, args }) => ({ paneId, kind, args })), local: local.bridge.fake!.started.length };
      await context.close();
    }

    // The remote goes down: its state says so, this machine keeps working.
    await remote.stop();
    report.downAfterMs = await waitState(bridge, "build-box", "offline", 30_000).catch((e) => String(e));
    report.down = await machineState(bridge, "build-box");
    report.localReadWhileDown = (await fetch(`${bridge.url}/api/pane/${encodeURIComponent("w1:idle")}`)).status;
    report.remoteReadWhileDown = (await fetch(`${bridge.url}/api/pane/${encodeURIComponent("w1:flaky")}?session=${R}`)).status;
    await capture(bridge, "two-down-home", "/", nothing);
    await capture(bridge, "two-down-nav", "/", openDrawer);
    report.sshWhileUp = sshProcesses();
    await bridge.stop();
    await sleep(1500);
    report.sshAfterStop = sshProcesses();

    // Three restarts, the last one SIGKILL, against a remote that is up: ssh never outlives its bridge.
    const remote2 = await launch({ port: Number(values["remote-port"]), fake: true, epoch: CAPTURE_EPOCH, seed: seedBuildBox });
    await writeFile(join(outDir, "ssh-hosts.json"), JSON.stringify({ "build-box": { HOME: remote2.home, COLLIE_STATE_DIR: join(remote2.dir, "state") }, lab: null }));
    const restarts: Array<{ how: string; sshUp: number; sshAfter: number }> = [];
    for (const how of ["SIGTERM", "SIGTERM", "SIGKILL"] as const) {
      const again = await launch({ port: Number(values.port), fake: true, epoch: CAPTURE_EPOCH, env: local.env });
      await waitState(again, "build-box", "connected");
      const sshUp = sshProcesses();
      if (how === "SIGKILL") process.kill(again.pid, "SIGKILL");
      await again.stop();
      await sleep(1500);
      restarts.push({ how, sshUp, sshAfter: sshProcesses() });
    }
    report.restarts = restarts;
    await remote2.stop();
  }
} finally {
  await browser.close();
  for (const bridge of [...started]) await bridge.stop().catch(() => {});
}
report.shots = shots;
await writeFile(join(outDir, "machines.json.report"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
