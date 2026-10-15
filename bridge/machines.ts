import { join } from "node:path";

import type { MachineHerd, MachineState, MachineView } from "./types.ts";

// The machines Herdr has saved (`herdr machine list`), reached through each one's own Nenu.
//
// Herdr's list is the only list: nothing here adds, renames or forgets a machine. Each enabled machine
// gets one long-lived `ssh` that forwards a socket in this bridge's state directory to the other
// Nenu's `peer.sock` (server.ts), so every request the browser makes for a pane there runs, unchanged,
// on the Nenu whose disk holds that pane's journals, git and files. Herdr's own `remote-api-bridge`
// carries only Herdr's socket, which is not enough for a chat. Measurements and the security argument:
// .adr/0084-machines-are-herdrs-reached-through-their-own-nenu.md.

/** One machine as `herdr machine list --json` reports it. */
export interface HerdrMachine {
  id: string;
  label: string;
  /** The SSH destination exactly as Herdr dials it (a host, `user@host` or an ssh_config alias). */
  target: string;
  /** The Herdr session on that machine Herdr attaches to. */
  session: string;
  enabled: boolean;
}

/** Parse `herdr machine list --json`. Anything that is not that list is no machines. */
export function parseMachineList(stdout: string): HerdrMachine[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const machines: HerdrMachine[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, label, target, session, enabled } = entry as Record<string, unknown>;
    if (typeof id !== "string" || typeof label !== "string" || typeof target !== "string" || !id || !label || !target) continue;
    machines.push({ id, label, target, session: typeof session === "string" && session ? session : "default", enabled: enabled !== false });
  }
  return machines;
}

// Herdr refuses a session name with anything but ASCII letters, digits, '.', '_' and '-' (measured on
// 0.9.3), so a name that starts with '@' can only be a machine.
const MACHINE_PREFIX = "@";

export const machineSession = (label: string): string => `${MACHINE_PREFIX}${label}`;

export function isMachineSession(name: string | undefined): name is string {
  return name !== undefined && name.startsWith(MACHINE_PREFIX);
}

// ── The two ssh commands ─────────────────────────────────────────────

// Herdr's own options for a saved machine: never prompt, never accept a host key it has not seen.
// No `-F`: the operator's ~/.ssh/config and default keys apply, as they do for Herdr, and an agent is
// used only when SSH_AUTH_SOCK reaches the bridge.
const SSH_OPTIONS = [
  "-o", "BatchMode=yes",
  "-o", "StrictHostKeyChecking=yes",
  "-o", "ConnectTimeout=10",
  "-o", "ServerAliveInterval=15",
  "-o", "ServerAliveCountMax=4",
];

// Where the other Nenu keeps `peer.sock`: COLLIE_STATE_DIR when the login shell exports it, the
// supervised service's default, then the state dir Herdr hands an unsupervised one. A state dir with
// `machines/` (machines-runtime.ts makes it) but no socket is a Nenu that is not running; one without,
// a Nenu from before machines; none at all, no Nenu. No single quotes: it travels inside one.
const STATE_DIRS = 'for d in "${COLLIE_STATE_DIR:-}" "$HOME/.local/state/collie" "$HOME/.local/state/herdr/plugins/herdr.nenu"; do [ -n "$d" ] &&';
const PROBE = [
  `${STATE_DIRS} [ -S "$d/peer.sock" ] && { printf "nenu-peer %s\\n" "$d/peer.sock"; exit 0; }; done;`,
  `${STATE_DIRS} [ -d "$d/machines" ] && { echo nenu-stopped; exit 0; }; done;`,
  `${STATE_DIRS} [ -d "$d" ] && { echo nenu-old; exit 0; }; done; echo nenu-none`,
].join(" ");

export function probeArgv(target: string): string[] {
  return ["ssh", "-T", ...SSH_OPTIONS, "--", target, `/bin/sh -c '${PROBE}'`];
}

/**
 * The tunnel. The remote command reports the forward is listening, then waits on stdin: when the
 * bridge exits, however it exits, the pipe closes, `cat` ends and ssh with it. No orphan outlives a
 * restart, and StreamLocalBindUnlink lets the next one take over a socket left behind.
 */
export function tunnelArgv(target: string, localSocket: string, remoteSocket: string): string[] {
  return [
    "ssh", "-T", ...SSH_OPTIONS,
    "-o", "ExitOnForwardFailure=yes",
    "-o", "StreamLocalBindUnlink=yes",
    "-L", `${localSocket}:${remoteSocket}`,
    "--", target, `/bin/sh -c 'echo ${TUNNEL_READY}; exec cat >/dev/null'`,
  ];
}

const TUNNEL_READY = "nenu-tunnel-ready";

