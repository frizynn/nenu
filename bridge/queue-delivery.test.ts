import { test, expect } from "bun:test";
import { join } from "node:path";
import { deliverQueuedMessage, sendQueuedNow } from "./queue-delivery";
import type { QueuedMessage } from "./message-queue";
import type { SendHerdr } from "./guarded-send";

const row: QueuedMessage = {
  id: "test",
  scope: "scope",
  paneId: "p",
  session: "default",
  conversation: "claude:test",
  agent: "claude",
  text: "A saved message",
  state: "sending",
  createdAt: 0,
  revision: 1,
  device: null,
};
const rule = "─".repeat(60);
const screen = (draft = "") =>
  [
    rule,
    `❯ ${draft}`,
    rule,
    "  Opus 5.5 | Context 13% used",
    "  ← for agents",
  ].join("\n");
const read = (text: string) => ({
  pane_id: "p",
  text,
  revision: 1,
  truncated: false,
});
const noSleep = async () => {};

/** A pane whose screen is `paint()`, recording every key; `write` is the audited reply route. */
function terminal(agent: string, paint: () => string, keys: string[][] = []): SendHerdr {
  return {
    async getPane() {
      return { pane_id: "p", agent } as Awaited<ReturnType<SendHerdr["getPane"]>>;
    },
    async readPane() {
      return read(paint());
    },
    async waitForOutput() {
      return { matched: false };
    },
    async sendPaneText() {
      throw new Error("text goes through the audited write");
    },
    async sendPaneKeys(_id, sent) {
      keys.push(sent);
    },
  } as SendHerdr;
}

test("a connection failure before typing is safe to wait for", async () => {
  let writes = 0;
  const herdr = { ...terminal("claude", screen), async readPane(): Promise<never> { throw new Error("offline"); } } as SendHerdr;
  const result = await deliverQueuedMessage(row, herdr, async () => (writes++, { ok: true }), async () => true, "enter", { sleep: noSleep });
  expect(result.status).toBe("blocked");
  expect(writes).toBe(0);
});

test("an overlay keeps the message out of the terminal", async () => {
  const overlay = [rule, "  New environment setup", "", "  ❯ 1. Yes", "    2. Not now", "", "  Enter to confirm · Esc to cancel", screen()].join("\n");
  let writes = 0;
  const result = await deliverQueuedMessage(row, terminal("claude", () => overlay), async () => (writes++, { ok: true }), async () => true, "enter", { sleep: noSleep });
  expect(result.status).toBe("blocked");
  expect(writes).toBe(0);
});

test("a draft at the terminal is the operator's: the row waits and nothing is swept", async () => {
  const keys: string[][] = [];
  let writes = 0;
  const result = await deliverQueuedMessage(row, terminal("claude", () => screen("half a thought"), keys), async () => (writes++, { ok: true }), async () => true, "enter", { sleep: noSleep });
  expect(result.status).toBe("blocked");
  expect(writes).toBe(0);
  expect(keys).toEqual([]);
});

test("types once through the audited route and confirms the box let go after Enter", async () => {
  let draft = "";
  const writes: { text: string; submit: boolean; paste: boolean }[] = [];
  const result = await deliverQueuedMessage(
    row,
    terminal("claude", () => screen(draft)),
    async (text, submit, _id, paste) => {
      writes.push({ text, submit, paste });
      draft = submit ? "" : text;
      return { ok: true };
    },
    async () => true,
    "enter",
    { sleep: noSleep },
  );
  expect(result.status).toBe("sent");
  expect(writes).toEqual([
    { text: row.text, submit: false, paste: false },
    { text: "", submit: true, paste: false },
  ]);
});

test("a picture goes piece by piece through the audited route, its path pasted alone (ADR 0104)", async () => {
  // The 2026-10-21 report: a queued message with a picture was pasted whole, so Claude drew no
  // `[Image #1]` and the path stayed in its box as text.
  const path = "/home/you/.local/state/nenu/uploads/w1_p1-mvi3xqqi-12f60762.png";
  let draft = "";
  const writes: { text: string; submit: boolean; id: string; paste: boolean }[] = [];
  const result = await deliverQueuedMessage(
    { ...row, text: `${path} look at this` },
    terminal("claude", () => screen(draft)),
    async (text, submit, id, paste) => {
      writes.push({ text, submit, id, paste });
      // Like Claude: a path pasted alone becomes its token, anything else lands as typed.
      draft = submit ? "" : draft + (paste && text === path ? "[Image #1]" : text);
      return { ok: true };
    },
    async () => true,
    "enter",
    { sleep: noSleep },
  );
  expect(result.status).toBe("sent");
  expect(writes.map(({ text, submit, paste }) => ({ text, submit, paste }))).toEqual([
    { text: path, submit: false, paste: true },
    { text: " look at this", submit: false, paste: false },
    { text: "", submit: true, paste: false },
  ]);
  // Each write is its own request: one id for two payloads is a conflict at the reply route.
  expect(new Set(writes.map((w) => w.id)).size).toBe(3);
});

