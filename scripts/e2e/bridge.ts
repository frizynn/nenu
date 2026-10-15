import { closeSync, openSync, readFileSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { defaultSocketPath } from "../../bridge/config.ts";
import { HerdrClient } from "../../bridge/herdr-client.ts";
import { FakeHerdr } from "../../bridge/test-support/fake-herdr.ts";
import { seedDemoHerd, type DemoHerd, type OrgSeed } from "./scenario.ts";

// A throwaway Nenu bridge for e2e runs: real bridge/index.ts, its own port, a temporary HOME, state,
// config and journal tree, and (with --fake) a FakeHerdr on a temporary socket. It must never reach
// the operator's live service, Herdr, Codex daemon or project registry, so it refuses port 8787 and
// any socket that is, or sits next to, Herdr's default one, and stubs the CLIs the bridge shells out to.
//
//   bun scripts/e2e/bridge.ts --port 8797 --fake            # runs until Ctrl-C
//   bun scripts/e2e/bridge.ts --port 8797 --herdr           # a real Herdr server of its own
//   bun scripts/e2e/bridge.ts --port 8797 --socket <path>   # a disposable real Herdr session
//
// The inherited HERDR_SOCKET_PATH is never used: inside a Herdr pane it names the live server. A
// real Herdr must also keep its session apart from the operator's (assertIsolatedHerdrEnv).

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
  /** The temporary HOME the bridge runs with, and with --herdr the Herdr server and its panes too. */
  home: string;
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

type Env = Record<string, string | undefined>;

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Where Herdr keeps session.json, its default socket and named sessions, for a process with `env`. */
export function herdrConfigDir(env: Env): string | null {
  const base = env.XDG_CONFIG_HOME || (env.HOME ? join(env.HOME, ".config") : "");
  return base ? join(realpathOr(base), "herdr") : null;
}

/**
 * Throws unless a Herdr server running with `serverEnv` keeps its session apart from the operator's.
 * A socket of its own is not enough, and neither is HERDR_CONFIG_PATH: Herdr still reads and rewrites
 * session.json in `$XDG_CONFIG_HOME/herdr` (else `~/.config/herdr`) and restores the operator's
 * workspaces from it. So the server needs an XDG_CONFIG_HOME, and not the operator's.
 */
export function assertIsolatedHerdrEnv(serverEnv: Env, operatorEnv: Env = process.env): void {
  if (!serverEnv.XDG_CONFIG_HOME) {
    throw new Error("refusing Herdr server: it runs without an XDG_CONFIG_HOME of its own, so it shares session.json with the operator's Herdr");
  }
  const dir = herdrConfigDir(serverEnv);
  const operator = [herdrConfigDir(operatorEnv), herdrConfigDir({ HOME: homedir() }), realpathOr(dirname(defaultSocketPath()))];
  if (operator.includes(dir)) throw new Error(`refusing Herdr server: its config dir ${dir} is the operator's`);
}

/** `ps -wwE -o command=` prints the command, then `KEY=value` pairs; a value may hold spaces. */
export function parsePsEnvironment(line: string): Record<string, string> {
  const env: Record<string, string> = {};
  const keys = [...line.matchAll(/ ([A-Za-z_][A-Za-z0-9_]*)=/g)];
  keys.forEach((match, i) => {
    const end = i + 1 < keys.length ? keys[i + 1]!.index : line.length;
    env[match[1]!] = line.slice(match.index + match[0].length, end);
  });
  return env;
}

function processEnvironment(pid: number): Record<string, string> | null {
  try {
    if (process.platform === "linux") {
      const pairs = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean);
      return Object.fromEntries(pairs.map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));
    }
    const ps = Bun.spawnSync(["ps", "-wwE", "-o", "command=", "-p", String(pid)]);
    return ps.exitCode === 0 ? parsePsEnvironment(ps.stdout.toString().trimEnd()) : null;
  } catch {
    return null;
  }
}

/** Throws unless every process serving `socketPath` is an isolated Herdr (see assertIsolatedHerdrEnv). */
export function assertIsolatedHerdr(socketPath: string): void {
  let found = "";
  try {
    found = Bun.spawnSync(["lsof", "-t", "--", socketPath]).stdout.toString();
  } catch {
    // No lsof: nothing can say which server this is, so the check below refuses.
  }
  const pids = found.split(/\s+/).filter(Boolean).map(Number).filter((pid) => pid !== process.pid);
  const envs = pids.map(processEnvironment);
  if (envs.length === 0 || envs.includes(null)) {
    throw new Error(`refusing Herdr socket ${socketPath}: can't tell which config the server behind it uses (no process found, or its environment is unreadable)`);
  }
  for (const env of envs) assertIsolatedHerdrEnv(env!);
}

const AGENT_HOMES = new Set(["CLAUDE_CONFIG_DIR", "CODEX_HOME", "PI_CODING_AGENT_DIR", "GROK_HOME"]);

