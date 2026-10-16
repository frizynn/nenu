import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { AccountBook, codexAccount, UNASSIGNED } from "./accounts.ts";
import { bytesEqual, hashRanges, isoMsAt, objectEnd, stringEnd, text, topLevelFields, uintAt } from "./bytes.ts";

// The usage scan: Claude Code transcripts and Codex rollouts → token totals per local day, agent,
// account, model and repo. It runs in its own short-lived process (scan-main.ts), because a scan of a
// large history in the bridge left the bridge 140 MB heavier for good (measured, ADR 0085).
//
// Only bytes appended since the last scan are read, and only whole lines: a half-written tail is read
// again next time. Rows are found by byte markers and their fields read in place (bytes.ts).

/** [rows, input, output, cacheWrite5m, cacheWrite1h, cacheRead, reasoning] — prices.ts COLUMNS. */
export type Sum = number[];
/** day → "<agent>|<account>|<model>|<repo>" → sum */
export type Days = Record<string, Record<string, Sum>>;

export interface CodexLimits {
  observedAt: number;
  plan?: string;
  windows: Array<{ windowMinutes: number; usedPercent: number; resetsAt?: number }>;
}

export interface Totals {
  v: 1;
  /** IANA zone the days were cut in. */
  tz: string;
  /** First day Nenu kept totals of its own. */
  trackedFrom: string;
  /** Earliest day any log had. */
  logsFrom?: string;
  days: Days;
  /** repo key → folder name */
  repos: Record<string, string>;
  /** Codex account → its latest plan limits, from the rollouts. */
  codexLimits: Record<string, CodexLimits>;
  /** The save these totals belong to: they were counted with `scan.<gen>.json` and `seen.<seen>.bin`. */
  files?: { gen: number; seen: number };
}

/** What the scan remembers per log. Claude logs by path; Codex rollouts by id, because Codex moves them. */
export interface FileEntry {
  /** Bytes consumed (whole lines only). */
  o: number;
  /** Size at the last scan. */
  s: number;
  /** Repo key. */
  r?: string;
  /** Codex: model, account, cumulative totals so far. */
  m?: string;
  a?: string;
  t?: number[];
}

export interface ScanState {
  v: 1;
  files: Record<string, FileEntry>;
  /** dir → [mtimeMs, subdirs, log files]: an unchanged directory is not listed again. */
  dirs: Record<string, [number, string[], string[]]>;
  /** cwd → repo key */
  cwds: Record<string, string>;
}

export interface ClaudeRoot { configDir: string }
export interface Roots { claude: ClaudeRoot[]; codex: string[] }

export interface Progress { files: number; totalFiles: number; bytes: number; totalBytes: number }

export interface ScanResult {
  files: number;
  read: number;
  bytes: number;
  rows: number;
  duplicates: number;
  fallback: number;
  /** Largest row read whole. */
  fallbackMax: number;
  skipped: number;
  /** Told to stop before the last log: nothing should be saved. */
  stopped: boolean;
  ms: number;
}

const enc = (s: string) => Buffer.from(s, "latin1");
const USAGE = enc('"usage":{');
const T_ASSIST = enc('"type":"assistant","uuid"');
const ASSISTANT = enc('"type":"assistant"');
const MSG_MODEL = enc('"message":{"model":"');
const ID_AFTER_MODEL = enc(',"id":"');
const REQUEST_ID = enc(',"requestId":"');
const TIMESTAMP = enc('"timestamp":"');
const CWD = enc('"cwd":"');
const MSG_PREFIX = enc("msg_");
const USAGE_KEYS = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "cache_creation", "speed"].map(enc);
const EPHEMERAL_KEYS = [enc("ephemeral_1h_input_tokens")];
const FAST = enc('"fast"');
const CODEX_MARKERS = [enc('"token_count"'), enc('"type":"turn_context"'), enc('"type":"session_meta"')];
const MODEL = enc('"model":"');
const CREATOR = enc('"creator_account_id":"');

/** A day number (days since 1970) fits two bytes for the seen set's pruning. */
const dayNumber = (ms: number) => Math.floor(ms / 86_400_000);

