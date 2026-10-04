import { structuralFixture } from "../../bridge/structural-fixture.test-support.ts";

// Isolated loopback HTTP server, fake Herdr, no operator sessions or terminal messages.
const rows: { action: string; ms: number }[] = [];
for (const target of ["pane", "tab"] as const) {
  for (const action of ["rename", "close"] as const) {
    for (let run = 0; run < 3; run++) {
      const app = await structuralFixture();
      try {
        const start = performance.now();
        await app.action(`/api/${target}/${target === "pane" ? "w:p" : "tab"}/${action}`, action === "rename" ? { label: "After" } : undefined);
        // Close emits an event in Herdr; reproduce its existing 200ms debounce.
        if (action === "close") setTimeout(() => app.engine.pokeNow(), 200);
        while (true) {
          const state = await app.snapshot();
          const visible = action === "close" ? state.agents.length === 0
            : target === "pane" ? state.agents[0]?.paneLabel === "After" : state.tabs[0]?.label === "After";
          if (visible) break;
          if (performance.now() - start > 15_000) throw new Error("No convergence within 15 seconds");
          await Bun.sleep(20);
        }
        rows.push({ action: `${target}.${action}`, ms: +(performance.now() - start).toFixed(2) });
      } finally { await app.dispose(); }
    }
  }
}
console.log(JSON.stringify({ scope: "Controlled real HTTP routes, fake Herdr; 12s cadence, 200ms close event debounce; not phone latency", rows }, null, 2));
