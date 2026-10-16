import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AccountBook, claudeIdentity, formatSwitchLine, hatsStateDir, parseClaudeSwapLog, parseSwitchLog,
  type Harness, type SwitchLine,
} from "./accounts.ts";
import { claudeStatuslineLimits, claudeSwapLimits, codexLimits, hatsLimits, newestPerAccount, type AccountLimits } from "./limits.ts";
import { repoOf } from "./repos.ts";
import { loadStore, saveStore, scan, usageDir } from "./scan.ts";

// The scan process. The bridge starts it at background priority (runtime.ts); it reads the logs,
// saves totals and offsets under <stateDir>/usage and exits, so the bridge never holds the scan's
// memory. stdout carries one JSON object per line: {progress} while reading, then {done}. A scan whose
// bridge died (kill -9, a crash, a host with no supervisor) stops at the next log and saves nothing, so
// it never runs beside the next bridge's scan.
//
//   bun bridge/usage/scan-main.ts <stateDir> '{"claude":[configDir…],"codex":[codexHome…],"split":bool}'

export interface ScanArgs { claude: string[]; codex: string[]; split: boolean }

export interface AccountView {
  id: string;
  agent: Harness;
  label: string;
  source: "observed" | "hats" | "claude-swap" | "codex" | "none";
  active: boolean;
  activeSince?: number;
  activeUntil?: number;
}

export interface AccountsFile { v: 1; at: number; accounts: AccountView[]; limits: AccountLimits[] }

const read = (path: string): string | undefined => { try { return readFileSync(path, "utf8"); } catch { return undefined; } };

/** True once the bridge that started this scan is gone: the process now belongs to init or launchd. */
const bridge = process.ppid;
const orphaned = () => process.ppid !== bridge;

/** Where a config dir keeps its `.claude.json`: the default dir's sits beside it in the home folder. */
export const identityFile = (configDir: string, home = homedir()) =>
  configDir === join(home, ".claude") ? join(home, ".claude.json") : join(configDir, ".claude.json");

