import { expect, test } from "bun:test";

import { HcClient } from "./hc-client.ts";

// Every write refuses before anything runs: the binary below would fail if it were ever started.
test("herdr-core writes refuse without running hc", async () => {
  const hc = new HcClient("/nonexistent/hc");
  await expect(hc.sendPaneText("t1", "hi")).rejects.toThrow("read only");
  await expect(hc.sendPaneKeys("t1", ["Enter"])).rejects.toThrow("read only");
  await expect(hc.closePane("t1")).rejects.toThrow("read only");
  await expect(hc.startAgent("t1", "claude")).rejects.toThrow("read only");
  await expect(hc.createWorkspace({ cwd: "/" })).rejects.toThrow("read only");
});