/**
 * Claude message keys already counted, so a response written once per content block, or copied into
 * another transcript, counts once. An open-addressing table over a Float64Array: a JS Set of the
 * same 267 thousand keys cost 28 MB of heap objects (measured), this costs 10 bytes a slot.
 * On disk: [u32 count][f64 keys][u16 day numbers], pruned by age when saved.
 */
export class Seen {
  private keys: Float64Array;
  private days: Uint16Array;
  private count = 0;
  private added = 0;

  constructor(capacity = 1024) {
    let size = 1024;
    while (size < capacity * 2) size *= 2;
    this.keys = new Float64Array(size);
    this.days = new Uint16Array(size);
  }

  static decode(bytes: Uint8Array | undefined): Seen {
    if (!bytes || bytes.byteLength < 4) return new Seen();
    const copy = new Uint8Array(bytes); // aligned
    const n = new DataView(copy.buffer).getUint32(0, true);
    if (copy.byteLength !== 8 + n * 10) return new Seen();
    const keys = new Float64Array(copy.buffer, 8, n);
    const days = new Uint16Array(copy.buffer, 8 + n * 8, n);
    const seen = new Seen(n + 1024);
    for (let i = 0; i < n; i++) seen.insert(keys[i]!, days[i]!);
    return seen;
  }

  /** True when `key` was new (and is now counted). */
  add(key: number, ms: number): boolean {
    if (!this.insert(key, dayNumber(ms))) return false;
    this.added++;
    return true;
  }

  /** Whether anything was added since load. */
  get changed(): boolean {
    return this.added > 0;
  }

  get size(): number {
    return this.count;
  }

  private insert(raw: number, day: number): boolean {
    const key = raw === 0 ? 1 : raw; // 0 marks an empty slot
    const mask = this.keys.length - 1;
    let i = (key % 4294967296) & mask;
    for (;;) {
      const v = this.keys[i]!;
      if (v === key) return false;
      if (v === 0) break;
      i = (i + 1) & mask;
    }
    this.keys[i] = key;
    this.days[i] = day;
    if (++this.count * 2 > this.keys.length) this.grow();
    return true;
  }

  private grow() {
    const { keys, days } = this;
    this.keys = new Float64Array(keys.length * 2);
    this.days = new Uint16Array(days.length * 2);
    this.count = 0;
    for (let i = 0; i < keys.length; i++) if (keys[i] !== 0) this.insert(keys[i]!, days[i]!);
  }

  /** Without keys older than `keepDays` before `now`. */
  encode(now: number, keepDays: number): Uint8Array {
    const cutoff = dayNumber(now) - keepDays;
    let n = 0;
    for (let i = 0; i < this.keys.length; i++) if (this.keys[i] !== 0 && this.days[i]! >= cutoff) n++;
    const out = new Uint8Array(8 + n * 10);
    new DataView(out.buffer).setUint32(0, n, true);
    const keys = new Float64Array(out.buffer, 8, n);
    const days = new Uint16Array(out.buffer, 8 + n * 8, n);
    let j = 0;
    for (let i = 0; i < this.keys.length; i++) {
      if (this.keys[i] === 0 || this.days[i]! < cutoff) continue;
      keys[j] = this.keys[i]!;
      days[j++] = this.days[i]!;
    }
    return out;
  }
}

export interface ScanInput {
  roots: Roots;
  state: ScanState;
  totals: Totals;
  seen: Seen;
  book: AccountBook;
  repoOf: (cwd: string) => { key: string; label: string };
  onProgress?: (p: Progress) => void;
  /** Bytes per read; lines longer than this are skipped through and read back only if they hold a row. */
  chunk?: number;
  /** Asked before each log; true ends the scan there. */
  stop?: () => boolean;
}

/** Local calendar day of an epoch ms, cached per quarter hour (no zone offset is finer). */
function dayCutter() {
  const cache = new Map<number, string>();
  return (ms: number): string => {
    const q = Math.floor(ms / 900_000);
    let d = cache.get(q);
    if (d === undefined) {
      const t = new Date(q * 900_000);
      d = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
      cache.set(q, d);
    }
    return d;
  };
}