/**
 * The environment of the Herdr server `--herdr` starts: the bench's temporary HOME and XDG dirs, its
 * own socket, nothing inherited from the live Herdr (inside a pane HERDR_* name the live server) or
 * from Nenu, no agent home of the operator's (each defaults under HOME; Claude's must not be set at
 * all, or its keychain entry is a different one), and the operator's PATH without the bridge's
 * stubs, so its panes run the real CLIs.
 */
export function disposableHerdrEnv(opts: { home: string; socketPath: string }, base: Env = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !/^(COLLIE|HERDR)_/.test(k) && !AGENT_HOMES.has(k)) env[k] = v;
  return Object.assign(env, {
    HOME: opts.home,
    XDG_CONFIG_HOME: join(opts.home, ".config"),
    XDG_DATA_HOME: join(opts.home, ".local", "share"),
    XDG_STATE_HOME: join(opts.home, ".local", "state"),
    XDG_CACHE_HOME: join(opts.home, ".cache"),
    HERDR_SOCKET_PATH: opts.socketPath,
    // An agent started in a pane runs the version the operator has, and never updates it.
    DISABLE_AUTOUPDATER: "1",
  });
}

async function startDisposableHerdr(opts: { home: string; socketPath: string; log: number }): Promise<() => Promise<void>> {
  const env = disposableHerdrEnv(opts);
  assertIsolatedHerdrEnv(env);
  const server = Bun.spawn(["herdr", "server"], { cwd: opts.home, env, stdout: opts.log, stderr: opts.log });
  const stop = async () => {
    server.kill("SIGTERM");
    await Promise.race([server.exited, Bun.sleep(3000)]);
    if (server.exitCode === null) server.kill("SIGKILL");
  };
  const client = new HerdrClient(opts.socketPath, 1000);
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) break;
    if (await client.sessionSnapshot().then(() => true, () => false)) return stop;
    await Bun.sleep(100);
  }
  await stop();
  throw new Error(`disposable Herdr did not come up on ${opts.socketPath}`);
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
/**
 * `repo` fills the demo panes' folder after it becomes a git repo (with $NENU_E2E_GH_PRS) and before
 * the projects are seeded, so a seed can carry numbers the repo produced.
 */
