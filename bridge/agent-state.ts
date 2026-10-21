import { watch as fsWatch } from "node:fs";
import { constants } from "node:fs";
import { open, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import {
  ClaudeTurnScan,
  claudeLimit,
  claudeSessionDirs,
  claudeTurn,
  CodexTurnScan,
  codexTurn,
  decodeClaudeSession,
  foregroundPids,
  newestRollout,
  sameProcStart,
  type ClaudeSessionFile,
} from "./agent-state-sources.ts";
import type { HerdrClient } from "./herdr-client.ts";
import { containedRealpathIn } from "./journal/files.ts";
import { readAppended, type TailState } from "./journal/lines.ts";
import type { AgentSessionRef } from "./journal/types.ts";
import type { AgentView, LivePublisher, TurnState } from "./types.ts";

// One structured "agent state" per Claude or Codex pane (ADR 0067). Claude's comes from its session
// file (~/.claude/sessions/<pid>.json) plus, while busy, its transcript; Codex's from the rollout its
// process holds open. Files are watched, never polled: one directory watch per Claude profile, one
// file watch per busy Claude transcript and per Codex rollout. A change of state publishes `snapshot`
// and `pane` by name (ADR 0054); the snapshot route attaches the state as `turn`, and Stop reads the
// same entry after a fresh look at the same files.

/** A Claude transcript or Codex rollout read on first sight: enough tail to hold the current turn. */
const TAIL_BYTES = 4 * 1024 * 1024;
/**
 * A Claude at rest, first seen: enough tail to hold the row that ended its last turn, which is all the
 * usage limit needs (ADR 0120). Its request blobs average 18 KB, the largest measured 2.9 MB.
 */
const IDLE_TAIL_BYTES = 1024 * 1024;
/** A session file is a few hundred bytes; anything bigger is not one. */
const SESSION_FILE_MAX = 64 * 1024;
/** How often an unresolved pane is retried when Herdr reports no transition. */
const RETRY_UNRESOLVED_MS = 15_000;
/** A busy Claude's transcript appears ~150 ms after the busy flip on a first prompt (measured). */
const TRANSCRIPT_RETRY_MS = 400;
const TRANSCRIPT_RETRIES = 5;
/** How often a session file of an unknown pid may send an unmapped Claude pane back to Herdr. */
const WATCH_RESOLVE_GAP_MS = 3_000;

type ProcessInfo = Pick<HerdrClient, "processInfo">;
type Watcher = { close(): void };
export type WatchFn = (path: string, onChange: (event: string, filename: string | null) => void) => Watcher;

export interface AgentStatesOptions {
  /** Claude's projects roots (config `journalRoots.claude`); each profile's sessions dir sits beside it. */
  claudeRoots: readonly string[];
  /** Codex's sessions roots (config `journalRoots.codex`): a rollout outside them is never read. */
  codexRoots: readonly string[];
  live: LivePublisher;
  /** The contained transcript path of a Claude session id, through the journal adapter. */
  claudeTranscript(sessionId: string): Promise<string | null>;
  /** The contained rollout path of a Herdr-reported Codex session, when open files name none. */
  codexTranscript?(ref: AgentSessionRef): Promise<string | null>;
  openFiles?(pids: number[]): Promise<string[]>;
  /** Epoch ms the process started, or null when unknown. */
  procStart?(pid: number): Promise<number | null>;
  watch?: WatchFn;
  now?(): number;
}

interface Tail<S> {
  path: string;
  tail?: TailState;
  scan: S;
  watcher?: Watcher;
  /** The read in flight: reads chain, so each starts at the offset the previous one reached. */
  reading?: Promise<void>;
}

interface Entry {
  readonly key: string;
  readonly session: string;
  readonly paneId: string;
  readonly agent: "claude" | "codex";
  herdr: ProcessInfo;
  seq?: number;
  status?: string;
  agentSession?: AgentSessionRef;
  triedAt: number;
  resolving?: Promise<void>;
  /** Claude: the foreground pids last seen, so a session file created later still maps. */
  pids: number[];
  file?: ClaudeSessionFile;
  /** When the current busy spell began: a dialog answered inside it (waiting → busy) does not restart it. */
  busySince?: number;
  sessionDir?: string;
  transcript?: Tail<ClaudeTurnScan> & { sessionId: string };
  transcriptRetry?: ReturnType<typeof setTimeout>;
  rollout?: Tail<CodexTurnScan>;
  /** Wakes the entry when its usage limit resets, so the state drops it on time. */
  limitTimer?: ReturnType<typeof setTimeout>;
  /** The transcript's latest reply this entry has told its profile about. */
  replySeen?: number;
  state?: TurnState;
  published: string;
  dropped?: boolean;
}

const key = (session: string, paneId: string) => `${session}\u0000${paneId}`;
const tracked = (agent: string): agent is "claude" | "codex" => agent === "claude" || agent === "codex";

export class AgentStates {
  private readonly entries = new Map<string, Entry>();
  /** Claude pid → pane entry key, for the directory watch. */
  private readonly pids = new Map<number, string>();
  private readonly dirWatchers = new Map<string, Watcher>();
  private readonly sessionDirs: string[];
  private readonly watchFn: WatchFn;
  private readonly openFiles: (pids: number[]) => Promise<string[]>;
  private readonly procStart: (pid: number) => Promise<number | null>;
  private readonly now: () => number;

  constructor(private readonly opts: AgentStatesOptions) {
    this.sessionDirs = claudeSessionDirs(opts.claudeRoots);
    this.watchFn = opts.watch ?? ((path, onChange) => fsWatch(path, { persistent: false }, (event, filename) => onChange(event, filename ? String(filename) : null)));
    this.openFiles = opts.openFiles ?? processOpenFiles;
    this.procStart = opts.procStart ?? processStart;
    this.now = opts.now ?? Date.now;
  }

  /** The pane's state as last read, or undefined when no structured source is known for it. */
  get(session: string, paneId: string): TurnState | undefined {
    return this.entries.get(key(session, paneId))?.state;
  }

  /** The Claude session the pane runs, from its own session file, when one is mapped. */
  claudeSessionId(session: string, paneId: string): string | undefined {
    const entry = this.entries.get(key(session, paneId));
    return entry?.agent === "claude" ? entry.file?.sessionId : undefined;
  }

  /** `pane` with its structured turn attached, when there is one. */
  attach<P extends AgentView>(session: string, pane: P): P {
    const turn = this.get(session, pane.paneId);
    return turn ? { ...pane, turn } : pane;
  }

  /**
   * Follow the session's Claude and Codex panes: start tracking new ones, drop gone ones, and look
   * again at a pane whose mapping is missing or whose Herdr status moved (a Codex `/new` writes a new
   * rollout; a restarted Claude has a new pid). Cheap when nothing changed.
   */
  sync(session: string, herdr: ProcessInfo, agents: readonly AgentView[]): void {
    const live = new Set<string>();
    for (const pane of agents) {
      if (!tracked(pane.agent)) continue;
      const k = key(session, pane.paneId);
      live.add(k);
      let entry = this.entries.get(k);
      if (entry && entry.agent !== pane.agent) { this.drop(entry); entry = undefined; }
      const fresh = !entry;
      entry ??= this.create(session, pane.paneId, pane.agent, herdr);
      entry.herdr = herdr;
      const moved = !fresh && (pane.stateChangeSeq !== entry.seq || pane.status !== entry.status);
      entry.seq = pane.stateChangeSeq;
      entry.status = pane.status;
      entry.agentSession = pane.agentSession;
      if (this.wantsResolve(entry, fresh, moved)) void this.resolve(entry);
    }
    for (const entry of [...this.entries.values()]) if (entry.session === session && !live.has(entry.key)) this.drop(entry);
  }

  /**
   * Stop's look: re-read the pane's files now rather than trust the last watch event. With `remap`
   * (Stop's first look) the mapping is checked against the pane's foreground processes too: a Claude
   * that crashed and restarted in the pane leaves its old busy file behind, and a Codex `/new` moves
   * its turn to a rollout the watch does not follow yet. Later looks only re-read the known files.
   */
  async fresh(session: string, pane: AgentView, herdr: ProcessInfo, { remap = true }: { remap?: boolean } = {}): Promise<TurnState | undefined> {
    if (!tracked(pane.agent)) return undefined;
    const k = key(session, pane.paneId);
    let entry = this.entries.get(k);
    if (entry && entry.agent !== pane.agent) { this.drop(entry); entry = undefined; }
    entry ??= this.create(session, pane.paneId, pane.agent, herdr);
    entry.herdr = herdr;
    entry.agentSession = pane.agentSession;
    if (entry.agent === "claude") {
      if (remap) await this.resolve(entry, true);
      else if (entry.file && entry.sessionDir) await this.loadClaude(entry, entry.sessionDir, entry.file.pid);
    } else {
      if (entry.rollout) await this.readRollout(entry);
      if (remap && (!entry.rollout || !entry.state?.running)) await this.resolve(entry, true);
    }
    return entry.state;
  }

  /** A hook named this pane: read its files now instead of waiting for the watch. */
  poke(session: string, paneId: string): void {
    const entry = this.entries.get(key(session, paneId));
    if (!entry) return;
    if (entry.agent === "claude" && entry.file && entry.sessionDir) void this.loadClaude(entry, entry.sessionDir, entry.file.pid);
    else if (entry.agent === "codex" && entry.rollout) void this.readRollout(entry);
  }

  close(): void {
    for (const entry of [...this.entries.values()]) this.drop(entry);
    for (const watcher of this.dirWatchers.values()) watcher.close();
    this.dirWatchers.clear();
  }

  /** Watched paths, for tests and diagnostics. */
  get watching(): string[] {
    const files = [...this.entries.values()].flatMap((e) => [e.transcript, e.rollout].flatMap((t) => (t?.watcher ? [t.path] : [])));
    return [...this.dirWatchers.keys(), ...files];
  }

  private create(session: string, paneId: string, agent: "claude" | "codex", herdr: ProcessInfo): Entry {
    const entry: Entry = { key: key(session, paneId), session, paneId, agent, herdr, triedAt: -Infinity, pids: [], published: "null" };
    this.entries.set(entry.key, entry);
    return entry;
  }

  private wantsResolve(entry: Entry, fresh: boolean, moved: boolean): boolean {
    if (fresh) return true;
    const unresolved = entry.agent === "claude" ? !entry.file : !entry.rollout;
    if (unresolved) return moved || this.now() - entry.triedAt >= RETRY_UNRESOLVED_MS;
    // Claude: a status move re-checks that the mapped pid still owns the pane (a crash leaves its file).
    return moved && (entry.agent === "claude" || entry.status === "working");
  }

  /** Map the pane to its files through the processes in its foreground. Shared while in flight. */
  private resolve(entry: Entry, force = false): Promise<void> {
    if (entry.resolving) return entry.resolving;
    if (!force && this.now() - entry.triedAt < 250) return Promise.resolve();
    entry.triedAt = this.now();
    entry.resolving = (async () => {
      try {
        const pids = foregroundPids(await entry.herdr.processInfo(entry.paneId));
        if (entry.agent === "claude") await this.resolveClaude(entry, pids);
        else await this.resolveCodex(entry, pids);
      } catch {
        // Herdr or the files are unreadable right now; the pane keeps its fallback until a retry.
      } finally {
        entry.resolving = undefined;
      }
    })();
    return entry.resolving;
  }

  private async resolveClaude(entry: Entry, pids: number[]): Promise<void> {
    for (const pid of entry.pids) if (this.pids.get(pid) === entry.key) this.pids.delete(pid);
    entry.pids = pids;
    for (const pid of pids) this.pids.set(pid, entry.key);
    for (const dir of this.sessionDirs) this.watchDir(dir);
    // Still in the pane's foreground, so still the process whose start was checked when it mapped.
    const mapped = entry.file?.pid;
    if (mapped !== undefined && entry.sessionDir && pids.includes(mapped) && (await this.loadClaude(entry, entry.sessionDir, mapped))) return;
    for (const dir of this.sessionDirs) {
      for (const pid of pids) {
        if (await this.loadClaude(entry, dir, pid, true)) return;
      }
    }
    await this.applyClaude(entry, undefined);
  }

  /** Read `<dir>/<pid>.json` into the entry. True when it is this pane's live session file. */
  private async loadClaude(entry: Entry, dir: string, pid: number, verify = false): Promise<boolean> {
    const text = await readSmall(join(dir, `${pid}.json`));
    const file = text === null ? null : decodeClaudeSession(text, pid);
    if (!file) {
      if (entry.file?.pid === pid) await this.applyClaude(entry, undefined);
      return false;
    }
    if (verify && file.procStart) {
      // A file left by a crashed Claude names a pid the system may have handed to someone else.
      const started = await this.procStart(pid).catch(() => null);
      if (started !== null && !sameProcStart(file.procStart, started)) return false;
    }
    entry.sessionDir = dir;
    await this.applyClaude(entry, file);
    return true;
  }

  private async applyClaude(entry: Entry, file: ClaudeSessionFile | undefined): Promise<void> {
    if (entry.dropped) return;
    const before = entry.file?.sessionId === file?.sessionId ? entry.file?.status : undefined;
    if (file?.status === "busy" || file?.status === "waiting") {
      // A spell starts when the session leaves idle; a dialog inside it (busy ⇄ waiting) continues it.
      if (entry.busySince === undefined || (before !== "busy" && before !== "waiting")) entry.busySince = file.statusUpdatedAt;
    } else entry.busySince = undefined;
    entry.file = file;
    if (file?.status === "busy" && !file.waitingFor) await this.followTranscript(entry, file.sessionId, 0);
    else {
      // At rest the transcript is read once more, unwatched: the row that ended the turn may say the
      // usage limit refused it (ADR 0120), and it can land after the last watch event.
      if (file && !file.waitingFor) await this.peekTranscript(entry, file.sessionId);
      this.closeTail(entry.transcript);
    }
    this.update(entry);
  }

  /** Read what the transcript of a Claude at rest appended, without watching it. */
  private async peekTranscript(entry: Entry, sessionId: string): Promise<void> {
    if (entry.transcript?.sessionId !== sessionId) {
      this.closeTail(entry.transcript);
      entry.transcript = undefined;
      const path = await this.opts.claudeTranscript(sessionId).catch(() => null);
      if (!path || entry.dropped || entry.file?.sessionId !== sessionId) return;
      entry.transcript = { path, sessionId, scan: new ClaudeTurnScan() };
      await this.readTail(entry.transcript, IDLE_TAIL_BYTES);
      return;
    }
    await this.readTail(entry.transcript);
  }

  /** While busy, the transcript tells a running main turn from background work and holds the queue. */
  private async followTranscript(entry: Entry, sessionId: string, attempt: number): Promise<void> {
    clearTimeout(entry.transcriptRetry);
    if (entry.transcript?.sessionId !== sessionId) {
      this.closeTail(entry.transcript);
      entry.transcript = undefined;
      const path = await this.opts.claudeTranscript(sessionId).catch(() => null);
      if (entry.dropped || entry.file?.sessionId !== sessionId) return;
      if (!path) {
        // A first prompt's transcript lands ~150 ms after the busy flip: look again a few times.
        if (attempt < TRANSCRIPT_RETRIES) {
          entry.transcriptRetry = setTimeout(() => {
            if (entry.file?.status === "busy" && entry.file.sessionId === sessionId) void this.followTranscript(entry, sessionId, attempt + 1).then(() => this.update(entry));
          }, TRANSCRIPT_RETRY_MS);
          entry.transcriptRetry.unref?.();
        }
        return;
      }
      entry.transcript = { path, sessionId, scan: new ClaudeTurnScan() };
    }
    const transcript = entry.transcript;
    if (!transcript) return;
    await this.readTail(transcript);
    if (!transcript.watcher && !entry.dropped) {
      transcript.watcher = this.watchFile(transcript.path, () => {
        void this.readTail(transcript).then(() => this.update(entry));
      });
    }
  }

  private async resolveCodex(entry: Entry, pids: number[]): Promise<void> {
    const open = pids.length ? await this.openFiles(pids).catch(() => []) : [];
    const contained = (await Promise.all(open.filter((p) => p.endsWith(".jsonl")).map((p) => containedRealpathIn(p, this.opts.codexRoots)))).filter((p): p is string => p !== null);
    let path = newestRollout(contained);
    if (!path && entry.agentSession && this.opts.codexTranscript) path = await this.opts.codexTranscript(entry.agentSession).catch(() => null);
    if (entry.dropped) return;
    if (!path) {
      if (!entry.rollout) this.update(entry);
      return;
    }
    if (entry.rollout?.path !== path) {
      this.closeTail(entry.rollout);
      entry.rollout = { path, scan: new CodexTurnScan() };
    }
    await this.readRollout(entry);
  }

  private async readRollout(entry: Entry): Promise<void> {
    const rollout = entry.rollout;
    if (!rollout) return;
    await this.readTail(rollout);
    if (!rollout.watcher && !entry.dropped && entry.rollout === rollout) {
      rollout.watcher = this.watchFile(rollout.path, () => {
        void this.readTail(rollout).then(() => this.update(entry));
      });
    }
    this.update(entry);
  }

  /** Read what was appended since the last read. Two reads of one file never overlap: the same lines
   *  scanned twice would replay Claude's queue twice and leave a phantom queued message. */
  private readTail(tail: Tail<{ line(text: string): void }>, firstBytes = TAIL_BYTES): Promise<void> {
    const read = (tail.reading ?? Promise.resolve()).then(async () => {
      try {
        const next = await readAppended(tail.path, tail.tail ? TAIL_BYTES : firstBytes, tail.tail);
        tail.tail = next.tail;
        for (const line of next.lines) tail.scan.line(line);
      } catch {
        // Gone or replaced: the next resolve finds the new file.
      }
    });
    tail.reading = read;
    void read.then(() => { if (tail.reading === read) tail.reading = undefined; });
    return read;
  }

  private update(entry: Entry): void {
    if (entry.dropped) return;
    const scan = entry.transcript?.scan ?? null;
    const limit = entry.agent === "claude" ? claudeLimit(scan, this.profileReply(entry), this.now()) : undefined;
    const state = entry.agent === "claude"
      ? entry.file ? claudeTurn(entry.file, scan, entry.busySince, limit) : undefined
      : entry.rollout ? codexTurn(entry.rollout.scan) ?? undefined : undefined;
    clearTimeout(entry.limitTimer);
    if (state?.limit) {
      entry.limitTimer = setTimeout(() => this.update(entry), Math.max(0, state.limit.resetsAt - this.now()) + 1_000);
      entry.limitTimer.unref?.();
    }
    // A reply on one Claude is the account working again: every other Claude of its profile that the
    // limit holds is looked at again (ADR 0120).
    if (scan && scan.lastReply !== (entry.replySeen ?? -Infinity)) {
      entry.replySeen = scan.lastReply;
      for (const other of this.entries.values()) if (other !== entry && other.state?.limit && other.sessionDir === entry.sessionDir) this.update(other);
    }
    const published = JSON.stringify(state ?? null);
    if (published === entry.published) return;
    entry.state = state;
    entry.published = published;
    this.opts.live.publish({ session: entry.session, topic: "snapshot" });
    this.opts.live.publish({ session: entry.session, topic: "pane", paneId: entry.paneId });
  }

  /** The latest reply any Claude of this entry's profile (its sessions folder, one account) has had. */
  private profileReply(entry: Entry): number {
    let latest = -Infinity;
    for (const other of this.entries.values()) {
      if (other.agent === "claude" && other.sessionDir === entry.sessionDir && other.transcript) latest = Math.max(latest, other.transcript.scan.lastReply);
    }
    return latest;
  }

  private watchDir(dir: string): void {
    if (this.dirWatchers.has(dir)) return;
    try {
      const watcher = this.watchFn(dir, (_event, filename) => this.sessionFileChanged(dir, filename));
      this.dirWatchers.set(dir, watcher);
    } catch {
      // No sessions dir yet (no Claude ever ran under this profile): the next resolve tries again.
    }
  }

  private sessionFileChanged(dir: string, filename: string | null): void {
    const pid = filename ? Number(/^(\d+)\.json$/.exec(filename)?.[1]) : NaN;
    if (Number.isSafeInteger(pid)) {
      const entry = this.entries.get(this.pids.get(pid) ?? "");
      if (entry) void this.loadClaude(entry, dir, pid, entry.file?.pid !== pid);
      // Another Claude's file: maybe one of ours restarted. Other Claudes write theirs too, so this
      // path asks Herdr at most every few seconds per pane.
      else for (const other of this.entries.values()) if (other.agent === "claude" && !other.file && this.now() - other.triedAt >= WATCH_RESOLVE_GAP_MS) void this.resolve(other);
      return;
    }
    // No filename (macOS can coalesce): re-read every mapped Claude.
    for (const entry of this.entries.values()) if (entry.agent === "claude" && entry.file && entry.sessionDir === dir) void this.loadClaude(entry, dir, entry.file.pid);
  }

  private watchFile(path: string, onChange: () => void): Watcher | undefined {
    try {
      return this.watchFn(path, () => onChange());
    } catch {
      return undefined;
    }
  }

  private closeTail(tail: Tail<unknown> | undefined): void {
    tail?.watcher?.close();
    if (tail) tail.watcher = undefined;
  }

  private drop(entry: Entry): void {
    entry.dropped = true;
    clearTimeout(entry.transcriptRetry);
    clearTimeout(entry.limitTimer);
    this.closeTail(entry.transcript);
    this.closeTail(entry.rollout);
    for (const pid of entry.pids) if (this.pids.get(pid) === entry.key) this.pids.delete(pid);
    this.entries.delete(entry.key);
    if (entry.state) {
      this.opts.live.publish({ session: entry.session, topic: "snapshot" });
    }
    if (![...this.entries.values()].some((e) => e.agent === "claude")) {
      for (const watcher of this.dirWatchers.values()) watcher.close();
      this.dirWatchers.clear();
    }
  }
}

async function readSmall(path: string): Promise<string | null> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = await file.stat();
      if (!st.isFile() || st.size > SESSION_FILE_MAX) return null;
      const buffer = Buffer.alloc(st.size);
      const { bytesRead } = await file.read(buffer, 0, st.size, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally { await file.close(); }
  } catch {
    return null;
  }
}

