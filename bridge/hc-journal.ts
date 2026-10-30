import { createHash } from "node:crypto";
import { appendFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
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
const FOLLOW_MS = 2_000;
/** A chat left alone stops being followed after this long, and its copy goes after the longer one. */
const QUIET_MS = 60_000;
const FORGET_MS = 5 * 60_000;
/** The first read of a chat waits this long; past it the copy keeps coming and the next read has it. */
const FIRST_READ_MS = 8_000;
const EXEC_MS = 60_000;

// `<size> <start>` and then the bytes from `start`. The id is a checked uuid and travels as an argument.
const READ_NEW = `id=$1; off=$2; cap=$3
for f in "$HOME"/.claude*/projects/*/"$id".jsonl; do
  [ -f "$f" ] || continue
  s=$(wc -c <"$f"); s=$((s+0)); start=$off
  [ "$start" -gt "$s" ] && start=0
  [ $((s-start)) -gt "$cap" ] && start=$((s-cap))
  echo "$s $start"
  [ "$start" -lt "$s" ] && tail -c +$((start+1)) "$f"
  exit 0
done
exit 3`;

interface Copy {
  path: string;
  /** How far into the machine's log the copy reaches; -1 until its first read. */
  offset: number;
  readAt: number;
  running: Promise<void> | null;
  timer?: ReturnType<typeof setTimeout>;
}

export class HcJournalMirror {
  private readonly copies = new Map<string, Copy>();
  constructor(private readonly dir: string, private readonly exec: HcExec, private readonly now: () => number = Date.now) {}

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
      copy = { path: join(this.dir, "projects", folder, `${sessionId}.jsonl`), offset: -1, readAt: 0, running: null };
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
    const offset = Math.max(copy.offset, 0);
    const out = await this.exec(machine, ["sh", "-c", READ_NEW, "sh", id, String(offset), String(MAX_TRANSCRIPT_BYTES)], EXEC_MS);
    const nl = out.indexOf(10);
    const [size, start] = new TextDecoder().decode(out.subarray(0, nl)).split(" ").map(Number);
    if (!Number.isSafeInteger(size) || !Number.isSafeInteger(start)) return;
    const bytes = out.subarray(nl + 1);
    await mkdir(dirname(copy.path), { recursive: true, mode: 0o700 });
    if (copy.offset >= 0 && start === copy.offset && await stat(copy.path).then(() => true, () => false)) {
      if (bytes.length) await appendFile(copy.path, bytes);
    } else {
      // The first read, or a log that shrank or ran past the cap: the copy starts over, whole.
      const tmp = `${copy.path}.tmp`;
      await writeFile(tmp, bytes, { mode: 0o600 });
      await rename(tmp, copy.path);
    }
    copy.offset = start! + bytes.length;
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
