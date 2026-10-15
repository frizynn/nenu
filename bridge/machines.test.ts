import { describe, expect, test } from "bun:test";

import {
  forwardTarget,
  isMachineSession,
  MachineLink,
  Machines,
  machineSession,
  parseMachineList,
  parseProbe,
  probeArgv,
  tunnelArgv,
  type LinkDeps,
  type SpawnedProcess,
} from "./machines.ts";
import type { MachineHerd } from "./types.ts";

const LIST = JSON.stringify([
  { id: "a1b2c3d4e5f60718293a4b5c6d7e8f90", label: "build-box", target: "user@build-box", session: "default", enabled: true, selected: false },
  { id: "ffeeddccbbaa99887766554433221100", label: "studio", target: "studio", session: "work", enabled: false, selected: false },
]);

describe("Herdr's saved machines", () => {
  test("parse `herdr machine list --json`", () => {
    expect(parseMachineList(LIST)).toEqual([
      { id: "a1b2c3d4e5f60718293a4b5c6d7e8f90", label: "build-box", target: "user@build-box", session: "default", enabled: true },
      { id: "ffeeddccbbaa99887766554433221100", label: "studio", target: "studio", session: "work", enabled: false },
    ]);
  });

  test("anything else is no machines, never a throw", () => {
    expect(parseMachineList("")).toEqual([]);
    expect(parseMachineList("error: unrecognized subcommand 'machine'")).toEqual([]);
    expect(parseMachineList(JSON.stringify([{ id: "x" }, { label: "y", target: "y" }]))).toEqual([]);
  });

  test("a machine's session starts with @, which no Herdr session name can", () => {
    // Herdr: "session name may only contain ASCII letters, numbers, '.', '_' and '-'".
    expect(machineSession("build-box")).toBe("@build-box");
    expect(isMachineSession("@build-box")).toBe(true);
    expect(isMachineSession("default")).toBe(false);
    expect(isMachineSession(undefined)).toBe(false);
  });
});

describe("the SSH commands", () => {
  test("probe and tunnel use the operator's own ssh config and keys, never prompt and never trust a new host key", () => {
    for (const argv of [probeArgv("user@build-box"), tunnelArgv("user@build-box", "/s/m.sock", "/home/u/.local/state/collie/peer.sock")]) {
      expect(argv[0]).toBe("ssh");
      expect(argv).not.toContain("-F");
      expect(argv.join(" ")).toContain("BatchMode=yes");
      expect(argv.join(" ")).toContain("StrictHostKeyChecking=yes");
      // The target comes after `--`, so a target that starts with a dash is never read as an option.
      expect(argv[argv.indexOf("--") + 1]).toBe("user@build-box");
    }
  });

  test("the tunnel forwards a local socket to the other Nenu's socket and lives only as long as its stdin", () => {
    const argv = tunnelArgv("build-box", "/s/m.sock", "/home/u/.local/state/collie/peer.sock");
    expect(argv).toContain("-L");
    expect(argv[argv.indexOf("-L") + 1]).toBe("/s/m.sock:/home/u/.local/state/collie/peer.sock");
    expect(argv.join(" ")).toContain("ExitOnForwardFailure=yes");
    expect(argv.join(" ")).toContain("StreamLocalBindUnlink=yes");
    // No -N: the remote command waits on stdin, so the bridge dying (even by SIGKILL) closes it and ssh exits.
    expect(argv).not.toContain("-N");
    expect(argv.at(-1)).toContain("cat");
  });

  test("the probe tells a Nenu that takes other machines from an older one and from none", () => {
    expect(parseProbe("Welcome!\nnenu-peer /home/u/.local/state/collie/peer.sock\n")).toEqual({ kind: "peer", path: "/home/u/.local/state/collie/peer.sock" });
    expect(parseProbe("nenu-old\n")).toEqual({ kind: "old" });
    expect(parseProbe("nenu-none\n")).toEqual({ kind: "none" });
    expect(parseProbe("")).toEqual({ kind: "none" });
  });

  test("a forwarded request keeps its path and query, minus the machine's session", () => {
    const url = new URL("http://h/api/events?session=%40build-box&watch=w1%3Ap1&watch=w1%3Ap2");
    expect(forwardTarget(url, "default")).toBe("/api/events?watch=w1%3Ap1&watch=w1%3Ap2");
    expect(forwardTarget(new URL("http://h/api/pane/w1%3Ap1/send?session=%40build-box"), "work")).toBe("/api/pane/w1%3Ap1/send?session=work");
  });
});

