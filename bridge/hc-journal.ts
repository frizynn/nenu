import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { MAX_TRANSCRIPT_BYTES } from "./journal/files.ts";

// Another machine's Claude log, copied beside this bridge so the journal reads it like any other
// (ADR 0135). hc reaches that machine's files; the adapters read local ones and pin them to a root,
// so a copy under one more root changes nothing about how a log is parsed, watched or contained.
// A copy lives only while someone reads it, and the whole folder goes at start.

/** Runs one program on a machine: its stdout's bytes, or a throw when it fails. */
export type HcExec = (machine: string, argv: string[], timeoutMs: number) => Promise<Uint8Array>;

/** Where the copies live, under the state directory (never served: ADR 0074's `nenuDirs`). */
export const hcJournalDir = (stateDir: string): string => join(stateDir, "hc-journals");
/** The journal root that holds them. */
export const hcJournalRoot = (stateDir: string): string => join(hcJournalDir(stateDir), "projects");

const SESSION_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const FOLLOW_MS = 1_000;
/** A chat left alone stops being followed after this long, and its copy goes after the longer one. */
const QUIET_MS = 60_000;
const FORGET_MS = 5 * 60_000;
/** The first read of a chat waits this long; past it the copy keeps coming and the next read has it. */
const FIRST_READ_MS = 8_000;
const EXEC_MS = 60_000;
/**
 * Bytes one read brings, well under the 8 MB hc exec keeps of what a program prints: the first is small
 * so a chat opens on its last turns at once (~3 MB/s to another machine), the rest fill in its past.
 */
export const HC_READS = { first: 1024 * 1024, chunk: 2 * 1024 * 1024, cap: MAX_TRANSCRIPT_BYTES };

// One read: `<size> <start> <length> <older start> <older length>`, the bytes the copy lacks at its
// end, then older bytes before its start while the chunk has room, back to `cap` from the end. The
// newest come first, so a long chat opens on its last turns and its past fills in behind them. The id
// is a checked uuid and travels as an argument.
export const READ_NEW = `id=$1; end=$2; from=$3; cap=$4; chunk=$5
for f in "$HOME"/.claude*/projects/*/"$id".jsonl; do
  [ -f "$f" ] || continue
  s=$(wc -c <"$f"); s=$((s+0)); floor=$((s > cap ? s - cap : 0))
  if [ "$end" -lt 0 ] || [ "$end" -gt "$s" ] || [ $((s - end)) -gt "$chunk" ]; then
    end=$((s - chunk)); [ "$end" -lt "$floor" ] && end=$floor; from=$end
  fi
  len=$((s - end)); old=$((from - (chunk - len))); [ "$old" -lt "$floor" ] && old=$floor
  olen=$((from - old)); [ "$olen" -lt 0 ] && olen=0
  echo "$s $end $len $old $olen"
  [ "$len" -gt 0 ] && tail -c +$((end + 1)) "$f" | head -c "$len"
  [ "$olen" -gt 0 ] && tail -c +$((old + 1)) "$f" | head -c "$olen"
  exit 0
done
exit 3`;

interface Copy {
  path: string;
  /** The machine's log bytes [from, offset) are in the copy; both -1 until its first read. */
  from: number;
  offset: number;
  readAt: number;
  running: Promise<void> | null;
  timer?: ReturnType<typeof setTimeout>;
}

export class HcJournalMirror {
  private readonly copies = new Map<string, Copy>();
  constructor(
    private readonly dir: string,
    private readonly exec: HcExec,
    private readonly now: () => number = Date.now,
    private readonly limits = HC_READS,
  ) {}

  /** Drop what an earlier run left: a copy is only as good as the follow that keeps it current. */
  async reset(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }

