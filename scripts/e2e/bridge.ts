import { closeSync, openSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { defaultSocketPath } from "../../bridge/config.ts";
import { FakeHerdr } from "../../bridge/test-support/fake-herdr.ts";
import { seedDemoHerd, type DemoHerd } from "./scenario.ts";

// A throwaway Nenu bridge for e2e runs: real bridge/index.ts, its own port, a temporary state,
// config and journal tree, and (with --fake) a FakeHerdr on a temporary socket. It must never reach
// the operator's live service or Herdr, so it refuses port 8787 and any socket that is, or sits next
// to, Herdr's default one.
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
  fake: FakeHerdr | null;
  herd: DemoHerd | null;
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

export async function startTestBridge(opts: { port: number; fake?: boolean; socketPath?: string }): Promise<TestBridge> {
  assertTestPort(opts.port);
  if (!opts.fake && !opts.socketPath) throw new Error("pass --fake or --socket <disposable herdr socket>");
  if (!(await portIsFree(opts.port))) throw new Error(`port ${opts.port} is busy`);

  const dir = await mkdtemp(join(tmpdir(), "nenu-e2e-"));
  const socketPath = opts.socketPath ?? join(dir, "herdr.sock");
  assertDisposableSocket(socketPath);

  const paths = {
    state: join(dir, "state"),
    config: join(dir, "config"),
    claude: join(dir, "journals", "claude"),
    codex: join(dir, "journals", "codex"),
    other: join(dir, "journals", "other"),
    orgBin: join(dir, "herdr-organizations"),
  };
  for (const p of [paths.state, paths.config, paths.claude, paths.codex, paths.other]) await mkdir(p, { recursive: true });
  // Organizations is an external CLI with its own state; the stub answers "no templates".
  await writeFile(paths.orgBin, "#!/bin/sh\necho 'error: unrecognized subcommand' >&2\nexit 2\n");
  await chmod(paths.orgBin, 0o755);

  let fake: FakeHerdr | null = null;
  let herd: DemoHerd | null = null;
  if (opts.fake) {
    fake = new FakeHerdr({ socketPath });
    herd = await seedDemoHerd(fake, { claudeRoot: paths.claude, cwd: dir });
    await fake.start();
  }

  // Inherit nothing Nenu- or Herdr-specific: HERDR_PLUGIN_STATE_DIR alone would point the bridge at
  // the live service's state.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(COLLIE|HERDR)_/.test(k)) env[k] = v;
  Object.assign(env, {
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
    COLLIE_HERDR_ORGANIZATIONS_BIN: paths.orgBin,
  });

  const logPath = join(dir, "bridge.log");
  const logFd = openSync(logPath, "a");
  const child = Bun.spawn(["bun", join(ROOT, "bridge/index.ts")], { cwd: ROOT, env, stdout: logFd, stderr: logFd });

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
    if (ok) return { url, port: opts.port, dir, socketPath, pid: child.pid, fake, herd, stop };
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