// ── A link's life, with ssh and the other Nenu faked ─────────────────

interface FakeProc extends SpawnedProcess {
  argv: string[];
  out(text: string): void;
  exit(code: number, stderr?: string): void;
  killed: boolean;
}

function fakeProc(argv: string[]): FakeProc {
  let outCtl!: ReadableStreamDefaultController<Uint8Array>;
  let errCtl!: ReadableStreamDefaultController<Uint8Array>;
  let resolveExit!: (code: number) => void;
  const enc = new TextEncoder();
  const proc: FakeProc = {
    argv,
    killed: false,
    stdout: new ReadableStream({ start(c) { outCtl = c; } }),
    stderr: new ReadableStream({ start(c) { errCtl = c; } }),
    exited: new Promise<number>((resolve) => { resolveExit = resolve; }),
    out(text) { outCtl.enqueue(enc.encode(text)); },
    exit(code, stderr = "") {
      if (stderr) errCtl.enqueue(enc.encode(stderr));
      outCtl.close();
      errCtl.close();
      resolveExit(code);
    },
    kill() { proc.killed = true; proc.exit(143); },
  };
  return proc;
}

const HERD: MachineHerd = {
  bridge: "connected",
  agents: [{ paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1", agent: "claude", status: "idle" } as MachineHerd["agents"][number]],
  shellPanes: [],
  workspaces: [{ workspaceId: "w1", number: 1, label: "api", focused: false, activeTabId: "w1:t1", tabCount: 1, paneCount: 1 }],
  tabs: [],
};

function harness() {
  const procs: FakeProc[] = [];
  const timers: Array<{ ms: number; fn: () => void }> = [];
  const requests: string[] = [];
  let changes = 0;
  const events = new TransformStream<Uint8Array, Uint8Array>();
  const deps: LinkDeps = {
    spawn: (argv) => { const p = fakeProc(argv); procs.push(p); return p; },
    socketDir: "/state/machines",
    async fetchPeer(_socket, path) {
      requests.push(path);
      if (path.startsWith("/api/events")) return new Response(events.readable, { headers: { "content-type": "text/event-stream" } });
      return Response.json({ ...HERD, projects: [{ slug: "x" }], update: { releaseAvailable: true } }, { headers: { etag: "\"1\"" } });
    },
    schedule(fn, ms) { const t = { ms, fn }; timers.push(t); return () => { timers.splice(timers.indexOf(t), 1); }; },
    onChange() { changes++; },
  };
  const link = new MachineLink({ id: "a1b2c3d4e5f60718293a4b5c6d7e8f90", label: "build-box", target: "build-box", session: "default", enabled: true }, deps);
  return { link, deps, procs, timers, requests, events, changes: () => changes };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("a machine's link", () => {
  test("SSH that does not get there leaves the machine offline with ssh's own reason, and tries again later", async () => {
    const h = harness();
    h.link.start();
    expect(h.link.view().state).toBe("connecting");
    h.procs[0]!.exit(255, "ssh: connect to host build-box port 22: Connection refused\r\n");
    await tick();
    expect(h.link.view()).toMatchObject({ state: "offline", detail: "ssh: connect to host build-box port 22: Connection refused" });
    expect(h.timers.map((t) => t.ms)).toEqual([5_000]);
  });

  test("an older Nenu there says to update it; no Nenu says so", async () => {
    const old = harness();
    old.link.start();
    old.procs[0]!.out("nenu-old\n");
    old.procs[0]!.exit(0);
    await tick();
    expect(old.link.view().state).toBe("old-nenu");
    const none = harness();
    none.link.start();
    none.procs[0]!.out("nenu-none\n");
    none.procs[0]!.exit(0);
    await tick();
    expect(none.link.view().state).toBe("no-nenu");
  });

  test("a found Nenu gets one tunnel; once it is up the herd is read, and only what the lists need is kept", async () => {
    const h = harness();
    h.link.start();
    h.procs[0]!.out("nenu-peer /home/u/.local/state/collie/peer.sock\n");
    h.procs[0]!.exit(0);
    await tick();
    expect(h.procs).toHaveLength(2);
    const tunnel = h.procs[1]!;
    expect(tunnel.argv[tunnel.argv.indexOf("-L") + 1]).toBe("/state/machines/m-a1b2c3d4e5f6.sock:/home/u/.local/state/collie/peer.sock");
    tunnel.out("nenu-tunnel-ready\n");
    await tick();
    await tick();
    expect(h.link.view()).toEqual({ session: "@build-box", label: "build-box", state: "connected", herd: HERD });
    expect(h.requests).toContain("/api/snapshot");
    expect(h.requests.some((r) => r.startsWith("/api/events"))).toBe(true);
    expect(h.changes()).toBeGreaterThan(0);
  });

  test("the other Nenu naming a snapshot change re-reads its herd: no polling", async () => {
    const h = harness();
    h.link.start();
    h.procs[0]!.out("nenu-peer /p.sock\n");
    h.procs[0]!.exit(0);
    await tick();
    h.procs[1]!.out("nenu-tunnel-ready\n");
    await tick();
    await tick();
    const reads = h.requests.filter((r) => r === "/api/snapshot").length;
    const writer = h.events.writable.getWriter();
    await writer.write(new TextEncoder().encode('data: {"topic":"pane","paneId":"w1:p1"}\n\ndata: {"topic":"snapshot"}\n\n'));
    await tick();
    expect(h.requests.filter((r) => r === "/api/snapshot").length).toBe(reads + 1);
    expect(h.timers).toHaveLength(0);
  });

  test("the tunnel dying leaves it offline and schedules one retry; stop() kills the tunnel", async () => {
    const h = harness();
    h.link.start();
    h.procs[0]!.out("nenu-peer /p.sock\n");
    h.procs[0]!.exit(0);
    await tick();
    h.procs[1]!.exit(255, "Connection to build-box closed by remote host.\n");
    await tick();
    expect(h.link.view().state).toBe("offline");
    expect(h.timers).toHaveLength(1);
    h.link.stop();
    expect(h.timers).toHaveLength(0);

    const live = harness();
    live.link.start();
    live.procs[0]!.out("nenu-peer /p.sock\n");
    live.procs[0]!.exit(0);
    await tick();
    live.link.stop();
    expect(live.procs[1]!.killed).toBe(true);
  });

  test("a machine Herdr has disabled is listed and never dialled", () => {
    const h = harness();
    const link = new MachineLink({ id: "ff", label: "studio", target: "studio", session: "default", enabled: false }, h.deps);
    link.start();
    expect(link.view()).toEqual({ session: "@studio", label: "studio", state: "disabled", detail: "Disabled in Herdr" });
    expect(h.procs).toHaveLength(0);
  });
});

describe("the machine list", () => {
  test("no saved machines: no list at all, so one machine looks as it always did", async () => {
    const machines = new Machines({ list: async () => [], hostLabel: "studio", link: () => { throw new Error("no link"); } });
    await machines.refresh();
    expect(machines.views(undefined, null)).toBeUndefined();
  });

  test("this machine first; the one the snapshot is about carries no herd", async () => {
    const herd = (label: string) => ({ ...HERD, workspaces: [{ ...HERD.workspaces[0]!, label }] });
    const machines = new Machines({
      list: async () => parseMachineList(LIST),
      hostLabel: "studio",
      link: (m) => ({ start() {}, stop() {}, view: () => ({ session: machineSession(m.label), label: m.label, state: "connected" as const, herd: herd(m.label) }) }),
    });
    await machines.refresh();
    const local = herd("here");
    expect(machines.views(undefined, local)!.map((v) => [v.label, v.session, v.herd?.workspaces[0]?.label])).toEqual([
      ["studio", undefined, undefined],
      ["build-box", "@build-box", "build-box"],
      ["studio", "@studio", "studio"],
    ]);
    expect(machines.views("@build-box", local)!.map((v) => [v.label, v.herd?.workspaces[0]?.label])).toEqual([
      ["studio", "here"],
      ["build-box", undefined],
      ["studio", "studio"],
    ]);
  });
});