export type Probe = { kind: "peer"; path: string } | { kind: "stopped" } | { kind: "old" } | { kind: "none" };

/** The probe's answer; a login banner or noise before it is skipped. */
export function parseProbe(stdout: string): Probe {
  for (const line of stdout.split("\n").reverse()) {
    const text = line.trim();
    if (text.startsWith("nenu-peer ")) return { kind: "peer", path: text.slice("nenu-peer ".length) };
    if (text === "nenu-stopped") return { kind: "stopped" };
    if (text === "nenu-old") return { kind: "old" };
    if (text === "nenu-none") return { kind: "none" };
  }
  return { kind: "none" };
}

/** The path and query a forwarded request carries: the machine's session swapped for Herdr's on that side. */
export function forwardTarget(url: URL, remoteSession: string): string {
  const params = new URLSearchParams(url.search);
  params.delete("session");
  if (remoteSession !== "default") params.set("session", remoteSession);
  const query = params.toString();
  return query ? `${url.pathname}?${query}` : url.pathname;
}

// ── One machine's link ───────────────────────────────────────────────

export interface SpawnedProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

export interface LinkDeps {
  spawn(argv: string[]): SpawnedProcess;
  /** Where the tunnels' local sockets go: `<stateDir>/machines`. */
  socketDir: string;
  /** One HTTP request over the tunnel's local socket. */
  fetchPeer(socket: string, path: string, init?: RequestInit): Promise<Response>;
  schedule(fn: () => void, ms: number): () => void;
  /** The machine's state or herd changed. */
  onChange(): void;
}

// Waits between attempts after a failure, longest last; a link that stayed up a minute starts over.
const RETRY_MS = [5_000, 15_000, 60_000, 300_000];
const STABLE_MS = 60_000;

const lastLine = (text: string): string => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? "";

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text().catch(() => "");
}

async function eachLine(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buffered = "";
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let at: number;
      while ((at = buffered.indexOf("\n")) >= 0) {
        onLine(buffered.slice(0, at));
        buffered = buffered.slice(at + 1);
      }
    }
  } catch {
    // A stream torn down with its process or its request ends the same way as one that closed.
  } finally {
    reader.releaseLock();
  }
}

/** What the lists keep of the other Nenu's snapshot: never its projects, update or device state. */
function herdOf(snapshot: Partial<MachineHerd>): MachineHerd {
  return {
    bridge: snapshot.bridge ?? "disconnected",
    agents: snapshot.agents ?? [],
    shellPanes: snapshot.shellPanes ?? [],
    workspaces: snapshot.workspaces ?? [],
    tabs: snapshot.tabs ?? [],
  };
}

export class MachineLink {
  private state: MachineState = "connecting";
  private detail: string | undefined;
  private herd: MachineHerd | undefined;
  private etag: string | null = null;
  private tunnel: SpawnedProcess | null = null;
  private events: AbortController | null = null;
  private cancelRetry: (() => void) | null = null;
  private attempt = 0;
  private upSince = 0;
  private stopped = false;
  private reading: Promise<void> | null = null;
  private rereadAfter = false;
  /** Why the tunnel is being closed from this side, when it is. */
  private why: string | null = null;
  readonly socket: string;
  readonly session: string;

  constructor(readonly machine: HerdrMachine, private readonly deps: LinkDeps) {
    // The id, not the label: a label may hold anything, and a socket path must stay short (sun_path).
    this.socket = join(deps.socketDir, `m-${machine.id.slice(0, 12)}.sock`);
    this.session = machineSession(machine.label);
  }

  start(): void {
    if (!this.machine.enabled) {
      this.set("disabled", "Disabled in Herdr");
      return;
    }
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.events?.abort();
    this.tunnel?.kill();
  }

  get connected(): boolean {
    return this.state === "connected";
  }

  view(): MachineView {
    return {
      session: this.session,
      label: this.machine.label,
      state: this.state,
      ...(this.detail ? { detail: this.detail } : {}),
      ...(this.herd ? { herd: this.herd } : {}),
    };
  }

  /** The other Nenu's snapshot, as it answers it now. */
  fetch(path: string, init?: RequestInit): Promise<Response> {
    return this.deps.fetchPeer(this.socket, path, init);
  }

  private notRunning(): string {
    return `Nenu is not running on ${this.machine.label}.`;
  }

