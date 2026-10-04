import { expect, test } from "bun:test";
import { structuralFixture as fixture } from "./structural-fixture.test-support.ts";

for (const target of ["pane", "tab"] as const) {
  test(`${target} rename is visible in the first snapshot after its HTTP acknowledgement`, async () => {
    const app = await fixture();
    try {
      await app.action(`/api/${target}/${target === "pane" ? "w:p" : "tab"}/rename`, { label: "After" });
      const snapshot = await app.snapshot();
      expect(target === "pane" ? snapshot.agents[0].paneLabel : snapshot.tabs[0].label).toBe("After");
    } finally { await app.dispose(); }
  });
  test(`${target} close is absent in the first snapshot after its HTTP acknowledgement`, async () => {
    const app = await fixture();
    try {
      await app.action(`/api/${target}/${target === "pane" ? "w:p" : "tab"}/close`);
      const snapshot = await app.snapshot();
      expect(snapshot.agents).toEqual([]);
      if (target === "tab") expect(snapshot.tabs).toEqual([]);
    } finally { await app.dispose(); }
  });
}

// A write was already accepted by Herdr. A subsequent read failure cannot invite a duplicate.
test("acknowledges a completed mutation even if refreshing metadata fails", async () => {
  const app = await fixture();
  try {
    app.failReads();
    await app.action("/api/pane/w:p/rename", { label: "After" });
    expect(app.engine.current().bridge).toBe("disconnected");
  } finally { await app.dispose(); }
});
