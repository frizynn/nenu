import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptEntry } from "../journal/types.ts";
import { filePaneActions } from "./files.ts";
import type { PaneRouteRequest, Services } from "./context.ts";

let dir: string | undefined;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

test("repeated /file requests scan mentioned folders once per entries array and refresh on a new array", async () => {
  dir = await mkdtemp(join(tmpdir(), "nenu-file-scope-"));
  const folder = join(dir, "repo");
  await mkdir(folder);
  await writeFile(join(folder, "notes.md"), "notes");
  let scans = 0;
  const entry: TranscriptEntry = {
    uuid: "message", ts: "", role: "assistant",
    parts: [{ kind: "text", get text() { scans++; return `Working in ${folder}`; } }],
  };
  let entries = [entry];
  const pane = { paneId: "p", agent: "claude", agentSession: "session", cwd: dir };
  // Only the scope's dependencies: no socket, process, server, or live transcript is involved.
  const services = {
    cfg: { transcript: true, stateDir: join(dir, "state") },
    conversations: { resolve: async () => pane },
    journals: { claude: {} },
    transcripts: { page: async () => ({ entries }) },
  } as unknown as Services;
  const req = new Request("http://localhost/api/pane/p/file?path=notes.md");
  const request = {
    req, url: new URL(req.url), paneId: "p",
    rt: { engine: { current: () => ({ agents: [pane], shellPanes: [] }) } },
  } as unknown as PaneRouteRequest;
  for (let i = 0; i < 3; i++) {
    const response = await filePaneActions.file!.handle(services, request);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("notes");
  }
  expect(scans).toBe(1);
  entries = [entry];
  const refreshed = await filePaneActions.file!.handle(services, request);
  expect(await refreshed.text()).toBe("notes");
  expect(scans).toBe(2);
});