  private set(state: MachineState, detail?: string): void {
    if (this.state === state && this.detail === detail) return;
    this.state = state;
    this.detail = detail;
    this.deps.onChange();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.set("connecting");
    const probe = this.deps.spawn(probeArgv(this.machine.target));
    const [stdout, stderr, code] = await Promise.all([readText(probe.stdout), readText(probe.stderr), probe.exited]);
    if (this.stopped) return;
    if (code !== 0) return this.fail(lastLine(stderr) || `ssh exited with ${code}`);
    const found = parseProbe(stdout);
    if (found.kind === "stopped") return this.fail(this.notRunning());
    if (found.kind === "old") return this.fail(`Nenu on ${this.machine.label} is too old to be reached from here. Update it there.`, "old-nenu");
    if (found.kind === "none") return this.fail(`Nenu is not installed on ${this.machine.label}.`, "no-nenu");
    this.open(found.path);
  }

  private open(remoteSocket: string): void {
    const tunnel = this.deps.spawn(tunnelArgv(this.machine.target, this.socket, remoteSocket));
    this.tunnel = tunnel;
    let ready = false;
    void eachLine(tunnel.stdout, (line) => {
      if (ready || line.trim() !== TUNNEL_READY) return;
      ready = true;
      this.upSince = Date.now();
      void this.follow();
    });
    const stderr = readText(tunnel.stderr);
    void tunnel.exited.then(async (code) => {
      this.tunnel = null;
      this.events?.abort();
      if (this.stopped) return;
      if (this.upSince && Date.now() - this.upSince >= STABLE_MS) this.attempt = 0;
      this.upSince = 0;
      const why = this.why;
      this.why = null;
      this.fail(why ?? (lastLine(await stderr) || `ssh exited with ${code}`));
    });
  }

  /** Read the herd, then listen for the other Nenu naming a change; a failure here is its Nenu not answering. */
  private async follow(): Promise<void> {
    const events = new AbortController();
    this.events = events;
    try {
      const stream = await this.fetch("/api/events", { signal: events.signal });
      if (!stream.ok || !stream.body) throw new Error(`events: ${stream.status}`);
      await this.reread();
      this.set("connected");
      await eachLine(stream.body, (line) => {
        if (!line.startsWith("data:")) return;
        try {
          if ((JSON.parse(line.slice(5)) as { topic?: string }).topic === "snapshot") void this.reread();
        } catch {
          // Not an event this side understands.
        }
      });
    } catch {
      if (events.signal.aborted) return;
    }
    // The stream ended, or never opened, with the tunnel still up: the other Nenu restarted or stopped.
    // Start over, saying so rather than reporting ssh's exit.
    if (!events.signal.aborted && !this.stopped) {
      this.why = this.notRunning();
      this.tunnel?.kill();
    }
  }

  /** One read of the other machine's herd at a time; a change named meanwhile reads once more after it. */
  private reread(): Promise<void> {
    if (this.reading) {
      this.rereadAfter = true;
      return this.reading;
    }
    this.reading = (async () => {
      do {
        this.rereadAfter = false;
        const headers: Record<string, string> = this.etag ? { "if-none-match": this.etag } : {};
        const res = await this.fetch(forwardTarget(new URL("http://peer/api/snapshot"), this.machine.session), { headers });
        if (res.status === 304) continue;
        if (!res.ok) throw new Error(`snapshot: ${res.status}`);
        this.etag = res.headers.get("etag");
        this.herd = herdOf(await res.json() as Partial<MachineHerd>);
        this.deps.onChange();
      } while (this.rereadAfter);
    })().finally(() => { this.reading = null; });
    return this.reading;
  }

  private fail(detail: string, state: MachineState = "offline"): void {
    this.set(state, detail);
    if (this.stopped) return;
    const wait = RETRY_MS[Math.min(this.attempt, RETRY_MS.length - 1)]!;
    this.attempt++;
    this.cancelRetry = this.deps.schedule(() => {
      this.cancelRetry = null;
      void this.connect();
    }, wait);
  }
}

// ── Every machine ────────────────────────────────────────────────────

/** What the routes use: the lists, and the one way a request reaches another machine. */
export interface MachineDirectory {
  /** Every machine for a snapshot about `current` (undefined = this one), or undefined with none saved. */
  views(current: string | undefined, localHerd: MachineHerd | null): MachineView[] | undefined;
  has(session: string): boolean;
  forward(session: string, req: Request, url: URL): Promise<Response>;
  /** The other machine's snapshot body, or null when it is not connected. */
  snapshot(session: string): Promise<Record<string, unknown> | null>;
  /** Re-read Herdr's list if it is older than a minute; never waits. */
  refresh(): void;
  stop(): void;
}

/** The part of a link the directory needs; a test hands in its own. */
export interface LinkHandle {
  start(): void;
  stop(): void;
  view(): MachineView;
  readonly connected?: boolean;
  fetch?(path: string, init?: RequestInit): Promise<Response>;
}

