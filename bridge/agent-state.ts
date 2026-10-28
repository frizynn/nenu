import { watch as fsWatch } from "node:fs";
import { constants } from "node:fs";
import { open, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import {
  ClaudeTurnScan,
  claudeGoalRow,
  claudeLimit,
  claudeSessionDirs,
  claudeTurn,
  CodexTurnScan,
  codexTurn,
  decodeClaudeSession,
  foregroundPids,
  newestRollout,
  procStartTicks,
  sameProcStart,
  statStartTicks,
  type ClaudeGoal,
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
 * A Claude at rest, first seen: enough tail to hold its last reply and any usage-limit row after it,
 * which is all the usage limit needs (ADR 0120). Its request blobs average 18 KB, the largest measured
 * 2.9 MB. The first look is short and the long one runs only when it found no reply: on 14 resting
 * transcripts the last reply sat 3–269 KB from the end (median 4 KB), and every resting pane is read at
 * once on first sight, at a resident cost that scales with the read (14 panes measured: 66 MB at 1 MB,
 * 7 MB at 64 KB).
 */
const IDLE_PEEK_BYTES = 64 * 1024;
const IDLE_TAIL_BYTES = 1024 * 1024;
/** The longest wait before a Claude held by its usage limit is looked at again. */
const LIMIT_RECHECK_MS = 3_600_000;
/** The backward look for a transcript's goal reads this much at a time. */
const GOAL_CHUNK_BYTES = 1024 * 1024;
/** A failed look for a session's goal is tried again on a later read, this long after. */
const GOAL_RETRY_MS = 60_000;
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
  /** Whether `pid` is the process a session file's `procStart` names; null when that cannot be read. */
  sameProcess?(pid: number, procStart: string): Promise<boolean | null>;
  /** The goal a transcript leaves active, read from its whole log: {@link lastClaudeGoal}. */
  lastGoal?(path: string): Promise<ClaudeGoal | null>;
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
  /** The session's goal as its whole transcript said when first seen; the tail's own goal rows win. */
  goalSeed?: { sessionId: string; goal: ClaudeGoal | null };
  /** The session whose goal is being looked up, so two looks never read the log twice. */
  goalSeeding?: string;
  /** When a failed look may be tried again. */
  goalRetryAt?: number;
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
  private readonly sameProcess: (pid: number, procStart: string) => Promise<boolean | null>;
  private readonly now: () => number;

  constructor(private readonly opts: AgentStatesOptions) {
    this.sessionDirs = claudeSessionDirs(opts.claudeRoots);
    this.watchFn = opts.watch ?? ((path, onChange) => fsWatch(path, { persistent: false }, (event, filename) => onChange(event, filename ? String(filename) : null)));
    this.openFiles = opts.openFiles ?? processOpenFiles;
    this.sameProcess = opts.sameProcess ?? sameProcess;
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
      if ((await this.sameProcess(pid, file.procStart).catch(() => null)) === false) return false;
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
    }
    this.update(entry);
  }

  /** Read what the transcript of a Claude at rest appended, without watching it. */
  private async peekTranscript(entry: Entry, sessionId: string): Promise<void> {
    if (entry.transcript?.sessionId !== sessionId) {
      this.closeTail(entry.transcript);
      entry.transcript = undefined;
      const path = await this.opts.claudeTranscript(sessionId).catch(() => null);
      // A busy spell that began meanwhile followed the transcript itself, watched: that tail stays.
      if (!path || entry.dropped || entry.file?.sessionId !== sessionId || entry.transcript) return;
      for (const bytes of [IDLE_PEEK_BYTES, IDLE_TAIL_BYTES]) {
        const transcript: NonNullable<Entry["transcript"]> = { path, sessionId, scan: new ClaudeTurnScan() };
        entry.transcript = transcript;
        await this.readTail(transcript, bytes);
        // Done once the reply was found or the whole file read, or once the session moved on: a busy
        // spell that began meanwhile follows this tail now.
        const found = transcript.scan.lastReply > -Infinity || (transcript.tail?.offset ?? Infinity) <= bytes;
        const moved = entry.dropped || (entry as Entry).transcript !== transcript || entry.file?.sessionId !== sessionId || entry.file?.status === "busy";
        if (found || moved) return;
        // A look that ran meanwhile may have watched this short tail for a goal; the longer one replaces it.
        this.closeTail(transcript);
      }
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
      // A look at rest may have opened it during the lookup (`as Entry` reads it afresh past the await):
      // one tail per transcript, never two scans.
      if ((entry as Entry).transcript?.sessionId !== sessionId) entry.transcript = { path, sessionId, scan: new ClaudeTurnScan() };
    }
    const transcript = entry.transcript;
    if (!transcript) return;
    await this.readTail(transcript);
    // Only a turn still running watches: one that ended during the read left a Claude at rest.
    if (entry.file?.status === "busy" && !entry.file.waitingFor) this.watchTranscript(entry, transcript);
  }

  /**
   * Look up the session's goal in its whole log once, beside the turn's own reads rather than before
   * them: a long log without a goal is read back to its last compaction. A failed read is tried again
   * on a later read, a minute on.
   */
  private seedGoal(entry: Entry): void {
    const transcript = entry.transcript;
    const sessionId = transcript?.sessionId;
    if (!transcript || !sessionId || sessionId !== entry.file?.sessionId) return;
    if (entry.goalSeed?.sessionId === sessionId || entry.goalSeeding === sessionId || this.now() < (entry.goalRetryAt ?? -Infinity)) return;
    entry.goalSeeding = sessionId;
    void (this.opts.lastGoal ?? lastClaudeGoal)(transcript.path).then(
      (goal) => {
        if (entry.goalSeeding !== sessionId) return;
        entry.goalSeeding = undefined;
        entry.goalSeed = { sessionId, goal };
        this.update(entry);
      },
      () => {
        if (entry.goalSeeding === sessionId) entry.goalSeeding = undefined;
        entry.goalRetryAt = this.now() + GOAL_RETRY_MS;
      },
    );
  }

  private watchTranscript(entry: Entry, transcript: NonNullable<Entry["transcript"]>): void {
    if (transcript.watcher || entry.dropped || entry.transcript !== transcript) return;
    transcript.watcher = this.watchFile(transcript.path, () => {
      void this.readTail(transcript).then(() => this.update(entry));
    });
  }

  /** The goal the pane's Claude works toward: its tail's newest goal row, else its whole transcript's. */
  private goalOf(entry: Entry): ClaudeGoal | undefined {
    const sessionId = entry.file?.sessionId;
    if (!sessionId) return undefined;
    const seen = entry.transcript?.sessionId === sessionId ? entry.transcript.scan.goal : undefined;
    const goal = seen !== undefined ? seen : entry.goalSeed?.sessionId === sessionId ? entry.goalSeed.goal : null;
    return goal ?? undefined;
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
    if (entry.agent === "claude") this.seedGoal(entry);
    const scan = entry.transcript?.scan ?? null;
    const limit = entry.agent === "claude" ? claudeLimit(scan, this.profileReply(entry), this.now()) : undefined;
    const goal = entry.agent === "claude" ? this.goalOf(entry) : undefined;
    const turn = entry.agent === "claude"
      ? entry.file ? claudeTurn(entry.file, scan, entry.busySince, limit) : undefined
      : entry.rollout ? codexTurn(entry.rollout.scan) ?? undefined : undefined;
    const state = turn && goal ? { ...turn, goal } : turn;
    // At rest the transcript is watched only for a goal: clearing one writes the transcript, and
    // nothing says the session file moves with it.
    if (entry.agent === "claude" && entry.file?.status !== "busy" && entry.transcript) {
      if (goal) this.watchTranscript(entry, entry.transcript);
      else this.closeTail(entry.transcript);
    }
    clearTimeout(entry.limitTimer);
    if (state?.limit) {
      // At most an hour: a timer past 2^31 ms fires at once, and the next look re-arms it.
      entry.limitTimer = setTimeout(() => this.update(entry), Math.min(Math.max(0, state.limit.resetsAt - this.now()) + 1_000, LIMIT_RECHECK_MS));
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

/**
 * The goal a Claude transcript leaves active (see {@link ClaudeGoal}): its newest goal row, read
 * backwards a chunk at a time, stopping at the first goal row or compaction boundary. Rows are found by
 * their raw markers and confirmed by parsing the whole line, so the same words quoted inside another
 * row never count. A line longer than a chunk is dropped while it is read: a goal row is never that long.
 */
export async function lastClaudeGoal(path: string, chunk = GOAL_CHUNK_BYTES): Promise<ClaudeGoal | null> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await file.stat();
    if (!st.isFile()) return null;
    let end = st.size;
    let carry = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - chunk);
      const read = Buffer.alloc(end - start);
      const { bytesRead } = await file.read(read, 0, read.length, start);
      const bytes = Buffer.concat([read.subarray(0, bytesRead), carry]);
      // The bytes before the first newline belong to a line that starts in an earlier chunk.
      const from = start === 0 ? 0 : bytes.indexOf(0x0a) + 1;
      let below = bytes.length;
      while (from > 0 || start === 0) {
        const at = Math.max(...GOAL_MARKS.map((mark) => (below < mark.length ? -1 : bytes.lastIndexOf(mark, below - mark.length))));
        if (at < from) break;
        const lineStart = bytes.lastIndexOf(0x0a, at) + 1;
        const nl = bytes.indexOf(0x0a, at);
        const goal = goalLine(bytes.toString("utf8", lineStart, nl === -1 ? bytes.length : nl));
        if (goal !== undefined) return goal;
        below = lineStart;
      }
      carry = from > 0 && from <= chunk ? Buffer.from(bytes.subarray(0, from)) : Buffer.alloc(0);
      end = start;
    }
    return null;
  } finally { await file.close(); }
}

