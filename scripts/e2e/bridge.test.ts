import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { defaultSocketPath } from "../../bridge/config.ts";
import {
  assertDisposableSocket,
  assertIsolatedHerdrEnv,
  assertTestPort,
  disposableHerdrEnv,
  herdrConfigDir,
  parsePsEnvironment,
  startTestBridge,
} from "./bridge.ts";

// The test bridge's whole promise is that it cannot reach the live service or Herdr.

describe("test bridge guards", () => {
  test("refuses the live Nenu port", async () => {
    expect(() => assertTestPort(8787)).toThrow("live Nenu service");
    await expect(startTestBridge({ port: 8787, fake: true })).rejects.toThrow("live Nenu service");
    expect(() => assertTestPort(8797)).not.toThrow();
  });

  test("refuses Herdr's default socket and the named sessions beside it", () => {
    const live = defaultSocketPath();
    expect(() => assertDisposableSocket(live, undefined)).toThrow("default Herdr socket");
    expect(() => assertDisposableSocket(join(live, "..", "sessions", "work", "herdr.sock"), undefined)).toThrow("default Herdr socket");
  });

  test("refuses the shell's inherited HERDR_SOCKET_PATH, accepts a temporary one", () => {
    const inherited = join(tmpdir(), "live-herdr.sock");
    expect(() => assertDisposableSocket(inherited, inherited)).toThrow("HERDR_SOCKET_PATH");
    expect(() => assertDisposableSocket(join(tmpdir(), "nenu-e2e-x", "herdr.sock"), inherited)).not.toThrow();
  });

  test("needs --fake, --herdr or an explicit disposable socket", async () => {
    await expect(startTestBridge({ port: 8797 })).rejects.toThrow("--fake, --herdr or --socket");
  });

  test("sees no real Codex daemon or clock", async () => {
    const epoch = Date.parse("2026-10-10T14:00:00Z");
    const bridge = await startTestBridge({ port: 8796, fake: true, epoch });
    try {
      const codex = await fetch(`${bridge.url}/api/pane/${encodeURIComponent(bridge.herd!.codex)}/conversations`);
      expect(await codex.text()).toContain("Codex server is unavailable");
      expect(Math.abs(bridge.now() - epoch)).toBeLessThan(60_000);
    } finally {
      await bridge.stop();
    }
  }, 20_000);
});

// A socket of its own does not isolate a Herdr server: it still reads and rewrites session.json in
// its config dir, and restores the operator's workspaces from it. Only XDG_CONFIG_HOME moves that.
describe("disposable Herdr isolation", () => {
  const operator = { HOME: homedir() };

  test("Herdr's config dir follows XDG_CONFIG_HOME, else ~/.config", () => {
    expect(herdrConfigDir({ HOME: "/home/demo" })).toBe(join("/home/demo", ".config", "herdr"));
    expect(herdrConfigDir({ HOME: "/home/demo", XDG_CONFIG_HOME: "/scratch/cfg" })).toBe(join("/scratch/cfg", "herdr"));
  });

  test("refuses a server without an XDG_CONFIG_HOME of its own", () => {
    expect(() => assertIsolatedHerdrEnv({ HOME: join(tmpdir(), "nenu-e2e-x", "home") }, operator)).toThrow("XDG_CONFIG_HOME");
  });

  test("refuses a server whose XDG_CONFIG_HOME is the operator's config", () => {
    expect(() => assertIsolatedHerdrEnv({ HOME: tmpdir(), XDG_CONFIG_HOME: join(homedir(), ".config") }, operator)).toThrow("operator's");
    const shell = { HOME: homedir(), XDG_CONFIG_HOME: join(tmpdir(), "operator-config") };
    expect(() => assertIsolatedHerdrEnv({ XDG_CONFIG_HOME: shell.XDG_CONFIG_HOME }, shell)).toThrow("operator's");
  });

  test("accepts a temporary XDG_CONFIG_HOME", () => {
    expect(() => assertIsolatedHerdrEnv({ HOME: homedir(), XDG_CONFIG_HOME: join(tmpdir(), "nenu-e2e-x", "config") }, operator)).not.toThrow();
  });

  test("reads a server's environment from ps -E, values with spaces included", () => {
    const line = "/usr/local/bin/herdr server HOME=/home/demo XDG_CONFIG_HOME=/tmp/a b/config TERM=xterm-256color";
    expect(parsePsEnvironment(line)).toEqual({ HOME: "/home/demo", XDG_CONFIG_HOME: "/tmp/a b/config", TERM: "xterm-256color" });
  });

  test("the server --herdr launches passes, and inherits nothing of the live one", () => {
    const base = { HOME: homedir(), PATH: "/usr/bin", HERDR_SOCKET_PATH: "/live.sock", HERDR_PANE_ID: "w1:p1", COLLIE_PORT: "8787", XDG_CONFIG_HOME: join(homedir(), ".config"), CLAUDE_CONFIG_DIR: join(homedir(), ".claude"), CODEX_HOME: join(homedir(), ".codex") };
    const home = join(tmpdir(), "nenu-e2e-x", "home");
    const env = disposableHerdrEnv({ home, socketPath: join(tmpdir(), "nenu-e2e-x", "herdr.sock") }, base);
    expect(env.HOME).toBe(home);
    expect(env.XDG_CONFIG_HOME).toBe(join(home, ".config"));
    expect(env.HERDR_SOCKET_PATH).toBe(join(tmpdir(), "nenu-e2e-x", "herdr.sock"));
    expect(env.HERDR_PANE_ID).toBeUndefined();
    expect(env.COLLIE_PORT).toBeUndefined();
    // An agent started in a pane keeps its config and journals under the temporary HOME.
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.CODEX_HOME).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(() => assertIsolatedHerdrEnv(env, base)).not.toThrow();
  });

  test("refuses --socket when the server behind it shares the operator's config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nenu-e2e-iso-"));
    const socketPath = join(dir, "h.sock");
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "XDG_CONFIG_HOME") env[k] = v;
    const server = Bun.spawn(["bun", "-e", `Bun.listen({ unix: ${JSON.stringify(socketPath)}, socket: { data() {} } }); setInterval(() => {}, 1000);`], { env });
    try {
      for (let i = 0; i < 100 && !(await Bun.file(socketPath).exists()); i++) await Bun.sleep(20);
      await expect(startTestBridge({ port: 8795, socketPath })).rejects.toThrow("XDG_CONFIG_HOME");
    } finally {
      server.kill();
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("refuses --socket when nothing tells which config the server uses", async () => {
    const socketPath = join(tmpdir(), `nenu-e2e-nobody-${process.pid}.sock`);
    await expect(startTestBridge({ port: 8795, socketPath })).rejects.toThrow("can't tell");
  });
});