export interface MachinesDeps {
  list(): Promise<HerdrMachine[]>;
  /** This machine's name in the list. */
  hostLabel: string;
  link(machine: HerdrMachine): LinkHandle;
}

const LIST_TTL_MS = 60_000;

// Headers a forwarded request keeps. Identity, cookies and proxy headers stay here: the other side
// trusts the socket, not what a header says.
const FORWARD_REQUEST_HEADERS = ["accept", "accept-encoding", "content-type", "if-none-match", "last-event-id", "x-collie-seen"];
const DROP_RESPONSE_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "x-collie-build"]);

export class Machines implements MachineDirectory {
  private links = new Map<string, { machine: HerdrMachine; link: LinkHandle }>();
  private order: string[] = [];
  private listedAt = 0;
  private listing: Promise<void> | null = null;

  constructor(private readonly deps: MachinesDeps) {}

  refresh(): void {
    if (Date.now() - this.listedAt < LIST_TTL_MS) return;
    void this.reload();
  }

  /** Read Herdr's list now: start a link for a new machine, stop one for a machine no longer there. */
  reload(): Promise<void> {
    this.listing ??= (async () => {
      const machines = await this.deps.list().catch(() => null);
      this.listedAt = Date.now();
      if (!machines) return;
      const key = (m: HerdrMachine) => `${m.id}\u0000${m.label}\u0000${m.target}\u0000${m.session}\u0000${m.enabled}`;
      const next = new Map<string, HerdrMachine>(machines.map((m) => [machineSession(m.label), m]));
      for (const [session, entry] of this.links) {
        const kept = next.get(session);
        if (kept && key(kept) === key(entry.machine)) continue;
        entry.link.stop();
        this.links.delete(session);
      }
      for (const [session, machine] of next) {
        if (this.links.has(session)) continue;
        const link = this.deps.link(machine);
        this.links.set(session, { machine, link });
        link.start();
      }
      this.order = [...next.keys()];
    })().finally(() => { this.listing = null; });
    return this.listing;
  }

  views(current: string | undefined, localHerd: MachineHerd | null): MachineView[] | undefined {
    if (this.order.length === 0) return undefined;
    const here: MachineView = { label: this.deps.hostLabel, state: "connected", ...(current !== undefined && localHerd ? { herd: localHerd } : {}) };
    const others = this.order.map((session) => {
      const view = this.links.get(session)!.link.view();
      if (session !== current) return view;
      const { herd: _herd, ...rest } = view;
      return rest;
    });
    return [here, ...others];
  }

  has(session: string): boolean {
    return this.links.has(session);
  }

  private connectedLink(session: string): { machine: HerdrMachine; link: LinkHandle } | Response {
    const entry = this.links.get(session);
    if (!entry) return Response.json({ error: `unknown machine: ${session}` }, { status: 404 });
    const view = entry.link.view();
    if (view.state !== "connected" || !entry.link.fetch) {
      return Response.json({ error: view.detail ?? `${view.label} is not connected`, machine: view.state }, { status: 503 });
    }
    return entry;
  }

  async forward(session: string, req: Request, url: URL): Promise<Response> {
    const entry = this.connectedLink(session);
    if (entry instanceof Response) return entry;
    const headers = new Headers();
    for (const name of FORWARD_REQUEST_HEADERS) {
      const value = req.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    let res: Response;
    try {
      res = await entry.link.fetch!(forwardTarget(url, entry.machine.session), {
        method: req.method,
        headers,
        body: hasBody ? await req.arrayBuffer() : undefined,
        signal: req.signal,
        redirect: "manual",
        // The bytes and their Content-Encoding pass through as the other Nenu sent them.
        decompress: false,
      } as RequestInit);
    } catch {
      return Response.json({ error: `${entry.machine.label} did not answer` }, { status: 502 });
    }
    const out = new Headers();
    res.headers.forEach((value, name) => { if (!DROP_RESPONSE_HEADERS.has(name)) out.set(name, value); });
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
  }

  async snapshot(session: string): Promise<Record<string, unknown> | null> {
    const entry = this.connectedLink(session);
    if (entry instanceof Response) return null;
    try {
      const res = await entry.link.fetch!(forwardTarget(new URL("http://peer/api/snapshot"), entry.machine.session));
      return res.ok ? await res.json() as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }

  stop(): void {
    for (const { link } of this.links.values()) link.stop();
    this.links.clear();
  }
}

/** The directory a bridge with no saved machines uses (and every in-process test). */
export const NO_MACHINES: MachineDirectory = {
  views: () => undefined,
  has: () => false,
  forward: async () => Response.json({ error: "no machines" }, { status: 404 }),
  snapshot: async () => null,
  refresh: () => {},
  stop: () => {},
};
