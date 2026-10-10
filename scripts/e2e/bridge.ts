import { closeSync, openSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { defaultSocketPath } from "../../bridge/config.ts";
import { FakeHerdr } from "../../bridge/test-support/fake-herdr.ts";
import { seedDemoHerd, type DemoHerd, type OrgSeed } from "./scenario.ts";

// A throwaway Nenu bridge for e2e runs: real bridge/index.ts, its own port, a temporary HOME, state,
// config and journal tree, and (with --fake) a FakeHerdr on a temporary socket. It must never reach
// the operator's live service, Herdr, Codex daemon or project registry, so it refuses port 8787 and
// any socket that is, or sits next to, Herdr's default one, and stubs the CLIs the bridge shells out to.
//
//   bun scripts/e2e/bridge.ts --port 8797 --fake            # runs until Ctrl-C
//   bun scripts/e2e/bridge.ts --port 8797 --socket <path>   # a disposable real Herdr session
//
// The inherited HERDR_SOCKET_PATH is never used: inside a Herdr pane it names the live server.

export const LIVE_PORT = 8787;
const ROOT = resolve(import.meta.dir, "../..");

export interface TestBridge {
  url: string;
  port: number;
  dir: string;
  socketPath: string;
  pid: number;
  /** The bench's wall clock, epoch ms (see `epoch`). */
  now(): number;
  fake: FakeHerdr | null;
  herd: DemoHerd | null;
  /** Every argv the bridge ran Organizations with, oldest first (empty without `org`). */
  orgCalls(): Promise<string[][]>;
  stop(): Promise<void>;
}

/** Throws unless `socketPath` is clearly not the operator's Herdr. Exported for the test. */
export function assertDisposableSocket(socketPath: string, inherited = process.env.HERDR_SOCKET_PATH): void {
  const target = resolve(socketPath);
  const live = resolve(defaultSocketPath());
  if (target === live || dirname(target).startsWith(dirname(live))) {
    throw new Error(`refusing Herdr socket ${target}: it is the default Herdr socket or under its config dir`);
  }
  if (inherited && target === resolve(inherited)) {
    throw new Error(`refusing Herdr socket ${target}: it is this shell's HERDR_SOCKET_PATH (the live server)`);
  }
}

export function assertTestPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port ${port}`);
  if (port === LIVE_PORT) throw new Error(`refusing port ${LIVE_PORT}: that is the live Nenu service`);
}

async function portIsFree(port: number): Promise<boolean> {
  try {
    const probe = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    probe.stop(true);
    return true;
  } catch {
    return false;
  }
}

/**
 * `epoch` pins the bench's clock: the bridge, the demo journals and (in run.ts) the browser all read
 * `epoch` plus the time since the bridge started, so captures taken hours apart render the same
 * greeting, date and activity chart.
 */
export async function startTestBridge(opts: { port: number; fake?: boolean; socketPath?: string; epoch?: number; org?: (herd: DemoHerd, now: number) => OrgSeed }): Promise<TestBridge> {
  assertTestPort(opts.port);
  if (!opts.fake && !opts.socketPath) throw new Error("pass --fake or --socket <disposable herdr socket>");
  if (!(await portIsFree(opts.port))) throw new Error(`port ${opts.port} is busy`);

  const dir = await mkdtemp(join(tmpdir(), "nenu-e2e-"));
  const socketPath = opts.socketPath ?? join(dir, "herdr.sock");
  assertDisposableSocket(socketPath);

  const paths = {
    home: join(dir, "home"),
    projects: join(dir, "projects"),
    state: join(dir, "state"),
    config: join(dir, "config"),
    claude: join(dir, "journals", "claude"),
    codex: join(dir, "journals", "codex"),
    other: join(dir, "journals", "other"),
    bin: join(dir, "bin"),
  };
  for (const p of Object.values(paths)) await mkdir(p, { recursive: true });
  // The bridge shells out to these. Organizations answers "no templates", or with `org` is
  // fake-org.ts over the seeded projects; `claude agents` fails, so session discovery never lists
  // the operator's real Claude processes; `gh` never reaches GitHub: it prints the pull requests in
  // $NENU_E2E_GH_PRS (a JSON file), or fails.
  const orgState = join(dir, "org.json");
  const stubs = {
    "herdr-organizations": opts.org
      ? `exec "${process.execPath}" "${join(import.meta.dir, "fake-org.ts")}" "$@"`
      : "echo 'error: unrecognized subcommand' >&2\nexit 2",
    claude: "exit 1",
    gh: `[ -n "$NENU_E2E_GH_PRS" ] && exec cat "$NENU_E2E_GH_PRS"\necho 'gh stub: no pull requests' >&2\nexit 1`,
  };
  for (const [name, body] of Object.entries(stubs)) {
    await writeFile(join(paths.bin, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(paths.bin, name), 0o755);
  }
  const shift = opts.epoch === undefined ? 0 : opts.epoch - Date.now();

  let fake: FakeHerdr | null = null;
  let herd: DemoHerd | null = null;
  if (opts.fake) {
    fake = new FakeHerdr({ socketPath });
    herd = await seedDemoHerd(fake, { claudeRoot: paths.claude, cwd: dir, shift });
    // With fake pull requests the demo panes sit in a repo on branch `e2e-demo`, so a PR on that
    // branch opens its agent and the rest open on GitHub.
    if (process.env.NENU_E2E_GH_PRS) Bun.spawnSync(["git", "init", "-q", "-b", "e2e-demo", dir]);
    await fake.start();
  }
  const org = opts.org && herd ? opts.org(herd, Date.now() + shift) : undefined;
  if (org) {
    await writeFile(orgState, JSON.stringify(org, null, 2));
    // The registry lists a project only with its PROJECT.md; its repo is the bench folder, where the
    // demo panes run, so threads bound to those panes read as live.
    for (const project of org.projects) {
      await mkdir(join(paths.projects, project.slug), { recursive: true });
      await writeFile(join(paths.projects, project.slug, "PROJECT.md"),
        `+++\nname = ${JSON.stringify(project.name)}\ngoal = ${JSON.stringify(project.goal)}\nrepos = [{ path = ${JSON.stringify(dir)} }]\n+++\n`);
    }
  }

  // Inherit nothing Nenu- or Herdr-specific: HERDR_PLUGIN_STATE_DIR alone would point the bridge at
  // the live service's state. Every agent home goes under the temporary HOME: CODEX_HOME would
  // otherwise dial the live Codex app-server, and HERDR_PROJECTS_ROOT would list real projects.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(COLLIE|HERDR)_/.test(k)) env[k] = v;
  Object.assign(env, {
    HOME: paths.home,
    PATH: `${paths.bin}${delimiter}${process.env.PATH ?? ""}`,
    TZ: "UTC",
    HERDR_PROJECTS_ROOT: paths.projects,
    CODEX_HOME: join(paths.home, ".codex"),
    CLAUDE_CONFIG_DIR: join(paths.home, ".claude"),
    PI_CODING_AGENT_DIR: join(paths.home, ".pi", "agent"),
    GROK_HOME: join(paths.home, ".grok"),
    XDG_CONFIG_HOME: join(paths.home, ".config"),
    XDG_DATA_HOME: join(paths.home, ".local", "share"),
    XDG_STATE_HOME: join(paths.home, ".local", "state"),
    XDG_CACHE_HOME: join(paths.home, ".cache"),
    NENU_E2E_CLOCK_SHIFT_MS: String(shift),
    COLLIE_PORT: String(opts.port),
    COLLIE_HOST: "127.0.0.1",
    COLLIE_STATE_DIR: paths.state,
    HERDR_PLUGIN_CONFIG_DIR: paths.config,
    HERDR_SOCKET_PATH: socketPath,
    COLLIE_MULTI_SESSION: "0",
    COLLIE_TRANSCRIPT_ROOT: paths.claude,
    COLLIE_CODEX_ROOT: paths.codex,
    COLLIE_PI_ROOT: paths.other,
    COLLIE_OPENCODE_ROOT: paths.other,
    COLLIE_GROK_ROOT: paths.other,
    COLLIE_HERDR_ORGANIZATIONS_BIN: join(paths.bin, "herdr-organizations"),
    NENU_E2E_ORG: orgState,
  });

  const orgCalls = async () => (await Bun.file(`${orgState}.calls`).text().catch(() => ""))
    .split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);

  const logPath = join(dir, "bridge.log");
  const logFd = openSync(logPath, "a");
  const child = Bun.spawn(["bun", "--preload", join(import.meta.dir, "clock-shift.ts"), join(ROOT, "bridge/index.ts")], { cwd: ROOT, env, stdout: logFd, stderr: logFd });

  const url = `http://127.0.0.1:${opts.port}`;
  const stop = async () => {
    child.kill("SIGTERM");
    await Promise.race([child.exited, Bun.sleep(3000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
    closeSync(logFd);
    fake?.stop();
    if (!process.env.NENU_E2E_KEEP) await rm(dir, { recursive: true, force: true });
  };

  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) break;
    const ok = await fetch(`${url}/api/snapshot`).then((r) => r.ok, () => false);
    if (ok) return { url, port: opts.port, dir, socketPath, pid: child.pid, now: () => Date.now() + shift, fake, herd, orgCalls, stop };
    await Bun.sleep(100);
  }
  const tail = (await Bun.file(logPath).text()).slice(-2000);
  await stop();
  throw new Error(`test bridge did not come up on ${url}\n${tail}`);
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { port: { type: "string", default: "8797" }, fake: { type: "boolean", default: false }, socket: { type: "string" } },
  });
  try {
    const bridge = await startTestBridge({ port: Number(values.port), fake: values.fake, socketPath: values.socket });
    console.log(`[e2e] bridge ${bridge.url} (pid ${bridge.pid})`);
    console.log(`[e2e] state ${bridge.dir}`);
    console.log(`[e2e] herdr ${bridge.socketPath}${bridge.fake ? " (fake)" : ""}`);
    const shutdown = async () => {
      if (bridge.fake) console.log(`[e2e] fake herdr calls ${JSON.stringify(bridge.fake.counts())}`);
      await bridge.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (err) {
    console.error(`[e2e] ${(err as Error).message}`);
    process.exit(1);
  }
}