  /** Someone reads this chat: bring its copy up to date and keep it there for a while. */
  async follow(machine: string, sessionId: string): Promise<void> {
    if (!SESSION_ID.test(sessionId)) return;
    const key = `${machine}\0${sessionId}`;
    let copy = this.copies.get(key);
    if (!copy) {
      const folder = createHash("sha256").update(machine).digest("hex").slice(0, 16);
      copy = { path: join(this.dir, "projects", folder, `${sessionId}.jsonl`), from: -1, offset: -1, readAt: 0, running: null };
      this.copies.set(key, copy);
    }
    copy.readAt = this.now();
    const read = this.sync(machine, copy);
    if (copy.timer === undefined) this.schedule(key, machine, copy);
    // Only the first read waits: after it the copy is at most a beat behind, and a new row announces itself.
    if (copy.offset < 0) await Promise.race([read, Bun.sleep(FIRST_READ_MS)]);
  }

  stop(): void {
    for (const copy of this.copies.values()) clearTimeout(copy.timer);
    this.copies.clear();
  }

  private schedule(key: string, machine: string, copy: Copy): void {
    copy.timer = setTimeout(() => {
      const quiet = this.now() - copy.readAt;
      if (quiet > FORGET_MS) {
        this.copies.delete(key);
        void rm(copy.path, { force: true });
        return;
      }
      if (quiet <= QUIET_MS) void this.sync(machine, copy);
      this.schedule(key, machine, copy);
    }, FOLLOW_MS);
    copy.timer.unref?.();
  }

  private sync(machine: string, copy: Copy): Promise<void> {
    copy.running ??= this.pull(machine, copy).catch(() => {}).finally(() => { copy.running = null; });
    return copy.running;
  }

  private async pull(machine: string, copy: Copy): Promise<void> {
    const id = copy.path.slice(copy.path.lastIndexOf("/") + 1, -".jsonl".length);
    const had = copy.offset >= 0 && await stat(copy.path).then(() => true, () => false);
    const [end, from] = had ? [copy.offset, copy.from] : [-1, -1];
    const out = await this.exec(machine, ["sh", "-c", READ_NEW, "sh", id, String(end), String(from), String(this.limits.cap), String(had ? this.limits.chunk : this.limits.first)], EXEC_MS);
    const nl = out.indexOf(10);
    const [, start, len, old, olen] = new TextDecoder().decode(out.subarray(0, nl)).split(" ").map(Number);
    if (![start, len, old, olen].every((n) => Number.isSafeInteger(n) && n! >= 0)) return;
    // A read cut short (hc's output limit, a log rotated mid-read) is dropped whole; the next one asks again.
    if (out.length - nl - 1 !== len! + olen!) return;
    const fresh = out.subarray(nl + 1, nl + 1 + len!);
    const older = out.subarray(nl + 1 + len!);
    await mkdir(dirname(copy.path), { recursive: true, mode: 0o700 });
    const kept = had && start === end;
    if (kept && !older.length) {
      if (fresh.length) await appendFile(copy.path, fresh);
    } else {
      // The first read, a log that shrank or ran past a chunk, or older bytes going in front: a new file,
      // so a reader that holds the old one sees another inode and reads again.
      const tmp = `${copy.path}.tmp`;
      await writeFile(tmp, older, { mode: 0o600 });
      if (kept) await appendFile(tmp, await readFile(copy.path));
      await appendFile(tmp, fresh);
      await rename(tmp, copy.path);
      if (!kept) copy.from = start!;
    }
    if (older.length) copy.from = old!;
    copy.offset = start! + fresh.length;
  }
}

/** `hc exec --on <machine>`, as bytes. */
export function hcExecCommand(binary: string): HcExec {
  return async (machine, argv, timeoutMs) => {
    const child = Bun.spawn([binary, "exec", "--on", machine, ...argv], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    try {
      const [out, code] = await Promise.all([new Response(child.stdout).bytes(), child.exited]);
      if (code !== 0) throw new Error(`hc exec on ${machine}: exit ${code}`);
      return out;
    } finally {
      clearTimeout(timer);
    }
  };
}
