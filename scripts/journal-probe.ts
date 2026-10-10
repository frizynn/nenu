#!/usr/bin/env bun
// Probe every journal adapter against the REAL logs on this machine.
//
// The unit tests pin each grammar against builders that mirror the on-disk shape; this answers the
// different question those can't — does the log actually exist where the adapter looks, and does a
// real one (with its unannounced version drift, its odd rows, its size) still parse? Run it after
// touching an adapter, and on any machine where a journal is unexpectedly empty:
//
//   bun scripts/journal-probe.ts
//
// It reads only, prints only counts and roles — never transcript content, so its output is safe to
// paste into an issue. A harness you don't have installed reports `no logs found`, which is not a
// failure: exit code is non-zero only when a log EXISTS and the adapter couldn't resolve or parse it.

import { Database } from "bun:sqlite";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { loadConfig } from "../bridge/config.ts";
import { MAX_TRANSCRIPT_BYTES } from "../bridge/journal/files.ts";
import { isGrokSessionId } from "../bridge/journal/grok.ts";
import { buildJournalRegistry } from "../bridge/journal/registry.ts";
import { TranscriptStore } from "../bridge/journal/store.ts";
import type { AgentSessionRef, JournalAdapter, TranscriptEntry, TranscriptSource } from "../bridge/journal/types.ts";

/**
 * Every `.jsonl` under `dir`, newest first.
 *
 * We try candidates in order rather than trusting the single newest, because the newest log is often
 * a dud through no fault of the adapter: a session someone opened and abandoned parses to zero turns
 * quite correctly (Codex writes a `session_meta` plus one injected `<environment_context>` turn, both
 * of which are meant to be dropped). Only "no candidate at all worked" is a real failure.
 */
async function logsNewestFirst(dir: string, depth = 4): Promise<string[]> {
  const found: { path: string; mtimeMs: number }[] = [];
  const walk = async (d: string, left: number): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(d);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(d, name);
      let st: Awaited<ReturnType<typeof stat>>;
      try {
        st = await stat(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (left > 0) await walk(p, left - 1);
      } else if (name.endsWith(".jsonl")) {
        found.push({ path: p, mtimeMs: st.mtimeMs });
      }
    }
  };
  await walk(dir, depth);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).map((f) => f.path);
}

/** How many candidates to try before calling a harness unreadable. */
const MAX_CANDIDATES = 12;

/**
 * Rebuild the session ref Herdr would have reported for this log, per harness.
 *
 * This is the part worth probing: each adapter's resolve() is a different strategy (Claude scans flat
 * project dirs, Codex walks date partitions, pi takes the path straight, Grok names the session
 * directory and keeps a fixed `chat_history.jsonl`), and each derives from a differently-shaped path.
 *
 * Exported so the Grok parent-dir case has a regression test — a filename-only UUID walk reports
 * "no logs found" for every real Grok session.
 */
export function refFor(agent: string, path: string): AgentSessionRef | null {
  if (agent === "pi") return { kind: "path", value: path };
  if (agent === "grok") {
    const slash = path.lastIndexOf("/");
    if (slash <= 0) return null;
    const dir = path.slice(0, slash);
    const id = dir.slice(dir.lastIndexOf("/") + 1);
    return isGrokSessionId(id) ? { kind: "id", value: id } : null;
  }
  const file = path.slice(path.lastIndexOf("/") + 1).replace(/\.jsonl$/, "");
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(file)?.[0];
  return uuid ? { kind: "id", value: uuid } : null;
}

/**
 * Candidate session refs for one harness, newest first.
 *
 * Three shapes of storage, so three strategies: the file-backed harnesses that name sessions in
 * `.jsonl` FILENAMES (claude/codex/pi), Grok which uses a fixed `chat_history.jsonl` under a
 * session-uuid directory, and OpenCode which has no per-session file at all — its sessions are rows
 * in `<root>/opencode.db`, which no amount of directory walking will find. All branches stay
 * read-only and content-free, as this script's header promises: the sqlite branch selects ids only.
 */