const GOAL_MARKS = ['"type":"goal_status"', '"subtype":"compact_boundary"'].map((mark) => Buffer.from(mark));

function goalLine(text: string): ClaudeGoal | null | undefined {
  try {
    const row: unknown = JSON.parse(text);
    return row && typeof row === "object" ? claudeGoalRow(row as Record<string, unknown>) : undefined;
  } catch { return undefined; }
}

export async function readSmall(path: string): Promise<string | null> {
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

/**
 * Whether `pid` started when `procStart` says: Linux's start ticks straight from `/proc` (no spawn;
 * `Bun.file` because `/proc` files report size 0), else {@link processStart}. Null when the start
 * cannot be read.
 */
export async function sameProcess(pid: number, procStart: string): Promise<boolean | null> {
  if (procStartTicks(procStart)) {
    if (process.platform !== "linux") return null;
    const ticks = statStartTicks(await Bun.file(`/proc/${pid}/stat`).text());
    return ticks === null ? null : ticks === procStart.trim();
  }
  const started = await processStart(pid);
  return started === null ? null : sameProcStart(procStart, started);
}

/** When a pid started, from `ps -o lstart=` read in this process's own time zone. */
export async function processStart(pid: number): Promise<number | null> {
  const child = Bun.spawn(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: { ...process.env, LC_ALL: "C" } });
  const timer = setTimeout(() => child.kill(), 2_000);
  try {
    const out = (await new Response(child.stdout).text()).trim().replace(/\s+/g, " ");
    const at = Date.parse(out);
    return (await child.exited) === 0 && Number.isFinite(at) ? at : null;
  } finally { clearTimeout(timer); }
}
