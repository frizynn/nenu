import { test, expect } from "bun:test";
import { PaneWrites } from "./pane-writes";
test("refuses concurrent writes on the same pane and releases on failure", async () => {
  const writes = new PaneWrites();
  let release = () => {};
  let calls = 0;
  const first = writes.run(
    "a",
    "p",
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  expect(
    await writes.run("a", "p", async () => {
      calls++;
    }),
  ).toEqual({ busy: true });
  expect(await writes.run("b", "p", async () => 1)).toEqual({
    busy: false,
    value: 1,
  });
  expect(calls).toBe(0);
  release();
  await first;
  await expect(
    writes.run("a", "p", async () => {
      throw new Error("lost ack");
    }),
  ).rejects.toThrow("lost ack");
  expect(await writes.run("a", "p", async () => 2)).toEqual({
    busy: false,
    value: 2,
  });
});
