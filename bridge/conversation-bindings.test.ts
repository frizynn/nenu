import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationBindings } from "./conversation-bindings.ts";

test("recovery survives bridge restart, but not a different process, hook, or Herdr session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nenu-bindings-"));
  try {
    const file = join(dir, "bindings.json");
    const store = new ConversationBindings(file);
    const value = { id: "11111111-2222-3333-4444-555555555555", process: "same-process", hook: "null" };
    await Promise.all([store.set("default:pane", value), store.set("other:pane", { ...value, process: "other-process" })]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const restarted = new ConversationBindings(file);
    expect(restarted.get("default:pane", "same-process", "null")).toBe(value.id);
    expect(restarted.get("other:pane", "other-process", "null")).toBe(value.id);
    expect(restarted.get("default:pane", "new-process", "null")).toBeNull();
    expect(restarted.get("default:pane", "same-process", "null")).toBeNull();
    expect(restarted.get("other:pane", "other-process", "new-hook-id")).toBeNull();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
