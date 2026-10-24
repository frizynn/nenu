import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { PrefsFile } from "../prefs-file.ts";
import type { RateLimit } from "../journal/types.ts";
import type { UsageResponse, UsageScan } from "../types.ts";
import type { AccountsFile, ScanArgs } from "./scan-main.ts";
import type { Totals } from "./scan.ts";

// The bridge's side of usage: the Settings switches, and when a scan runs. Off, it is one small
// prefs read at boot and nothing else: no process, no read of any log, no timer (ADR 0085).
//
// A scan runs as its own process, at background priority after the first pass, so its memory goes
// back to the system the moment it ends. It starts when tracking is turned on, when the view asks and the last scan is over
// a minute old, and when an agent finishes a turn and the last scan is over six hours old, so logs
// are counted before Claude Code deletes them at 30 days even if nobody opens the view.

export interface UsagePrefs { on: boolean; splitByAccount: boolean }
export const coerceUsagePrefs = (raw: unknown): UsagePrefs => {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return { on: o.on === true, splitByAccount: o.splitByAccount === true };
};

export interface UsageService {
  read(opts?: { account?: string; fresh?: boolean }): Promise<UsageResponse>;
  set(patch: Partial<UsagePrefs>): Promise<UsageResponse>;
  /** An agent finished a turn (Herdr's status change to idle or done). */
  turnEnded(): void;
  /** The weekly window of the account a Claude session bills, from the last scan, while tracking is on. */
  claudeWeekly(session: string): RateLimit | undefined;
  stop(): void;
}

export const NO_USAGE: UsageService = {
  read: async () => ({ on: false, splitByAccount: false }),
  set: async () => ({ on: false, splitByAccount: false }),
  turnEnded() {},
  claudeWeekly: () => undefined,
  stop() {},
};

export interface ScanChild {
  lines: AsyncIterable<string>;
  exited: Promise<number>;
  kill(): void;
}

/** Background priority where the platform has it: taskpolicy -b (macOS), nice 19 (Linux). */
export function backgroundPrefix(platform = process.platform, which: (bin: string) => string | null = Bun.which, exists = existsSync): string[] {
  if (platform === "darwin" && exists("/usr/sbin/taskpolicy")) return ["/usr/sbin/taskpolicy", "-b"];
  const nice = which("nice");
  return nice ? [nice, "-n", "19"] : [];
}

async function* linesOf(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let rest = "";
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    rest += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = rest.indexOf("\n")) >= 0) {
      yield rest.slice(0, nl);
      rest = rest.slice(nl + 1);
    }
  }
}

/**
 * The first pass runs at normal priority because the operator is watching its progress (measured on a
 * large history: 5.6 s, against 35 s under `taskpolicy -b`, which throttles disk reads); every later
 * scan reads only what was appended and runs in the background.
 */
export function spawnScan(stateDir: string, args: ScanArgs, firstPass = false): ScanChild {
  const script = join(import.meta.dir, "scan-main.ts");
  const child = Bun.spawn([...(firstPass ? [] : backgroundPrefix()), process.execPath, script, stateDir, JSON.stringify(args)], {
    stdin: "ignore", stdout: "pipe", stderr: "ignore",
  });
  return { lines: linesOf(child.stdout), exited: child.exited, kill: () => child.kill() };
}

const FRESH_MS = 60_000;
const CATCH_UP_MS = 6 * 60 * 60_000;
/** How long a view waits for a scan before answering with what is saved. */
const WAIT_MS = 300;
/** Progress is announced at most this often, so the first pass's screen moves without a poll. */
const PROGRESS_EVERY_MS = 1000;
/** A scan reports after every log it reads; one silent this long is stuck (a stalled disk) and is stopped. */
const QUIET_MS = 5 * 60_000;

export interface UsageDeps {
  stateDir: string;
  /** Claude config dirs and Codex homes, as the journal roots name them. */
  roots: { claude: string[]; codex: string[] };
  /** A scan moved on or finished: tell open pages to re-read (at most once a second while it runs). */
  onScanned: () => void;
  spawn?: (stateDir: string, args: ScanArgs, firstPass: boolean) => ScanChild;
  now?: () => number;
  quietMs?: number;
}

export class Usage implements UsageService {
  private readonly prefs: PrefsFile<UsagePrefs>;
  private child: ScanChild | undefined;
  private running: Promise<void> | undefined;
  private progress: Pick<UsageScan, "files" | "totalFiles" | "bytes" | "totalBytes"> | undefined;
  private error: string | undefined;
  private scannedAt: number | undefined;
  /** When the last scan ended, however it ended: a failed one waits as long as a finished one. */
  private endedAt: number | undefined;
  private readonly now: () => number;

  constructor(private readonly deps: UsageDeps) {
    this.prefs = new PrefsFile(join(deps.stateDir, "usage-prefs.json"), coerceUsagePrefs);
    this.now = deps.now ?? Date.now;
  }

  async load(): Promise<void> {
    await this.prefs.load();
  }

  private accountsFile(): AccountsFile | undefined {
    try {
      const file = JSON.parse(readFileSync(join(this.deps.stateDir, "usage", "accounts.json"), "utf8")) as AccountsFile;
      return file.v === 1 ? file : undefined;
    } catch {
      return undefined;
    }
  }

