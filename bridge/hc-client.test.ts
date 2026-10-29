import { describe, expect, test } from "bun:test";

import { HcClient, hcSend, type HcRpc } from "./hc-client.ts";

/** An HcClient over a recorded fake `hc connect`, never a real one. */
function client(start = 0) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  let clock = start;
  const rpc: HcRpc = async <T>(method: string, params: Record<string, unknown>) => {
    calls.push([method, params]);
    return { turn: 1 } as T;
  };
  return { hc: new HcClient("/nonexistent/hc", 5000, rpc, () => clock), calls, advance: (ms: number) => (clock += ms) };
}

describe("HcClient chat writes", () => {
  test("typed text goes with its Enter as one terminal.send, without the paste markers", async () => {
    const { hc, calls } = client();
    await hc.sendPaneText("box:t2", "\x1b[200~hello\nthere\x1b[201~");
    expect(calls).toEqual([]);
    await hc.sendPaneKeys("box:t2", ["Enter"]);
    expect(calls).toEqual([["terminal.send", { terminal: "box/t2", text: "hello\nthere" }]]);
  });

  test("pieces typed one after another go as one message", async () => {
    const { hc, calls } = client();
    await hc.sendPaneText("t1", "look at ");
    await hc.sendPaneText("t1", "\x1b[200~/tmp/a.png\x1b[201~");
    await hc.sendPaneKeys("t1", ["Enter"]);
    expect(calls).toEqual([["terminal.send", { terminal: "t1", text: "look at /tmp/a.png" }]]);
  });

  test("keys with nothing held map onto hc's names", async () => {
    const { hc, calls } = client();
    await hc.sendPaneKeys("t1", ["Escape", "shift+tab", "Up", "ctrl+c", "2", "Enter"]);
    expect(calls).toEqual([["terminal.keys", { terminal: "t1", keys: ["esc", "shift+tab", "up", "ctrl+c", "2", "enter"] }]]);
  });

  test("keys other than a submit drop held text instead of sending it", async () => {
    const { hc, calls } = client();
    await hc.sendPaneText("t1", "draft");
    await hc.sendPaneKeys("t1", ["ctrl+k", "Backspace"]);
    await hc.sendPaneKeys("t1", ["Enter"]);
    expect(calls).toEqual([
      ["terminal.keys", { terminal: "t1", keys: ["ctrl+k", "backspace"] }],
      ["terminal.keys", { terminal: "t1", keys: ["enter"] }],
    ]);
  });

  test("held text that waited too long for its Enter is never sent", async () => {
    const { hc, calls, advance } = client();
    await hc.sendPaneText("t1", "late");
    advance(21_000);
    await hc.sendPaneKeys("t1", ["Enter"]);
    expect(calls).toEqual([["terminal.keys", { terminal: "t1", keys: ["enter"] }]]);
  });
});

// Closing, renaming and moving still refuse before anything runs.
test("structural writes refuse without calling hc", async () => {
  const { hc, calls } = client();
  await expect(hc.closePane("t1")).rejects.toThrow("cannot do this on herdr-core");
  await expect(hc.renameTab("tb1", "x")).rejects.toThrow("cannot do this on herdr-core");
  await expect(hc.moveTab("tb1", 0)).rejects.toThrow("cannot do this on herdr-core");
  expect(calls).toEqual([]);
});

describe("hcSend", () => {
  const request = { text: "\x1b[200~hi\x1b[201~", requestId: "r1" };

  test("one terminal.send is the whole send", async () => {
    const sent: string[] = [];
    const r = await hcSend({ sendMessage: async (_pane, text) => { sent.push(text); return { turn: 1, started: true } } }, "t1", request);
    expect(sent).toEqual(["\x1b[200~hi\x1b[201~"]);
    expect(r.outcome).toEqual({ ok: true, requestId: "r1", ack: "submitted" });
  });

  test("a blocked agent refuses before anything is typed", async () => {
    const err = new Error('hc terminal.send: {"code":-32000,"data":{"kind":"blocked"},"message":"blocked"}');
    const r = await hcSend({ sendMessage: async () => { throw err; } }, "t1", request);
    expect(r.outcome).toMatchObject({ ok: false, code: "not_ready", textDelivered: false });
  });

  test("any other failure may have typed, and a retry of that id types nothing", async () => {
    let calls = 0;
    const hc = { sendMessage: async () => { calls++; throw new Error("hc terminal.send: connection closed before reply"); } };
    expect((await hcSend(hc, "t1", request)).outcome).toMatchObject({ ok: false, textDelivered: true });
    expect((await hcSend(hc, "t1", request, { typeAttempted: true })).outcome).toMatchObject({ ok: false, textDelivered: true });
    expect(calls).toBe(1);
  });
});