async function candidateRefs(
  agent: string,
  root: string,
): Promise<{ refs: AgentSessionRef[]; total: number }> {
  // One root per call, capped per root. A harness can have several roots (one per profile home —
  // see config.ts) and `probe` walks them SEPARATELY: flattening them into one capped, newest-first
  // list let a populated healthy first root starve the second one out of the list entirely — the
  // exact "root whose logs the adapter can't read" condition this script exists to catch.
  const { refs, total } = await candidateRefsUnder(agent, root);
  return { refs: refs.slice(0, MAX_CANDIDATES), total };
}

async function candidateRefsUnder(
  agent: string,
  root: string,
): Promise<{ refs: AgentSessionRef[]; total: number }> {
  if (agent === "opencode") {
    let db: Database;
    try {
      db = new Database(join(root, "opencode.db"), { readonly: true });
    } catch {
      return { refs: [], total: 0 };
    }
    try {
      // Root sessions only — a `parent_id` row is a subagent session, which herdr never reports.
      const rows = db
        .query<{ id: string }, [number]>(
          "select id from session where parent_id is null order by time_updated desc limit ?",
        )
        .all(MAX_CANDIDATES);
      const refs: AgentSessionRef[] = rows.map((r) => ({ kind: "id", value: r.id }));
      return { refs, total: refs.length };
    } catch {
      return { refs: [], total: 0 };
    } finally {
      db.close();
    }
  }

  const logs = await logsNewestFirst(root);
  const refs: AgentSessionRef[] = [];
  for (const log of logs.slice(0, MAX_CANDIDATES)) {
    // Claude keeps subagent logs under `subagents/` with no uuid in the name — not a session, so not
    // something Herdr would ever name. Skip rather than fail.
    const ref = refFor(agent, log);
    if (ref !== null) refs.push(ref);
  }
  return { refs, total: logs.length };
}

/**
 * Does appending this log in pieces leave the store exactly where one whole read leaves it?
 *
 * The incremental reader is only as right as the parser's carried state, and the format is
 * undocumented, so this replays the log's own window as a sequence of appends (cut mid-line on
 * purpose) and compares every observable — entries, facts, telemetry — against a cold read of the
 * same bytes. In memory, read-only. Null when the adapter has no incremental path.
 */
export async function incrementalMatches(adapter: JournalAdapter, bytes: Uint8Array, pieces = 12): Promise<boolean | null> {
  if (!adapter.parser || !adapter.source.read) return null;
  const view = async (window: () => Uint8Array, steps: number[]): Promise<string> => {
    let size = 0;
    let mtimeMs = 0;
    const source: TranscriptSource = {
      resolve: async () => "/probe",
      stat: async () => ({ size, mtimeMs, ino: 1 }),
      load: async () => { throw new Error("unused"); },
      read: async (_path, start, end) => window().slice(start, Math.min(end, size)),
    };
    const store = new TranscriptStore();
    const live = { ...adapter, source };
    const ref = { kind: "id", value: "probe" } as const;
    for (const step of steps) {
      size = step;
      mtimeMs++;
      await store.page(live, ref, { limit: Number.MAX_SAFE_INTEGER });
    }
    return JSON.stringify([await store.page(live, ref, { limit: Number.MAX_SAFE_INTEGER }), await store.facts(live, ref)]);
  };
  const steps = Array.from({ length: pieces }, (_, i) => Math.round((bytes.length * (i + 1)) / pieces));
  return await view(() => bytes, steps) === await view(() => bytes, [bytes.length]);
}

/** The bytes a store's window would hold for this log: all of it, or its tail below the cap. */
async function windowOf(adapter: JournalAdapter, path: string): Promise<Uint8Array | null> {
  const meta = await adapter.source.stat(path);
  if (!meta || !adapter.source.read) return null;
  const start = Math.max(0, meta.size - MAX_TRANSCRIPT_BYTES);
  const bytes = await adapter.source.read(path, start, meta.size);
  // A clipped head is a partial line; drop it so the replay and the cold read frame lines alike.
  return start === 0 ? bytes : bytes.subarray(bytes.indexOf(10) + 1);
}