export async function startTestBridge(opts: {
  port: number; fake?: boolean; herdr?: boolean; socketPath?: string; epoch?: number; org?: (herd: DemoHerd, now: number) => OrgSeed; orgBin?: string; repo?: (dir: string) => void;
  /** The herd the FakeHerdr starts with (default: the demo herd). */
  seed?: (fake: FakeHerdr, ctx: { claudeRoot: string; cwd: string; shift: number }) => Promise<DemoHerd>;
  /** Extra variables for the bridge process (machines.ts reads NENU_E2E_MACHINES and NENU_E2E_SSH_HOSTS through the stubs). */
  env?: Record<string, string>;
}): Promise<TestBridge> {
  assertTestPort(opts.port);
  if (!opts.fake && !opts.herdr && !opts.socketPath) throw new Error("pass --fake, --herdr or --socket <disposable herdr socket>");
  if (!(await portIsFree(opts.port))) throw new Error(`port ${opts.port} is busy`);
  if (opts.socketPath) {
    assertDisposableSocket(opts.socketPath);
    assertIsolatedHerdr(opts.socketPath);
  }

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
  // fake-org.ts over the seeded projects, or with `orgBin` is that real binary over the empty
  // registry under this temporary HOME; `claude agents` fails, so session discovery never lists
  // the operator's real Claude processes; `gh` never reaches GitHub: it prints the pull requests in
  // $NENU_E2E_GH_PRS (a JSON file), or fails.
  const orgState = join(dir, "org.json");
  const stubs = {
    "herdr-organizations": opts.orgBin
      ? `exec "${opts.orgBin}" "$@"`
      : opts.org
      ? `exec "${process.execPath}" "${join(import.meta.dir, "fake-org.ts")}" "$@"`
      : "echo 'error: unrecognized subcommand' >&2\nexit 2",
    claude: "exit 1",
    gh: `[ -n "$NENU_E2E_GH_PRS" ] && exec cat "$NENU_E2E_GH_PRS"\necho 'gh stub: no pull requests' >&2\nexit 1`,
    // Herdr's saved machines are the bench's ($NENU_E2E_MACHINES, a `machine list --json`), never the
    // operator's; nothing else of Herdr's CLI is the bridge's to run.
    herdr: `[ -n "$NENU_E2E_HERDR_CALLS" ] && echo "$*" >> "$NENU_E2E_HERDR_CALLS"\n[ "$1 $2" = "machine list" ] || { echo 'herdr stub: only machine list' >&2; exit 2; }\n[ -n "$NENU_E2E_MACHINES" ] && exec cat "$NENU_E2E_MACHINES"\necho '[]'`,
    // No bench run reaches a real machine: ssh is fake-ssh.ts over $NENU_E2E_SSH_HOSTS, or refuses.
    ssh: `[ -n "$NENU_E2E_SSH_HOSTS" ] && exec "${process.execPath}" "${join(import.meta.dir, "fake-ssh.ts")}" "$@"\necho 'ssh stub: the bench has no network' >&2\nexit 255`,
  };
  for (const [name, body] of Object.entries(stubs)) {
    await writeFile(join(paths.bin, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(paths.bin, name), 0o755);
  }
  const shift = opts.epoch === undefined ? 0 : opts.epoch - Date.now();
  const logPath = join(dir, "bridge.log");
  const logFd = openSync(logPath, "a");

  let stopHerdr: (() => Promise<void>) | null = null;
  if (opts.herdr) {
    try {
      stopHerdr = await startDisposableHerdr({ home: paths.home, socketPath, log: logFd });
      assertIsolatedHerdr(socketPath);
    } catch (err) {
      await stopHerdr?.();
      closeSync(logFd);
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
  }

  let fake: FakeHerdr | null = null;
  let herd: DemoHerd | null = null;
  if (opts.fake) {
    fake = new FakeHerdr({ socketPath });
    herd = await (opts.seed ?? seedDemoHerd)(fake, { claudeRoot: paths.claude, cwd: dir, shift });
    // With fake pull requests the demo panes sit in a repo on branch `e2e-demo`, so a PR on that
    // branch opens its agent and the rest open on GitHub.
    if (process.env.NENU_E2E_GH_PRS) {
      Bun.spawnSync(["git", "init", "-q", "-b", "e2e-demo", dir]);
      opts.repo?.(dir);
    }
    await fake.start();
  }
  const org = opts.org && herd ? opts.org(herd, Date.now() + shift) : undefined;
  if (org) {
    await writeFile(orgState, JSON.stringify(org, null, 2));
    // The registry lists a project only with its PROJECT.md; its repo is the bench folder, where the
    // demo panes run, so threads bound to those panes read as live.
    for (const project of org.projects) {
      await mkdir(join(paths.projects, project.slug), { recursive: true });
      // A pick is stored where `set` stores it, so the first read (from the files) already has it.
      const picks = (["icon", "tone"] as const).filter((key) => project[key]).map((key) => `${key} = ${JSON.stringify(project[key])}\n`).join("");
      await writeFile(join(paths.projects, project.slug, "PROJECT.md"),
        `+++\nname = ${JSON.stringify(project.name)}\ngoal = ${JSON.stringify(project.goal)}\n${picks}repos = [{ path = ${JSON.stringify(dir)} }]\n+++\n`);
      if (project.coordinator) {
        await mkdir(join(paths.projects, project.slug, ".state"), { recursive: true });
        await writeFile(join(paths.projects, project.slug, ".state", "coordinator.json"), JSON.stringify({ session: "", cwd: dir, ...project.coordinator }));
      }
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
    // With --herdr the agents run in panes under this same HOME, so the bridge reads their journals.
    COLLIE_TRANSCRIPT_ROOT: opts.herdr ? join(paths.home, ".claude", "projects") : paths.claude,
    COLLIE_CODEX_ROOT: opts.herdr ? join(paths.home, ".codex", "sessions") : paths.codex,
    COLLIE_PI_ROOT: paths.other,
    COLLIE_OPENCODE_ROOT: paths.other,
    COLLIE_GROK_ROOT: paths.other,
    COLLIE_HERDR_ORGANIZATIONS_BIN: join(paths.bin, "herdr-organizations"),
    COLLIE_HERDR_BIN: join(paths.bin, "herdr"),
    NENU_E2E_ORG: orgState,
    ...opts.env,
  });

  const orgCalls = async () => (await Bun.file(`${orgState}.calls`).text().catch(() => ""))
    .split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);

  const child = Bun.spawn(["bun", "--preload", join(import.meta.dir, "clock-shift.ts"), join(ROOT, "bridge/index.ts")], { cwd: ROOT, env, stdout: logFd, stderr: logFd });

  const url = `http://127.0.0.1:${opts.port}`;
  const stop = async () => {
    child.kill("SIGTERM");
    await Promise.race([child.exited, Bun.sleep(3000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await stopHerdr?.();
    closeSync(logFd);
    fake?.stop();
    if (!process.env.NENU_E2E_KEEP) await rm(dir, { recursive: true, force: true });
  };

  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) break;
    const ok = await fetch(`${url}/api/snapshot`).then((r) => r.ok, () => false);
    if (ok) return { url, port: opts.port, dir, socketPath, pid: child.pid, now: () => Date.now() + shift, fake, herd, home: paths.home, orgCalls, stop };
    await Bun.sleep(100);
  }
  const tail = (await Bun.file(logPath).text()).slice(-2000);
  await stop();
  throw new Error(`test bridge did not come up on ${url}\n${tail}`);
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { port: { type: "string", default: "8797" }, fake: { type: "boolean", default: false }, herdr: { type: "boolean", default: false }, socket: { type: "string" } },
  });
  try {
    const bridge = await startTestBridge({ port: Number(values.port), fake: values.fake, herdr: values.herdr, socketPath: values.socket });
    console.log(`[e2e] bridge ${bridge.url} (pid ${bridge.pid})`);
    console.log(`[e2e] state ${bridge.dir}`);
    console.log(`[e2e] herdr ${bridge.socketPath}${bridge.fake ? " (fake)" : values.herdr ? ` (disposable, HOME ${bridge.home})` : ""}`);
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
