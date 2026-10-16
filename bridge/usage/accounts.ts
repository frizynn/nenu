import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

// Which account each message was billed to. Codex rollouts say so themselves (`creator_account_id`);
// Claude Code transcripts never do, so Claude usage is attributed from a time line of "account X
// became active" lines, one per config directory and optionally per session. The lines share one
// format with the account tool hats (its `switches.jsonl`) so Nenu reads that log the same way it
// reads its own, and works without it:
//
//   {"v":1,"at":"<UTC ISO>","harness":"claude"|"codex","account":"<16 hex>","label":"…","configDir":"…","session":"…"}
//
// `account` is the first 16 hex of sha256("<accountUuid>:<organizationUuid>") for Claude (both from
// `oauthAccount` in the config dir's `.claude.json`; one id per organization because plan limits are
// per organization) and of sha256(creator_account_id) for Codex. Never an email, never a token.

export type Harness = "claude" | "codex";

export interface SwitchLine {
  at: number;
  harness: Harness;
  /** Prefixed with its namespace: `claude:<hex>`, `claude:swap-2`, `codex:<hex>`. */
  account: string;
  label?: string;
  configDir: string;
  session?: string;
}

export const UNASSIGNED = { claude: "claude:unassigned", codex: "codex:unassigned" } as const;

export const accountHash = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 16);

/** hats' state dir, by its documented override order. */
export function hatsStateDir(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  return env.HATS_STATE_DIR || join(env.XDG_STATE_HOME || join(home, ".local", "state"), "hats");
}

/** Lines of a v1 switch log. A line that does not parse or misses a field is skipped, never fatal. */
export function parseSwitchLog(text: string): SwitchLine[] {
  const out: SwitchLine[] = [];
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    let row: unknown;
    try { row = JSON.parse(raw); } catch { continue; }
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    const at = typeof r.at === "string" ? Date.parse(r.at) : NaN;
    if (r.v !== 1 || !Number.isFinite(at) || (r.harness !== "claude" && r.harness !== "codex")) continue;
    if (typeof r.account !== "string" || !/^[0-9a-f]{16}$/.test(r.account) || typeof r.configDir !== "string") continue;
    out.push({
      at,
      harness: r.harness,
      account: `${r.harness}:${r.account}`,
      ...(typeof r.label === "string" && r.label.length <= 64 ? { label: r.label } : {}),
      configDir: r.configDir,
      ...(typeof r.session === "string" && r.session.length <= 128 ? { session: r.session } : {}),
    });
  }
  return out;
}

/**
 * claude-swap's log as switch lines for the default config dir. Only two line kinds matter: "Added
 * account N" (it adds whoever is signed in, so N is active then) and "Switched from account N to M".
 * Its slots are claude-swap's own numbering; nothing else of the tool is read here.
 */
export function parseClaudeSwapLog(text: string, configDir: string): SwitchLine[] {
  const out: SwitchLine[] = [];
  const re = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)(?:,(\d{1,3}))? - INFO - (?:Added account (\d+)|Switched from account \d+ to (\d+))/gm;
  for (const m of text.matchAll(re)) {
    // claude-swap logs local wall-clock time.
    const at = new Date(`${m[1]!.replace(" ", "T")}.${(m[2] ?? "0").padStart(3, "0")}`).getTime();
    const slot = m[3] ?? m[4]!;
    if (Number.isFinite(at)) out.push({ at, harness: "claude", account: `claude:swap-${slot}`, label: `Account ${slot}`, configDir });
  }
  return out;
}

/** The signed-in Claude account of a `.claude.json`, read by byte search without parsing the file. */
export function claudeIdentity(file: Uint8Array): string | undefined {
  const text = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  const at = text.indexOf('"oauthAccount"');
  if (at < 0) return undefined;
  const end = text.indexOf("}", at);
  const value = (key: string) => {
    const k = text.indexOf(`"${key}"`, at);
    if (k < 0 || k > end) return undefined;
    const m = /^"[^"]+"\s*:\s*"([0-9a-fA-F-]{8,64})"/.exec(text.toString("latin1", k, k + 120));
    return m?.[1];
  };
  const account = value("accountUuid");
  const org = value("organizationUuid");
  return account && org ? accountHash(`${account}:${org}`) : undefined;
}

