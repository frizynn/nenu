import { existsSync, mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import { MachineLink, Machines, parseMachineList, type HerdrMachine, type SpawnedProcess } from "./machines.ts";

// The process side of machines.ts: the real `herdr` and `ssh`, the state dir's sockets, timers.

/**
 * Herdr's CLI: COLLIE_HERDR_BIN, else `herdr` on PATH, else where Herdr installs itself. A launchd or
 * systemd service often has neither ~/.local/bin on PATH nor a shell profile behind it.
 */
export function herdrBinary(env: Record<string, string | undefined> = process.env, home = homedir()): string | null {
  if (env.COLLIE_HERDR_BIN) return env.COLLIE_HERDR_BIN;
  const onPath = Bun.which("herdr", { PATH: env.PATH ?? "" });
  if (onPath) return onPath;
  const installed = join(home, ".local", "bin", "herdr");
  return existsSync(installed) ? installed : null;
}

async function listMachines(binary: string | null): Promise<HerdrMachine[]> {
  if (!binary) return [];
  const child = Bun.spawn([binary, "machine", "list", "--json"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => child.kill(), 5_000);
  try {
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return code === 0 ? parseMachineList(stdout) : [];
  } finally {
    clearTimeout(timer);
  }
}

function spawn(argv: string[]): SpawnedProcess {
  // stdin stays an open pipe for the child's whole life: the tunnel's remote `cat` waits on it, so the
  // bridge exiting (even killed) closes it and takes ssh down too.
  const child = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  return { stdout: child.stdout, stderr: child.stderr, exited: child.exited, kill: () => child.kill() };
}

export function startMachines(stateDir: string, onChange: () => void): Machines {
  const socketDir = join(stateDir, "machines");
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  const binary = herdrBinary();
  const machines = new Machines({
    list: () => listMachines(binary),
    hostLabel: hostname().split(".")[0] || "this machine",
    link: (machine) => new MachineLink(machine, {
      spawn,
      socketDir,
      fetchPeer: (socket, path, init) => fetch(`http://nenu-peer${path}`, { ...init, unix: socket }),
      schedule: (fn, ms) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
      onChange,
    }),
  });
  void machines.reload();
  return machines;
}