export function scan(input: ScanInput): ScanResult {
  const { roots, state, totals, seen, book } = input;
  const started = performance.now();
  const r: ScanResult = { files: 0, read: 0, bytes: 0, rows: 0, duplicates: 0, fallback: 0, fallbackMax: 0, skipped: 0, stopped: false, ms: 0 };
  const dayOf = dayCutter();
  const names = new Map<number, string>(); // interned model names by hash of their bytes

  const add = (day: string, key: string, v: Sum) => {
    const d = totals.days[day] ?? (totals.days[day] = {});
    const a = d[key] ?? (d[key] = [0, 0, 0, 0, 0, 0, 0]);
    for (let i = 0; i < 7; i++) a[i]! += v[i]!;
    if (!totals.logsFrom || day < totals.logsFrom) totals.logsFrom = day;
  };
  const repoKey = (cwd: string) => {
    let key = state.cwds[cwd];
    if (key === undefined) {
      const repo = input.repoOf(cwd);
      key = state.cwds[cwd] = repo.key;
      totals.repos[repo.key] = repo.label;
    }
    return key;
  };

  // ── Directory walk, reusing the listing of any directory whose mtime did not move ──
  const live = new Set<string>();
  function list(dir: string): [number, string[], string[]] | undefined {
    let mtime: number;
    try { mtime = statSync(dir).mtimeMs; } catch { delete state.dirs[dir]; return undefined; }
    live.add(dir);
    const cached = state.dirs[dir];
    if (cached && cached[0] === mtime) return cached;
    const subdirs: string[] = [], logs: string[] = [];
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) { if (e.name !== "tool-results") subdirs.push(e.name); }
        else if (e.isFile() && e.name.endsWith(".jsonl")) logs.push(e.name);
      }
    } catch { return undefined; }
    return (state.dirs[dir] = [mtime, subdirs, logs]);
  }
  function walk(dir: string, out: string[], test: (name: string) => boolean) {
    const entry = list(dir);
    if (!entry) return;
    for (const f of entry[2]) if (test(f)) out.push(join(dir, f));
    for (const d of entry[1]) walk(join(dir, d), out, test);
  }

  type Job = { path: string; key: string; size: number; agent: "claude" | "codex"; configDir: string; session?: string };
  const jobs: Job[] = [];
  const liveFiles = new Set<string>();
  const queue = (path: string, key: string, agent: Job["agent"], configDir: string, session?: string) => {
    r.files++;
    liveFiles.add(key);
    let size: number;
    try { size = statSync(path).size; } catch { return; }
    const entry = state.files[key];
    if (entry && entry.s === size && entry.o <= size) return;
    jobs.push({ path, key, size, agent, configDir, session });
  };
  for (const { configDir } of roots.claude) {
    const logs: string[] = [];
    const projects = join(configDir, "projects");
    walk(projects, logs, () => true);
    for (const path of logs) {
      // <project>/<session>.jsonl, or <project>/<session>/subagents/agent-<id>.jsonl
      const rel = path.slice(projects.length + 1).split("/");
      const session = rel.length === 2 ? basename(rel[1]!, ".jsonl") : rel[1];
      queue(path, path, "claude", configDir, session);
    }
  }
  for (const home of roots.codex) {
    for (const sub of ["sessions", "archived_sessions"]) {
      const logs: string[] = [];
      walk(join(home, sub), logs, (n) => n.startsWith("rollout-"));
      for (const path of logs) queue(path, `codex:${basename(path, ".jsonl")}`, "codex", home);
    }
  }
  // Forget what no longer exists, so the state does not grow with deleted history.
  for (const dir of Object.keys(state.dirs)) if (!live.has(dir)) delete state.dirs[dir];
  for (const key of Object.keys(state.files)) if (!liveFiles.has(key)) delete state.files[key];

  const progress: Progress = { files: 0, totalFiles: jobs.length, bytes: 0, totalBytes: 0 };
  for (const j of jobs) progress.totalBytes += j.size - Math.min(state.files[j.key]?.o ?? 0, j.size);
  let lastReport = 0;

  const fields = new Int32Array(USAGE_KEYS.length);
  const ephemeral = new Int32Array(1);
  const row: Sum = [0, 0, 0, 0, 0, 0, 0];

  // ── Claude: one assistant row per content block, deduplicated by message id + request id ──
  function claudeRow(b: Uint8Array, ls: number, le: number, m: number, job: Job, entry: FileEntry, cache: KeyCache) {
    const bb = b as Buffer;
    const t = bb.indexOf(T_ASSIST, m);
    if (t < 0 || t > le) {
      // Not the assistant row shape we know. Tool results carry `usage` too; only an assistant row is billed.
      const a = bb.indexOf(ASSISTANT, ls);
      return a >= 0 && a < le ? claudeFallback(b, ls, le, job, entry, cache) : undefined;
    }
    const mi = bb.indexOf(MSG_MODEL, ls);
    if (mi < 0 || mi > m) return claudeFallback(b, ls, le, job, entry, cache);
    const u0 = bb.lastIndexOf(USAGE, t);
    const open = u0 + USAGE.length - 1;
    const close = objectEnd(b, open, t);
    const modelFrom = mi + MSG_MODEL.length;
    const modelTo = stringEnd(b, modelFrom, m);
    const idFrom = modelTo + 1 + ID_AFTER_MODEL.length;
    const idTo = bytesEqual(b, modelTo + 1, ID_AFTER_MODEL) ? stringEnd(b, idFrom, m) : -1;
    const ri = bb.lastIndexOf(REQUEST_ID, t);
    const reqFrom = ri + REQUEST_ID.length;
    const reqTo = ri > close ? stringEnd(b, reqFrom, t) : -1;
    const ts = bb.indexOf(TIMESTAMP, t);
    if (close < 0 || modelTo < 0 || idTo < 0 || !bytesEqual(b, idFrom, MSG_PREFIX) || reqTo < 0 || ts < 0 || ts > le) {
      return claudeFallback(b, ls, le, job, entry, cache);
    }
    const ms = isoMsAt(b, ts + TIMESTAMP.length);
    if (!Number.isFinite(ms)) return claudeFallback(b, ls, le, job, entry, cache);
    if (entry.r === undefined) {
      const c = bb.indexOf(CWD, t);
      const ce = c > 0 && c < le ? stringEnd(b, c + CWD.length, le) : -1;
      if (ce > 0) entry.r = repoKey(text(b, c + CWD.length, ce));
    }
    topLevelFields(b, open, close, USAGE_KEYS, fields);
    let write1h = 0;
    if (fields[4]! > 0 && b[fields[4]!] === 0x7b) {
      const end = objectEnd(b, fields[4]!, close + 1);
      if (end > 0) { topLevelFields(b, fields[4]!, end, EPHEMERAL_KEYS, ephemeral); if (ephemeral[0]! > 0) write1h = uintAt(b, ephemeral[0]!); }
    }
    const nameHash = hashRanges(b, modelFrom, modelTo, 0, 0);
    let model = names.get(nameHash);
    if (model === undefined) names.set(nameHash, (model = text(b, modelFrom, modelTo)));
    const fast = fields[5]! > 0 && bytesEqual(b, fields[5]!, FAST);
    count(job, entry, cache, {
      key: hashRanges(b, idFrom, idTo, reqFrom, reqTo), ms, model, fast,
      input: fields[0]! > 0 ? uintAt(b, fields[0]!) : 0,
      output: fields[1]! > 0 ? uintAt(b, fields[1]!) : 0,
      write: fields[2]! > 0 ? uintAt(b, fields[2]!) : 0,
      read: fields[3]! > 0 ? uintAt(b, fields[3]!) : 0,
      write1h,
    });
  }

  /** A row the fast path cannot vouch for: parse it whole. Same result, slower. */
  function claudeFallback(b: Uint8Array, ls: number, le: number, job: Job, entry: FileEntry, cache: KeyCache) {
    r.fallback++;
    r.fallbackMax = Math.max(r.fallbackMax, le - ls);
    let parsed: unknown;
    try { parsed = JSON.parse(text(b, ls, le)); } catch { r.skipped++; return; }
    const o = parsed as { type?: unknown; cwd?: unknown; requestId?: unknown; timestamp?: unknown; message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown> } };
    if (entry.r === undefined && typeof o.cwd === "string") entry.r = repoKey(o.cwd);
    const u = o.message?.usage;
    const ms = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
    if (o.type !== "assistant" || !u || typeof u !== "object" || !Number.isFinite(ms)) return;
    const n = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);
    const id = typeof o.message?.id === "string" ? o.message.id : "";
    const req = typeof o.requestId === "string" ? o.requestId : "";
    const keyBytes = Buffer.from(id + req);
    count(job, entry, cache, {
      key: id && req ? hashRanges(keyBytes, 0, keyBytes.length, 0, 0) : undefined,
      ms, model: typeof o.message?.model === "string" ? o.message.model : "unknown", fast: u.speed === "fast",
      input: n(u.input_tokens), output: n(u.output_tokens), write: n(u.cache_creation_input_tokens), read: n(u.cache_read_input_tokens),
      write1h: n((u.cache_creation as Record<string, unknown> | undefined)?.ephemeral_1h_input_tokens),
    });
  }

  type KeyCache = { day: string; account: string; model: string; sum: Sum | undefined };
  function count(job: Job, entry: FileEntry, cache: KeyCache, x: { key: number | undefined; ms: number; model: string; fast: boolean; input: number; output: number; write: number; read: number; write1h: number }) {
    if (x.model === "<synthetic>") return;
    if (x.key !== undefined && !seen.add(x.key, x.ms)) { r.duplicates++; return; }
    r.rows++;
    let model = x.fast ? `${x.model}+fast` : x.model;
    if (model.startsWith("claude-haiku-5-5") && x.input + x.read + x.write > 100_000) model = `${x.model}+long`;
    const day = dayOf(x.ms);
    const account = book.claude(job.configDir, job.session, x.ms);
    if (cache.sum === undefined || cache.day !== day || cache.account !== account || cache.model !== model) {
      const key = `claude|${account}|${model}|${entry.r ?? "?"}`;
      const d = totals.days[day] ?? (totals.days[day] = {});
      cache.sum = d[key] ?? (d[key] = [0, 0, 0, 0, 0, 0, 0]);
      cache.day = day; cache.account = account; cache.model = model;
      if (!totals.logsFrom || day < totals.logsFrom) totals.logsFrom = day;
    }
    const s = cache.sum;
    s[0]! += 1; s[1]! += x.input; s[2]! += x.output; s[3]! += Math.max(0, x.write - x.write1h); s[4]! += x.write1h; s[5]! += x.read;
  }

  // ── Codex: per-session cumulative totals; a row adds the difference from the previous one ──
  function codexRow(b: Uint8Array, ls: number, le: number, m: number, entry: FileEntry) {
    const bb = b as Buffer;
    if (bytesEqual(b, m, CODEX_MARKERS[2]!)) {
      const a = bb.indexOf(CREATOR, ls);
      const ae = a > 0 && a < le ? stringEnd(b, a + CREATOR.length, le) : -1;
      entry.a = codexAccount(ae > 0 ? text(b, a + CREATOR.length, ae) : undefined);
      const c = bb.indexOf(CWD, ls);
      const ce = c > 0 && c < le ? stringEnd(b, c + CWD.length, le) : -1;
      if (ce > 0) entry.r = repoKey(text(b, c + CWD.length, ce));
      return;
    }
    if (bytesEqual(b, m, CODEX_MARKERS[1]!)) {
      const mo = bb.indexOf(MODEL, m);
      const me = mo > 0 && mo < le ? stringEnd(b, mo + MODEL.length, le) : -1;
      if (me > 0) {
        const h = hashRanges(b, mo + MODEL.length, me, 0, 0);
        let model = names.get(h);
        if (model === undefined) names.set(h, (model = text(b, mo + MODEL.length, me)));
        entry.m = model;
      }
      return;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text(b, ls, le)); } catch { r.skipped++; return; }
    const o = parsed as { timestamp?: unknown; payload?: { type?: unknown; info?: { total_token_usage?: Record<string, unknown>; last_token_usage?: Record<string, unknown> }; rate_limits?: Record<string, unknown> } };
    if (o.payload?.type !== "token_count") return;
    const ms = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
    if (!Number.isFinite(ms)) return;
    const account = entry.a ?? UNASSIGNED.codex;
    if (o.payload.rate_limits) noteCodexLimits(account, ms, o.payload.rate_limits);
    const total = o.payload.info?.total_token_usage;
    if (!total) return;
    const n = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);
    const cols = (u: Record<string, unknown> | undefined) => [n(u?.input_tokens), n(u?.cached_input_tokens), n(u?.output_tokens), n(u?.reasoning_output_tokens), n(u?.cache_write_input_tokens)];
    const now = cols(total);
    const prev = entry.t ?? [0, 0, 0, 0, 0];
    let d = now.map((v, i) => v - prev[i]!);
    // A counter that went down was reset (a resumed or compacted session): this row's own usage.
    if (d.some((v) => v < 0)) d = cols(o.payload.info?.last_token_usage);
    entry.t = now;
    if (d.every((v) => v === 0)) return;
    r.rows++;
    // Same columns as Claude: input is the uncached part, cached input is the cache read.
    row[0] = 1; row[1] = Math.max(0, d[0]! - d[1]!); row[2] = d[2]!; row[3] = d[4]!; row[4] = 0; row[5] = d[1]!; row[6] = d[3]!;
    add(dayOf(ms), `codex|${account}|${entry.m ?? "unknown"}|${entry.r ?? "?"}`, row);
  }

  function noteCodexLimits(account: string, ms: number, raw: Record<string, unknown>) {
    const prev = totals.codexLimits[account];
    if (prev && prev.observedAt >= ms) return;
    const windows: CodexLimits["windows"] = [];
    for (const name of ["primary", "secondary"]) {
      const w = raw[name] as Record<string, unknown> | null | undefined;
      if (!w || typeof w.used_percent !== "number" || typeof w.window_minutes !== "number") continue;
      windows.push({ windowMinutes: w.window_minutes, usedPercent: w.used_percent, ...(typeof w.resets_at === "number" ? { resetsAt: w.resets_at } : {}) });
    }
    totals.codexLimits[account] = { observedAt: ms, ...(typeof raw.plan_type === "string" ? { plan: raw.plan_type } : {}), windows };
  }

  // ── Reading: whole lines only, a chunk at a time, markers found in bytes ──
  const CHUNK = input.chunk ?? 1 << 20;
  const buf = Buffer.allocUnsafe(CHUNK);
  const claudeMarkers = [USAGE];
  const next = [-2, -2, -2];
  for (const job of jobs) {
    if (input.stop?.()) { r.stopped = true; break; }
    const entry = state.files[job.key] ?? (state.files[job.key] = { o: 0, s: 0 });
    if (job.size < entry.o) { entry.o = 0; entry.t = undefined; } // rewritten: start over
    const markers = job.agent === "claude" ? claudeMarkers : CODEX_MARKERS;
    const cache: KeyCache = { day: "", account: "", model: "", sum: undefined };
    const handle = (b: Uint8Array, ls: number, le: number, m: number) =>
      job.agent === "claude" ? claudeRow(b, ls, le, m, job, entry, cache) : codexRow(b, ls, le, m, entry);
    let fd: number;
    try { fd = openSync(job.path, "r"); } catch { continue; }
    r.read++;
    let pos = entry.o, have = 0;
    let longStart = -1, longMarked = false;
    try {
      while (pos < job.size) {
        const n = readSync(fd, buf, have, Math.min(buf.length - have, job.size - pos), pos);
        if (n <= 0) break;
        const base = pos - have;
        pos += n; have += n; r.bytes += n; progress.bytes += n;
        let from = 0;
        if (longStart >= 0) {
          const nl = buf.indexOf(10, 0);
          const end = nl < 0 || nl >= have ? have : nl;
          if (!longMarked) for (const mk of markers) { const i = buf.indexOf(mk, 0); if (i >= 0 && i < end) { longMarked = true; break; } }
          if (nl < 0 || nl >= have) { have = 0; continue; }
          if (longMarked) {
            const line = Buffer.allocUnsafe(base + nl - longStart);
            readSync(fd, line, 0, line.length, longStart);
            const lm = Math.min(...markers.map((mk) => line.indexOf(mk)).filter((i) => i >= 0));
            if (Number.isFinite(lm)) handle(line, 0, line.length, lm);
          }
          longStart = -1; longMarked = false; from = nl + 1;
        }
        const lastNl = buf.lastIndexOf(10, have - 1);
        const end = lastNl < from ? from : lastNl + 1;
        next.fill(-2);
        while (from < end) {
          let m = -1;
          for (let k = 0; k < markers.length; k++) {
            if (next[k] !== -1 && next[k]! < from) next[k] = buf.indexOf(markers[k]!, from);
            const i = next[k]!;
            if (i >= 0 && i < end && (m < 0 || i < m)) m = i;
          }
          if (m < 0) break;
          const ls = Math.max(from, buf.lastIndexOf(10, m) + 1);
          const le = buf.indexOf(10, m);
          handle(buf, ls, le, m);
          from = le + 1;
        }
        const tail = have - end;
        if (tail === buf.length) {
          // One line fills the buffer: skip through it, remembering whether it held a marker.
          longStart = base + end;
          longMarked = markers.some((mk) => buf.indexOf(mk) >= 0);
          have = 0;
        } else {
          buf.copy(buf, 0, end, have);
          have = tail;
        }
      }
    } finally {
      closeSync(fd);
    }
    entry.o = longStart >= 0 ? longStart : pos - have;
    entry.s = job.size;
    progress.files++;
    const now = performance.now();
    if (input.onProgress && now - lastReport > 250) { lastReport = now; input.onProgress({ ...progress }); }
  }
  r.ms = Math.round(performance.now() - started);
  return r;
}