/** Files the processes hold open: /proc on Linux, lsof elsewhere (macOS). */
export async function processOpenFiles(pids: number[]): Promise<string[]> {
  if (process.platform === "linux") {
    const paths: string[] = [];
    for (const pid of pids) {
      const fds = await readdir(`/proc/${pid}/fd`).catch(() => []);
      for (const fd of fds) {
        const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => null);
        if (target?.startsWith("/")) paths.push(target);
      }
    }
    return paths;
  }
  const lsof = Bun.which("lsof") ?? "/usr/sbin/lsof";
  const child = Bun.spawn([lsof, "-n", "-P", "-w", "-Fn", "-p", pids.join(",")], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const timer = setTimeout(() => child.kill(), 3_000);
  try {
    const out = await new Response(child.stdout).text();
    await child.exited;
    return out.split("\n").flatMap((line) => (line.startsWith("n/") ? [line.slice(1)] : []));
  } finally { clearTimeout(timer); }
}

/** When a pid started, from `ps -o lstart=` read in this process's own time zone. */
async function processStart(pid: number): Promise<number | null> {
  const child = Bun.spawn(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: { ...process.env, LC_ALL: "C" } });
  const timer = setTimeout(() => child.kill(), 2_000);
  try {
    const out = (await new Response(child.stdout).text()).trim().replace(/\s+/g, " ");
    const at = Date.parse(out);
    return (await child.exited) === 0 && Number.isFinite(at) ? at : null;
  } finally { clearTimeout(timer); }
}