test("a picture that never shows is cleared from the box, so the row may go again", async () => {
  const path = "/home/you/.local/state/nenu/uploads/w1_p1-mvi3xqqi-12f60762.png";
  let draft = "";
  const keys: string[][] = [];
  const herdr = terminal("claude", () => screen(draft), keys);
  herdr.sendPaneKeys = async (_id, sent) => {
    keys.push(sent);
    for (const key of sent) if (key === "Backspace") draft = draft.slice(0, -1);
  };
  const result = await deliverQueuedMessage(
    { ...row, text: `look at this ${path} please` },
    herdr,
    async (text, submit) => {
      // A paste that never lands: the words before it are all the box holds.
      if (!submit && !text.startsWith("/")) draft += text;
      return { ok: true };
    },
    async () => true,
    "enter",
    { sleep: noSleep },
  );
  expect(result).toMatchObject({ status: "blocked", cleared: true });
  expect(draft).toBe("");
  expect(keys.flat()).not.toContain("Enter");
});

test("the queue's clear checks the conversation as its writes do", async () => {
  const path = "/home/you/.local/state/nenu/uploads/w1_p1-mvi3xqqi-12f60762.png";
  let draft = "";
  const keys: string[][] = [];
  let looks = 0;
  const result = await deliverQueuedMessage(
    { ...row, text: `look at this ${path} please` },
    terminal("claude", () => screen(draft), keys),
    async (text, submit) => {
      if (!submit && !text.startsWith("/")) draft += text;
      return { ok: true };
    },
    // The two writes see the conversation; by the clear, the pane runs another one.
    async () => ++looks <= 2,
    "enter",
    { sleep: noSleep },
  );
  expect(result.status).toBe("uncertain");
  expect(looks).toBe(3); // the refusal came at the clear, not at a write
  expect(keys).toEqual([]);
  expect(draft).toBe("look at this ");
});

test("Enter acknowledgement with a stranded draft is uncertain and never types twice", async () => {
  let draft = "";
  let types = 0;
  const result = await deliverQueuedMessage(
    row,
    terminal("claude", () => screen(draft)),
    async (text, submit) => {
      if (!submit) {
        draft = text;
        types++;
      }
      return { ok: true };
    },
    async () => true,
    "enter",
    { sleep: noSleep },
  );
  expect(result.status).toBe("uncertain");
  expect(types).toBe(1);
});

test("a conversation that changed before typing types nothing", async () => {
  let writes = 0;
  const result = await deliverQueuedMessage(row, terminal("claude", () => screen()), async () => (writes++, { ok: true }), async () => false, "enter", { sleep: noSleep });
  expect(result.status).toBe("blocked");
  expect(writes).toBe(0);
});

test("a second message reaches Claude's own queue while the first waits there (P0 working-queued)", async () => {
  const fixture = await Bun.file(join(import.meta.dir, "..", "web", "src", "lib", "harness", "claude", "fixtures", "working-queued-v2296.txt")).text();
  // The fixture's input box shows the queue's placeholder; typed text replaces it until Enter.
  let draft = "";
  const paint = () => (draft ? fixture.replace(/❯[^\n]*Press up to edit queued messages[^\n]*/, `❯ ${draft}`) : fixture);
  const writes: string[] = [];
  const result = await deliverQueuedMessage(
    { ...row, text: "Then say KIWI." },
    terminal("claude", paint),
    async (text, submit) => {
      writes.push(submit ? "Enter" : text);
      draft = submit ? "" : text;
      return { ok: true };
    },
    async () => true,
    "enter",
    { sleep: noSleep },
  );
  expect(result.status).toBe("sent");
  expect(writes).toEqual(["Then say KIWI.", "Enter"]);
});

test("Codex's next-turn queue: bracketed paste through the audited route, then Tab", async () => {
  const codex: QueuedMessage = { ...row, agent: "codex", conversation: "codex:test", text: "After this turn, run the tests." };
  const busy = await Bun.file(join(import.meta.dir, "..", "web", "src", "fixtures", "panes", "codex--v0159-busy.txt")).text();
  const draftFixture = await Bun.file(join(import.meta.dir, "..", "web", "src", "lib", "harness", "codex", "fixtures", "busy-draft-v0160.txt")).text();
  let typed = false;
  const keys: string[][] = [];
  const writes: { text: string; paste: boolean }[] = [];
  const paint = () => (typed ? draftFixture.replace("Also say BANANA at the end.", codex.text) : busy);
  const herdr = terminal("codex", paint, keys);
  herdr.sendPaneKeys = async (_id, sent) => {
    keys.push(sent);
    typed = false;
  };
  const result = await deliverQueuedMessage(
    codex,
    herdr,
    async (text, submit, _id, paste) => {
      writes.push({ text, paste });
      if (!submit) typed = true;
      return { ok: true };
    },
    async () => true,
    "tab",
    { sleep: noSleep },
  );
  expect(result.status).toBe("sent");
  expect(writes).toEqual([{ text: codex.text, paste: true }]);
  expect(keys).toEqual([["Tab"]]);
});

test("read it now: Ctrl+Enter only into an empty input box", async () => {
  const keys: string[][] = [];
  expect(await sendQueuedNow("p", "claude", ["ctrl+enter"], terminal("claude", () => screen(), keys))).toEqual({ ok: true });
  expect(keys).toEqual([["ctrl+enter"]]);
  expect((await sendQueuedNow("p", "claude", ["ctrl+enter"], terminal("claude", () => screen("draft"), keys))).ok).toBe(false);
  expect(keys).toHaveLength(1);
});

test("a dialog Claude's own state reports keeps the row out of the terminal (ADR 0117)", async () => {
  let writes = 0;
  const turn = () => ({ running: false, waiting: "permission prompt" });
  const result = await deliverQueuedMessage(row, terminal("claude", screen), async () => (writes++, { ok: true }), async () => true, "enter", { sleep: noSleep, turn });
  expect(result.status).toBe("blocked");
  expect(writes).toBe(0);
});
