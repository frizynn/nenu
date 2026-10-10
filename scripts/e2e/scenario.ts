import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { FakeHerdr } from "../../bridge/test-support/fake-herdr.ts";

// The demo herd every e2e run starts from: one Claude pane working (screen ticking, journal
// growing), one idle, one blocked on a real captured permission dialog, a Codex pane and a shell.
// Content is synthetic; the dialog comes from the repo's own fixture corpus.

export interface DemoHerd {
  working: string;
  idle: string;
  blocked: string;
  codex: string;
  shell: string;
  /** Claude journal file per pane id. */
  journals: Map<string, string>;
  dialog: string;
}

const FIXTURES = resolve(import.meta.dir, "../../web/src/fixtures/panes");
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** The dialog half of a captured screen: everything below its last horizontal rule. */
export async function fixtureDialog(name: string): Promise<string> {
  const rows = stripAnsi(await readFile(join(FIXTURES, `${name}.txt`), "utf8")).trimEnd().split("\n");
  const rule = rows.findLastIndex((r) => /^─{20,}/.test(r));
  return rows.slice(rule + 1).join("\n");
}

let seq = 0;
function journalRow(type: "user" | "assistant", text: string, parentUuid: string | null): { uuid: string; line: string } {
  const uuid = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  const message = type === "user" ? { role: "user", content: text } : { role: "assistant", content: [{ type: "text", text }] };
  return { uuid, line: JSON.stringify({ type, uuid, parentUuid, timestamp: new Date().toISOString(), message }) + "\n" };
}

async function writeJournal(file: string, turns: Array<["user" | "assistant", string]>): Promise<string | null> {
  let parent: string | null = null;
  let body = "";
  for (const [type, text] of turns) {
    const row = journalRow(type, text, parent);
    body += row.line;
    parent = row.uuid;
  }
  await writeFile(file, body);
  return parent;
}

export async function seedDemoHerd(fake: FakeHerdr, opts: { claudeRoot: string; cwd: string }): Promise<DemoHerd> {
  const projectDir = join(opts.claudeRoot, "-tmp-nenu-e2e");
  await mkdir(projectDir, { recursive: true });
  const ids = { working: "w1:working", idle: "w1:idle", blocked: "w2:blocked" };
  const sessions = {
    working: "11111111-1111-4111-8111-111111111111",
    idle: "22222222-2222-4222-8222-222222222222",
    blocked: "33333333-3333-4333-8333-333333333333",
  };
  const journals = new Map<string, string>();
  for (const key of Object.keys(ids) as Array<keyof typeof ids>) {
    const file = join(projectDir, `${sessions[key]}.jsonl`);
    journals.set(ids[key], file);
    await writeJournal(file, [
      ["user", `Demo task for the ${key} pane`],
      ["assistant", `Looking at the ${key} pane now.`],
    ]);
  }
  const dialog = await fixtureDialog("claude--permission-bash");

  fake.addWorkspace("w1", "nenu").addWorkspace("w2", "api");
  fake.addTab("w1:t1", "redesign").addTab("w1:t2", "review").addTab("w2:t1", "server");
  const pane = (paneId: string, tabId: string, agent: "claude" | "codex" | null, label: string, sessionId?: string) =>
    fake.addPane({
      paneId, workspaceId: paneId.split(":")[0]!, tabId, agent, label, sessionId, cwd: opts.cwd,
      lines: agent === "claude" ? [`❯ Demo task for ${label}`, "", `● Looking at ${label} now.`] : [],
    });
  pane("w1:working", "w1:t1", "claude", "Working Claude", sessions.working);
  pane("w1:idle", "w1:t2", "claude", "Idle Claude", sessions.idle);
  pane("w2:blocked", "w2:t1", "claude", "Blocked Claude", sessions.blocked);
  pane("w2:codex", "w2:t1", "codex", "Codex");
  pane("w2:shell", "w2:t1", null, "Shell");
  fake.setStatus("w1:working", "working");
  fake.setDialog(ids.blocked, dialog);

  return { ...ids, codex: "w2:codex", shell: "w2:shell", journals, dialog };
}

/** Keep the working pane's journal growing, like an agent streaming tool calls. Returns a stop function. */
export function tickJournal(file: string, everyMs = 2000): () => void {
  let n = 0;
  let parent: string | null = null;
  const timer = setInterval(() => {
    const row = journalRow("assistant", `Step ${++n}: still working.`, parent);
    parent = row.uuid;
    void appendFile(file, row.line);
  }, everyMs);
  return () => clearInterval(timer);
}