export function runScan(stateDir: string, args: ScanArgs, now = Date.now(), home = homedir(), env = process.env) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const d = new Date(now);
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const dir = usageDir(stateDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // ── Who was signed in when ──
  const ownLog = join(dir, "accounts.jsonl");
  const own = parseSwitchLog(read(ownLog) ?? "");
  const hats = parseSwitchLog(read(join(hatsStateDir(env, home), "switches.jsonl")) ?? "");
  const claudeDirs = new Set(args.claude);
  const codexHomes = new Set(args.codex);
  for (const line of hats) (line.harness === "claude" ? claudeDirs : codexHomes).add(line.configDir);
  const lines: SwitchLine[] = [...own, ...hats];
  const swapDirs = new Set<string>();
  const defaultClaude = join(home, ".claude");
  const swapLog = read(join(home, ".claude-swap-backup", "claude-swap.log"));
  if (swapLog !== undefined) {
    lines.push(...parseClaudeSwapLog(swapLog, defaultClaude));
    swapDirs.add(defaultClaude);
  }
  // A sighting of each dir's signed-in account, appended when it changed since the last one.
  for (const configDir of claudeDirs) {
    let bytes: Uint8Array;
    try { bytes = readFileSync(identityFile(configDir, home)); } catch { continue; }
    const id = claudeIdentity(bytes);
    if (!id) continue;
    const last = [...own].reverse().find((l) => l.configDir === configDir && !l.session);
    if (last?.account === `claude:${id}`) continue;
    const line = { at: now, harness: "claude" as const, account: `claude:${id}`, configDir };
    appendFileSync(ownLog, `${formatSwitchLine(line)}\n`, { mode: 0o600 });
    lines.push(line);
  }
  const book = new AccountBook(lines, swapDirs);

  // ── The scan ──
  const store = loadStore(stateDir, today, tz);
  const result = scan({
    roots: { claude: [...claudeDirs].map((configDir) => ({ configDir })), codex: [...codexHomes] },
    state: store.state, totals: store.totals, seen: store.seen, book,
    repoOf: (cwd) => repoOf(cwd, home),
    onProgress: (p) => process.stdout.write(`${JSON.stringify({ progress: p })}\n`),
    stop: orphaned,
  });
  if (result.stopped) return result;

  // ── Accounts and their limits ──
  const limits: AccountLimits[] = [...codexLimits(store.totals.codexLimits)];
  for (const configDir of claudeDirs) limits.push(...claudeStatuslineLimits(stateDir, book, configDir, now));
  if (args.split) {
    const fromHats = read(join(hatsStateDir(env, home), "limits.json"));
    if (fromHats) limits.push(...hatsLimits(fromHats));
    const fromSwap = read(join(home, ".claude-swap-backup", "cache", "usage.json"));
    if (fromSwap) limits.push(...claudeSwapLimits(fromSwap));
  }
  const newest = newestPerAccount(limits);
  const accounts = new Map<string, AccountView>();
  const note = (id: string, agent: Harness) => {
    if (accounts.has(id)) return accounts.get(id)!;
    const source: AccountView["source"] = id.endsWith(":unassigned") ? "none" : id.startsWith("claude:swap-") ? "claude-swap"
      : hats.some((l) => l.account === id) ? "hats" : agent === "codex" ? "codex" : "observed";
    const view: AccountView = { id, agent, label: book.labels.get(id) ?? "", source, active: false };
    accounts.set(id, view);
    return view;
  };
  for (const day of Object.values(store.totals.days)) for (const key of Object.keys(day)) {
    const [agent, account] = key.split("|") as [Harness, string];
    note(account, agent);
  }
  for (const l of newest) note(l.account, l.agent);
  for (const configDir of claudeDirs) {
    const history = book.history(configDir);
    for (const [i, h] of history.entries()) {
      const view = note(h.account, "claude");
      if (i === history.length - 1) { view.active = true; view.activeSince = h.since || undefined; }
      else if (!view.activeUntil || view.activeUntil < h.until!) view.activeUntil = h.until;
    }
  }
  const codexNewest = newest.filter((l) => l.agent === "codex").sort((a, b) => b.observedAt - a.observedAt)[0];
  if (codexNewest) note(codexNewest.account, "codex").active = true;
  // Names nobody gave: "Claude 1…", "ChatGPT", "ChatGPT 2…", "Unassigned".
  const counters = { claude: 0, codex: 0 };
  for (const view of accounts.values()) {
    if (view.label) continue;
    if (view.source === "none") { view.label = "Unassigned"; continue; }
    const n = ++counters[view.agent];
    view.label = view.agent === "claude" ? `Claude ${n}` : n === 1 ? "ChatGPT" : `ChatGPT ${n}`;
  }

  saveStore(stateDir, store, now);
  const file: AccountsFile = { v: 1, at: now, accounts: [...accounts.values()], limits: newest };
  const path = join(dir, "accounts.json");
  writeFileSync(`${path}.tmp`, JSON.stringify(file), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  return result;
}

if (import.meta.main) {
  const [stateDir, raw] = process.argv.slice(2);
  if (!stateDir || !existsSync(stateDir)) process.exit(2);
  let args: ScanArgs = { claude: [join(homedir(), ".claude")], codex: [join(homedir(), ".codex")], split: false };
  try { args = { ...args, ...(JSON.parse(raw ?? "{}") as Partial<ScanArgs>) }; } catch { /* defaults */ }
  const cpu = process.cpuUsage();
  const result = runScan(stateDir, args);
  const used = process.cpuUsage(cpu);
  if (!result.stopped) process.stdout.write(`${JSON.stringify({ done: { ...result, cpuMs: Math.round((used.user + used.system) / 1000), rssMb: Math.round(process.memoryUsage.rss() / 2 ** 20) } })}\n`);
}