describe("HcClient reads", () => {
  function reader(terminals: unknown[]) {
    const asked: number[] = [];
    const rpc: HcRpc = async <T>(method: string, params: Record<string, unknown>) => {
      if (method === "terminal.list") return { terminals } as T;
      if (method === "doc.get") return { value: null } as T;
      asked.push(params.lines as number);
      if ((params.lines as number) > 0) throw new Error("hc terminal.read: connection closed before reply");
      return { text: "screen", complete: true } as T;
    };
    return { hc: new HcClient("/nonexistent/hc", 5000, rpc), asked };
  }

  test("an agent's screen is read without history", async () => {
    const { hc, asked } = reader([{ address: "t1", state: "live", cwd: "/", status: { app: "claude-code", state: "blocked" } }]);
    await hc.sessionSnapshot();
    expect(await hc.readPane("t1", "recent", 200)).toEqual({ pane_id: "t1", text: "screen", truncated: false, revision: 0 });
    expect(asked).toEqual([0]);
  });

  test("a shell's history read that hc never answers falls back to the screen, marked truncated", async () => {
    const { hc, asked } = reader([{ address: "t2", state: "live", cwd: "/", status: null }]);
    await hc.sessionSnapshot();
    expect(await hc.readPane("t2", "recent", 200)).toEqual({ pane_id: "t2", text: "screen", truncated: true, revision: 0 });
    expect(asked).toEqual([200, 0]);
  });
});

describe("HcClient new terminals", () => {
  function fake(terminals: Record<string, unknown>[] = []) {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const rpc: HcRpc = async <T>(method: string, params: Record<string, unknown>) => {
      calls.push([method, params]);
      if (method === "terminal.list") return { terminals } as T;
      if (method === "doc.get") return { value: null } as T;
      if (method === "terminal.get") return terminals.find((t) => t.address === params.terminal) as T;
      if (method === "terminal.run") {
        const on = params.on as string | undefined;
        return { address: on ? "t9" : "t8", state: "live", cwd: params.cwd, labels: params.labels } as T;
      }
      return { turn: 1 } as T;
    };
    return { hc: new HcClient("/nonexistent/hc", 5000, rpc), calls };
  }
  const placed = { address: "box/t2", state: "live", cwd: "/w", labels: { "herdr.space": "sp1", "herdr.tab": "tb1", where: "app / 1" }, status: { app: "claude-code", state: "idle" } };

  test("a new space gets Herdr.app's labels and its name in `where`", async () => {
    const { hc, calls } = fake();
    const shell = await hc.createWorkspace({ cwd: "/Users/u/repo" });
    const [, params] = calls.find(([m]) => m === "terminal.run")!;
    const labels = params.labels as Record<string, string>;
    expect(labels["herdr.space"]).toMatch(/^sp[0-9a-f]{32}$/);
    expect(labels["herdr.tab"]).toMatch(/^tb[0-9a-f]{32}$/);
    expect(labels.where).toBe("repo / 1");
    expect(shell).toEqual({ paneId: "t8", workspaceId: labels["herdr.space"]!, workspaceLabel: "repo", tabId: labels["herdr.tab"]!, cwd: "/Users/u/repo" });
  });

  test("a new tab lands in its space, on that space's machine, in its folder", async () => {
    const { hc, calls } = fake([placed]);
    const shell = await hc.createTab("box:sp1", { label: "tests" });
    const [, params] = calls.find(([m]) => m === "terminal.run")!;
    expect(params).toMatchObject({ on: "box", cwd: "/w", labels: { "herdr.space": "sp1", where: "app / tests" } });
    expect((params.labels as Record<string, string>)["herdr.tab"]).not.toBe("tb1");
    expect(shell).toMatchObject({ paneId: "box:t9", workspaceId: "box:sp1" });
  });

  test("a split stays in the pane's tab", async () => {
    const { hc, calls } = fake([placed]);
    await hc.splitTab("box:t2");
    expect(calls.find(([m]) => m === "terminal.run")![1]).toMatchObject({ on: "box", labels: { "herdr.space": "sp1", "herdr.tab": "tb1" } });
  });

  test("an agent starts only in a shell at rest, typed as one quoted line", async () => {
    const shell = { address: "t3", state: "live", cwd: "/", status: null, foreground: { pid: 1, name: "zsh", argv: ["-zsh"], cwd: "/" } };
    const busy = { ...shell, address: "t4", foreground: { pid: 2, name: "vim", argv: ["vim"], cwd: "/" } };
    const { hc, calls } = fake([shell, busy]);
    await hc.startAgent("t3", "claude", ["--session-id", "abc", "--model", "it's"]);
    expect(calls.find(([m]) => m === "terminal.send")![1]).toEqual({ terminal: "t3", text: "claude --session-id abc --model 'it'\\''s'" });
    await expect(hc.startAgent("t4", "claude")).rejects.toThrow("not at a shell prompt");
  });
});

test("a Claude on another machine gets its conversation id from that machine's session file", async () => {
  const remote = { address: "box/t2", state: "live", cwd: "/w", status: { app: "claude-code", state: "idle" }, foreground: { pid: 42, name: "claude", argv: ["claude"], cwd: "/w" } };
  const reads: Array<Record<string, unknown>> = [];
  const rpc: HcRpc = async <T>(method: string, params: Record<string, unknown>) => {
    if (method === "terminal.list") return { terminals: [remote], machines: [{ name: "box", state: "connected" }] } as T;
    if (method === "doc.get") return { value: null } as T;
    if (method === "file.read") {
      reads.push(params);
      return { text: '{"sessionId":"remote-1"}' } as T;
    }
    throw new Error(`unexpected ${method}`);
  };
  const snap = await new HcClient("/nonexistent/hc", 5000, rpc, Date.now, () => { throw new Error("no local group for a remote pid"); }).sessionSnapshot();
  expect(reads).toEqual([{ path: ".claude/sessions/42.json", on: "box" }]);
  expect(snap.panes[0]!.agent_session).toEqual({ agent: "claude", kind: "id", value: "remote-1" });
});
