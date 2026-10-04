import { test, expect } from "bun:test";
import { deliverQueuedMessage } from "./queue-delivery";
import type { QueuedMessage } from "./message-queue";
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
test("a connection failure before typing is safe to wait for", async () => {
  let writes = 0;
  const result = await deliverQueuedMessage(
    row,
    {
      async readPane() {
        throw new Error("offline");
      },
    },
    async () => {
      writes++;
      return { ok: true };
    },
    async () => true,
    async () => {},
  );
  expect(result.status).toBe("blocked");
  expect(writes).toBe(0);
});
test("an overlay keeps the message out of the terminal", async () => {
  const overlay = [
    rule,
    "  New environment setup",
    "",
    "  ❯ 1. Yes",
    "    2. Not now",
    "",
    "  Enter to confirm · Esc to cancel",
    screen(),
  ].join("\n");
  let writes = 0;
  const result = await deliverQueuedMessage(
    row,
    {
      async readPane() {
        return read(overlay);
      },
    },
    async () => {
      writes++;
      return { ok: true };
    },
    async () => true,
    async () => {},
  );
  expect(result.status).toBe("blocked");
  expect(writes).toBe(0);
});
test("types once and confirms consumption after Enter", async () => {
  let draft = "";
  const writes: { text: string; submit: boolean }[] = [];
  const result = await deliverQueuedMessage(
    row,
    {
      async readPane() {
        return read(screen(draft));
      },
    },
    async (text, submit) => {
      writes.push({ text, submit });
      draft = submit ? "" : text;
      return { ok: true };
    },
    async () => true,
    async () => {},
  );
  expect(result.status).toBe("sent");
  expect(writes).toEqual([
    { text: row.text, submit: false },
    { text: "", submit: true },
  ]);
});
test("Enter acknowledgement with a stranded draft is uncertain and never types twice", async () => {
  let draft = "";
  let types = 0;
  const result = await deliverQueuedMessage(
    row,
    {
      async readPane() {
        return read(screen(draft));
      },
    },
    async (text, submit) => {
      if (!submit) {
        draft = text;
        types++;
      }
      return { ok: true };
    },
    async () => true,
    async () => {},
  );
  expect(result.status).toBe("uncertain");
  expect(types).toBe(1);
});