  /** The accounts file as last parsed, re-read only when the scan rewrote it: every open pane's read asks. */
  private accounts: { mtime: number; file: AccountsFile | undefined } | undefined;
  private cachedAccounts(): AccountsFile | undefined {
    let mtime: number;
    try { mtime = statSync(join(this.deps.stateDir, "usage", "accounts.json")).mtimeMs; } catch { return undefined; }
    if (this.accounts?.mtime !== mtime) this.accounts = { mtime, file: this.accountsFile() };
    return this.accounts.file;
  }

  claudeWeekly(session: string) {
    return this.prefs.current().on ? sessionWeekly(this.cachedAccounts(), session, this.now()) : undefined;
  }

  private lastScan(): number | undefined {
    return this.scannedAt ?? (this.scannedAt = this.accountsFile()?.at);
  }

  private scan(): Promise<void> {
    if (this.running) return this.running;
    const prefs = this.prefs.current();
    const child = (this.deps.spawn ?? spawnScan)(this.deps.stateDir, { ...this.deps.roots, split: prefs.splitByAccount }, this.lastScan() === undefined);
    this.child = child;
    this.error = undefined;
    this.running = (async () => {
      let done = false;
      let announced = this.now();
      const quiet = setTimeout(() => child.kill(), this.deps.quietMs ?? QUIET_MS);
      try {
        for await (const line of child.lines) {
          quiet.refresh();
          let msg: { progress?: UsageScan; done?: unknown };
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.progress) {
            const { files, totalFiles, bytes, totalBytes } = msg.progress;
            this.progress = { files, totalFiles, bytes, totalBytes };
            if (this.now() - announced >= PROGRESS_EVERY_MS) {
              announced = this.now();
              this.deps.onScanned();
            }
          }
          if (msg.done) done = true;
        }
        const code = await child.exited;
        if (!done) this.error = `scan stopped (exit ${code})`;
      } catch (err) {
        this.error = (err as Error).message.slice(0, 200);
      } finally {
        clearTimeout(quiet);
        this.endedAt = this.now();
        if (done) this.scannedAt = this.endedAt;
        this.child = undefined;
        this.running = undefined;
        this.progress = undefined;
        this.deps.onScanned();
      }
    })();
    return this.running;
  }

  private scanState(totals: Totals | undefined): UsageScan {
    return {
      state: this.running ? "scanning" : "idle",
      firstPass: !totals,
      ...(this.running && this.progress ? this.progress : {}),
      ...(this.lastScan() ? { scannedAt: this.lastScan() } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  async read(opts: { account?: string; fresh?: boolean } = {}): Promise<UsageResponse> {
    const prefs = this.prefs.current();
    if (!prefs.on) return { on: false, splitByAccount: prefs.splitByAccount };
    const last = this.endedAt ?? this.lastScan();
    if (opts.fresh || last === undefined || this.now() - last > FRESH_MS) {
      const running = this.scan();
      await Promise.race([running, Bun.sleep(WAIT_MS)]);
    }
    // Loaded on the first read while on, so a bridge with usage off holds none of this code.
    const [{ readTotals }, { buildReport, emptyReport }] = await Promise.all([import("./scan.ts"), import("./report.ts")]);
    const totals = readTotals(this.deps.stateDir);
    const scan = this.scanState(totals);
    if (!totals) return emptyReport(prefs.splitByAccount, scan, this.now());
    return buildReport({ totals, accounts: this.accountsFile(), splitByAccount: prefs.splitByAccount, scan, now: this.now(), account: opts.account });
  }

  async set(patch: Partial<UsagePrefs>): Promise<UsageResponse> {
    const prev = this.prefs.current();
    const next = { ...prev, ...patch };
    await this.prefs.set(next);
    if (!next.on) this.child?.kill();
    // Split decides which limit caches the scan reads, so a change shows at once.
    return this.read({ fresh: next.on && next.splitByAccount !== prev.splitByAccount });
  }

  turnEnded(): void {
    if (!this.prefs.current().on || this.running) return;
    const last = this.endedAt ?? this.lastScan();
    if (last === undefined || this.now() - last > CATCH_UP_MS) void this.scan();
  }

  stop(): void {
    this.child?.kill();
  }
}

/**
 * The weekly window of the account the scan named for a Claude session, the way Settings → Usage counts
 * that session's tokens, while the window it was read in has not reset. A session the scan has not seen,
 * or one no account was named for, has none: never the account signed in now, which another config dir
 * or a switch since may have made someone else's (ADR 0125).
 */
export function sessionWeekly(file: AccountsFile | undefined, session: string, now: number): RateLimit | undefined {
  const sessions = file?.sessions;
  const account = sessions && typeof sessions === "object" && Object.hasOwn(sessions, session) ? sessions[session] : undefined;
  const week = typeof account === "string" && file?.weekly && Object.hasOwn(file.weekly, account) ? file.weekly[account] : undefined;
  if (typeof week?.usedPercent !== "number" || typeof week.resetsAt !== "number" || typeof week.observedAt !== "number") return undefined;
  if (week.resetsAt * 1000 <= now) return undefined;
  return { name: "secondary", usedPercent: week.usedPercent, windowMinutes: 10080, resetsAt: week.resetsAt, observedAt: week.observedAt };
}

/** The bridge's Claude config dirs and Codex homes, from the journal roots (`<dir>/projects`, `<home>/sessions`). */
export function usageRoots(journalRoots: { claude: readonly string[]; codex: readonly string[] }) {
  return { claude: journalRoots.claude.map((r) => dirname(r)), codex: journalRoots.codex.map((r) => dirname(r)) };
}