function summarise(entries: TranscriptEntry[]): string {
  const roles = new Map<string, number>();
  let parts = 0;
  let results = 0;
  for (const e of entries) {
    roles.set(e.role, (roles.get(e.role) ?? 0) + 1);
    for (const p of e.parts) {
      parts++;
      if (p.kind === "tool" && p.result !== undefined) results++;
    }
  }
  const byRole = [...roles].map(([r, n]) => `${r}:${n}`).join(" ");
  return `${entries.length} turns (${byRole}), ${parts} parts, ${results} tool results`;
}

async function probeRoot(
  adapter: JournalAdapter,
  label: string,
  root: string,
  refs: AgentSessionRef[],
  total: number,
): Promise<boolean> {
  let tried = 0;
  let lastProblem = "no candidate produced turns";
  for (const ref of refs) {
    tried++;

    const resolved = await adapter.source.resolve(ref);
    if (resolved === null) {
      lastProblem = `ref ${ref.kind}:${ref.value.slice(0, 60)} did not resolve`;
      continue;
    }

    const { text, complete } = await adapter.source.load(resolved);
    const entries = adapter.parse(text);
    if (entries.length === 0) {
      lastProblem = `resolved a log but parsed 0 turns from ${text.length} bytes`;
      continue;
    }

    const cursors = new Set(entries.map((e) => e.uuid));
    const dupes = entries.length - cursors.size;
    const window = await windowOf(adapter, resolved);
    const incremental = window ? await incrementalMatches(adapter, window) : null;
    console.log(
      `${label} ✓ ${summarise(entries)}${complete ? "" : " [tail-clipped]"}` +
        `${dupes > 0 ? ` ⚠ ${dupes} duplicate cursors` : ""}` +
        `${incremental === null ? "" : incremental ? ", incremental = whole" : " ✗ incremental differs from a whole read"}`,
    );
    if (incremental === false) {
      lastProblem = "incremental read differs from a whole read";
      continue;
    }
    console.log(`${" ".repeat(10)}${resolved}  (candidate ${tried} of ${total})`);
    return true;
  }

  // Every candidate under this root failed: the logs moved, or a format drifted under the parser.
  console.log(`${label} ✗ ${tried} candidate(s) tried under ${root}, none readable — last: ${lastProblem}`);
  return false;
}

async function probe(adapter: JournalAdapter, roots: readonly string[]): Promise<"ok" | "empty" | "fail"> {
  const label = adapter.agent.padEnd(8);
  // Every POPULATED root must produce a readable log — one healthy root must never vouch for a
  // broken sibling. Roots with no candidates at all are simply not installed there.
  let populated = 0;
  let failed = 0;
  for (const root of roots) {
    const { refs, total } = await candidateRefs(adapter.agent, root);
    if (refs.length === 0) continue;
    populated++;
    if (!(await probeRoot(adapter, label, root, refs, total))) failed++;
  }
  if (populated === 0) {
    console.log(`${label} — no logs found under ${roots.join(", ")} (harness not installed here?)`);
    return "empty";
  }
  return failed === 0 ? "ok" : "fail";
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const registry = buildJournalRegistry(cfg.journalRoots);
  // Keyed lookup rather than a cast: JournalRoots is a closed shape on purpose (adding a harness
  // should be a type error here until its root is wired), so widen it explicitly.
  const roots = new Map<string, readonly string[]>(Object.entries(cfg.journalRoots));

  console.log("journal adapters — probing real logs\n");
  const results = await Promise.all(
    Object.entries(registry).map(([agent, adapter]) => probe(adapter, roots.get(agent) ?? [])),
  );
  const failed = results.filter((r) => r === "fail").length;
  const ok = results.filter((r) => r === "ok").length;
  console.log(`\n${ok} ok, ${results.length - ok - failed} with no logs, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

if (import.meta.main) {
  await main();
}
