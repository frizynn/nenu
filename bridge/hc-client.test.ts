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

// The writes the chat does not need still refuse before anything runs.
test("structural writes refuse without calling hc", async () => {
  const { hc, calls } = client();
  await expect(hc.closePane("t1")).rejects.toThrow("read only");
  await expect(hc.startAgent("t1", "claude")).rejects.toThrow("read only");
  await expect(hc.createWorkspace({ cwd: "/" })).rejects.toThrow("read only");
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