interface Timeline { at: number[]; account: string[] }
const timeline = (lines: SwitchLine[]): Timeline => {
  const sorted = [...lines].sort((a, b) => a.at - b.at);
  return { at: sorted.map((l) => l.at), account: sorted.map((l) => l.account) };
};
/** The account of the last line at or before `t`, if any. */
function lookup(t: Timeline | undefined, at: number): string | undefined {
  if (!t) return undefined;
  let lo = 0, hi = t.at.length - 1, found: string | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t.at[mid]! <= at) { found = t.account[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/**
 * Message → account. A message of session S at time t belongs to the last line naming S at or before
 * t; else to the last line of its config dir without a session; else, when the dir only ever showed
 * one account, to that one; else it is unassigned. claude-swap's slots stand for the default dir
 * when its log exists: Nenu's own sessionless sightings there would name the same people twice.
 */
export class AccountBook {
  private readonly sessions = new Map<string, Timeline>();
  private readonly dirs = new Map<string, Timeline>();
  private readonly only = new Map<string, string>();
  readonly labels = new Map<string, string>();

  constructor(lines: readonly SwitchLine[], swapDirs: ReadonlySet<string> = new Set()) {
    const bySession = new Map<string, SwitchLine[]>();
    const byDir = new Map<string, SwitchLine[]>();
    const seen = new Map<string, Set<string>>();
    for (const line of lines) {
      if (line.label && !this.labels.has(line.account)) this.labels.set(line.account, line.label);
      if (line.harness !== "claude") continue;
      (seen.get(line.configDir) ?? seen.set(line.configDir, new Set()).get(line.configDir)!).add(line.account);
      if (line.session) (bySession.get(line.session) ?? bySession.set(line.session, []).get(line.session)!).push(line);
      else if (!swapDirs.has(line.configDir) || line.account.startsWith("claude:swap-")) {
        (byDir.get(line.configDir) ?? byDir.set(line.configDir, []).get(line.configDir)!).push(line);
      }
    }
    for (const [k, v] of bySession) this.sessions.set(k, timeline(v));
    for (const [k, v] of byDir) this.dirs.set(k, timeline(v));
    for (const [dir, accounts] of seen) if (accounts.size === 1 && !swapDirs.has(dir)) this.only.set(dir, [...accounts][0]!);
  }

  /** Who a config dir had signed in, oldest first, merging repeats. */
  history(configDir: string): Array<{ account: string; since: number; until?: number }> {
    const t = this.dirs.get(configDir);
    if (!t) {
      const only = this.only.get(configDir);
      return only ? [{ account: only, since: 0 }] : [];
    }
    const out: Array<{ account: string; since: number; until?: number }> = [];
    for (let i = 0; i < t.at.length; i++) {
      const last = out[out.length - 1];
      if (last?.account === t.account[i]) continue;
      if (last) last.until = t.at[i];
      out.push({ account: t.account[i]!, since: t.at[i]! });
    }
    return out;
  }

  claude(configDir: string, session: string | undefined, at: number): string {
    return (session !== undefined ? lookup(this.sessions.get(session), at) : undefined)
      ?? lookup(this.dirs.get(configDir), at)
      ?? this.only.get(configDir)
      ?? UNASSIGNED.claude;
  }
}

export const codexAccount = (creatorAccountId: string | undefined): string =>
  creatorAccountId ? `codex:${accountHash(creatorAccountId)}` : UNASSIGNED.codex;

/** One v1 line, as hats writes it, for Nenu's own log. */
export function formatSwitchLine(line: { at: number; harness: Harness; account: string; configDir: string; session?: string }): string {
  return JSON.stringify({
    v: 1, at: new Date(line.at).toISOString(), harness: line.harness, account: line.account.slice(line.harness.length + 1),
    configDir: line.configDir, ...(line.session ? { session: line.session } : {}),
  });
}
