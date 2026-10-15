import { readFileSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";

// The bench's `ssh`: the network stand-in for bridge/machines.ts, and nothing else. It takes the argv
// the bridge builds (`-T`, `-o`, `-L <local socket>:<remote socket>`, `--`, target, command) and does
// what OpenSSH would with them on one host: the command runs in a real /bin/sh with the target's HOME
// and environment, and each connection to the local socket is piped to the remote one. The probe, the
// peer socket, the HTTP over the tunnel and the tunnel's life (it ends when its stdin does) are the
// real ones; only the hop between machines is skipped.
//
// $NENU_E2E_SSH_HOSTS names a JSON file, read on every call so a bench can take a host down:
//   { "<target>": { "HOME": "...", "COLLIE_STATE_DIR": "..." } | null }
// null, or a target not listed, answers as an unreachable host does.

const argv = process.argv.slice(2);
let forward: { local: string; remote: string } | null = null;
let i = 0;
for (; i < argv.length; i++) {
  const arg = argv[i]!;
  if (arg === "--") { i++; break; }
  if (arg === "-o") { i++; continue; }
  if (arg === "-L") {
    const spec = argv[++i]!;
    const at = spec.indexOf(":");
    forward = { local: spec.slice(0, at), remote: spec.slice(at + 1) };
    continue;
  }
  if (arg.startsWith("-")) continue;
  break;
}
const target = argv[i];
const command = argv[i + 1] ?? "";

const hosts = JSON.parse(readFileSync(process.env.NENU_E2E_SSH_HOSTS!, "utf8")) as Record<string, Record<string, string> | null>;
const host = target ? hosts[target] : undefined;
if (!host) {
  process.stderr.write(`ssh: connect to host ${target} port 22: Connection refused\r\n`);
  process.exit(255);
}

const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", ...host };

if (forward) {
  // StreamLocalBindUnlink=yes: a socket left behind is replaced. Streams, so a large body is never cut
  // by a partial write.
  rmSync(forward.local, { force: true });
  const remote = forward.remote;
  createServer((local) => {
    const peer = connect(remote);
    local.pipe(peer).on("error", () => local.destroy());
    peer.pipe(local).on("error", () => peer.destroy());
    local.on("error", () => peer.destroy());
    peer.on("error", () => local.destroy());
  }).listen(forward.local);
}

// The remote command, with ssh's own stdin: the tunnel's `cat` ends when the bridge does.
const child = Bun.spawn(["/bin/sh", "-c", command], { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
const code = await child.exited;
if (forward) rmSync(forward.local, { force: true });
process.exit(code);