// ── The store on disk: <stateDir>/usage/{totals.json, scan.<gen>.json, seen.<gen>.bin} ──

export interface Store { totals: Totals; state: ScanState; seen: Seen }

export const usageDir = (stateDir: string) => join(stateDir, "usage");

const readJson = (path: string): unknown => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
};

export function emptyTotals(today: string, tz: string): Totals {
  return { v: 1, tz, trackedFrom: today, days: {}, repos: {}, codexLimits: {} };
}

/** The totals as saved, or undefined before the first scan. Read by the bridge too. */
export function readTotals(stateDir: string): Totals | undefined {
  const t = readJson(join(usageDir(stateDir), "totals.json")) as Totals | undefined;
  return t && t.v === 1 && typeof t.days === "object" ? t : undefined;
}

export function loadStore(stateDir: string, today: string, tz: string): Store {
  const dir = usageDir(stateDir);
  const totals = readTotals(stateDir);
  const state = totals?.files && (readJson(join(dir, `scan.${totals.files.gen}.json`)) as ScanState | undefined);
  // Totals without the offsets they were counted with would be counted again: start over instead.
  if (!totals || !state || state.v !== 1) return { totals: emptyTotals(today, tz), state: { v: 1, files: {}, dirs: {}, cwds: {} }, seen: new Seen() };
  let seenBytes: Uint8Array | undefined;
  try { seenBytes = readFileSync(join(dir, `seen.${totals.files!.seen}.bin`)); } catch { /* none kept */ }
  return { totals, state, seen: Seen.decode(seenBytes) };
}

