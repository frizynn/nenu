// bun scripts/history-response-bench.ts history-page.json [another-page.json]
// Supply local /history responses. Output contains timings and sizes, never transcript content.
import { historyResponse } from "../bridge/history-response.ts";
import type { PaneHistoryResponse } from "../bridge/types.ts";

const files = process.argv.slice(2);
if (!files.length) throw new Error("Pass at least one local history response JSON file");
const results = [];
for (const [index, file] of files.entries()) {
  const data = await Bun.file(file).json() as PaneHistoryResponse;
  if (!data.available) throw new Error(`Input ${index + 1} has no history`);
  const { paneId: _pane, available: _available, sessionKey: _session, ...page } = data;
  const cases = [];
  for (const changed of [false, true]) {
    const rounds = [];
    for (let round = 0; round < 3; round++) {
      const start = performance.now();
      let bytes = 0;
      for (let read = 0; read < 100; read++) {
        const source = changed ? { ...page } : page;
        bytes += (await historyResponse(source, "benchmark", null, "gzip").arrayBuffer()).byteLength;
      }
      rounds.push({ ms: performance.now() - start, bytes });
    }
    cases.push({ changed, rounds });
  }
  results.push({ input: index + 1, entries: page.entries.length, cases });
}
console.log(JSON.stringify(results, null, 2));