/** Days of message keys kept for cross-file deduplication; Claude Code deletes transcripts at 30. */
const SEEN_DAYS = 90;

/**
 * One rename commits a save. The offsets and the seen set go to new names first, and totals.json, which
 * names them, goes last: a scan stopped anywhere (a restart kills it, kill -9) leaves the last save
 * whole, so a log is never counted twice or skipped. The bridge reads totals.json alone.
 */
export function saveStore(stateDir: string, store: Store, now = Date.now()): void {
  const dir = usageDir(stateDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const put = (name: string, data: string | Uint8Array) => {
    const path = join(dir, name);
    writeFileSync(`${path}.tmp`, data, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  };
  const prev = store.totals.files;
  const gen = (prev?.gen ?? 0) + 1;
  const seen = prev && !store.seen.changed ? prev.seen : gen;
  if (seen === gen) put(`seen.${gen}.bin`, store.seen.encode(now, SEEN_DAYS));
  put(`scan.${gen}.json`, JSON.stringify(store.state));
  put("totals.json", JSON.stringify({ ...store.totals, files: { gen, seen } }));
  // What this save replaced, and what a stopped one left behind.
  for (const name of readdirSync(dir)) {
    const m = /^(scan|seen)\.(\d+)\./.exec(name);
    if (m && Number(m[2]) !== (m[1] === "scan" ? gen : seen)) rmSync(join(dir, name), { force: true });
  }
}
