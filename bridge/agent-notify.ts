import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentView } from "./types.ts";

// Which agents may push at all, one switch per agent (ADR 0134). The kind switches (notify-prefs.ts)
// and Snooze still decide every alert an agent that is on would send; an agent that is off sends none.
//
// An agent is a pane, keyed `<session>/<paneId>` like the activity ledger: Herdr never reuses a pane
// id. Its first sighting decides how it starts: on when its folder matches one of the operator's
// supervisor patterns (COLLIE_NOTIFY_SUPERVISORS), off otherwise. Agents already present when this
// file did not exist yet keep pushing, so an upgrade silences nobody.
//
// The file is shared with `scripts/notify.ts`, which the operator runs from a terminal: every read
// checks the file's stamp first and every write goes through a fresh temp file and a rename, so
// either side picks up the other's change on its next look.

/** How an agent got its switch: there before the feature, the supervisor rule, or the operator. */
export type AgentNotifyWhy = "existing" | "supervisor" | "new" | "set";

export interface AgentNotifyEntry {
  on: boolean;
  why: AgentNotifyWhy;
  /** What tells it apart when listed: its pane label, Herdr agent name or Claude session name. */
  name?: string;
  workspace?: string;
  cwd?: string;
  agent?: string;
  firstSeen: number;
  /** When it left the herd; kept for a while so a Herdr restart that restores it keeps its switch. */
  gone?: number;
}

export interface AgentNotifyRow extends AgentNotifyEntry {
  session: string;
  paneId: string;
}

interface AgentNotifyFile {
  agents: Record<string, AgentNotifyEntry>;
}

/** An agent that left the herd this long ago is forgotten. */
export const AGENT_NOTIFY_FORGET_MS = 7 * 24 * 60 * 60 * 1000;

/** The rule's default: Firstmate homes and the Firstmate checkout, as this host launches them. */
export const DEFAULT_SUPERVISOR_PATTERNS = ["~/.firstmate/*", "~/Developer/firstmate"];

/**
 * Whether `cwd` is the folder `pattern` names, the whole path: `~/` is the home folder, `*` one
 * folder name, `**` any number of them. `~/.firstmate/*` matches a home, never a project inside it.
 */
export function matchesFolder(cwd: string, pattern: string, home = homedir()): boolean {
  const expanded = pattern === "~" ? home : pattern.startsWith("~/") ? join(home, pattern.slice(2)) : pattern;
  const want = expanded.replace(/\/+$/, "").split("/");
  const have = cwd.replace(/\/+$/, "").split("/");
  const match = (w: number, h: number): boolean => {
    if (w === want.length) return h === have.length;
    if (want[w] === "**") return match(w + 1, h) || (h < have.length && match(w, h + 1));
    if (h === have.length) return false;
    return segment(want[w]!, have[h]!) && match(w + 1, h + 1);
  };
  return match(0, 0);
}

function segment(pattern: string, name: string): boolean {
  if (!pattern.includes("*")) return pattern === name;
  const re = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
  return re.test(name);
}

/** Whether this agent works in a supervisor's folder, so a new one starts with notifications on. */
export function isSupervisor(agent: Pick<AgentView, "cwd">, patterns: readonly string[], home = homedir()): boolean {
  return !!agent.cwd && patterns.some((p) => matchesFolder(agent.cwd, p, home));
}

function nameOf(agent: AgentView): string | undefined {
  return agent.paneLabel ?? agent.agentName ?? agent.sessionName;
}

export class AgentNotifyStore {
  private agents: Record<string, AgentNotifyEntry> = {};
  private stamp = "";
  /** The file did not exist when this process started: each session's first herd is seeded on. */
  private readonly seeding: boolean;
  private readonly seeded = new Set<string>();

  constructor(
    private readonly file: string,
    private readonly patterns: readonly string[],
    private readonly now: () => number = Date.now,
    private readonly home: string = homedir(),
  ) {
    this.seeding = this.read() === "missing";
  }

  static at(stateDir: string, patterns: readonly string[]): AgentNotifyStore {
    return new AgentNotifyStore(join(stateDir, "agent-notify.json"), patterns);
  }

  /** Whether this agent may push. One the bridge has not seen yet may: the herd's next read decides it. */
  on(session: string, paneId: string): boolean {
    this.read();
    return this.agents[key(session, paneId)]?.on ?? true;
  }

  /** Every agent the file knows, present ones first. */
  list(): AgentNotifyRow[] {
    this.read();
    return Object.entries(this.agents)
      .map(([k, entry]) => ({ ...entry, ...split(k) }))
      .sort((a, b) => Number(a.gone !== undefined) - Number(b.gone !== undefined) || a.session.localeCompare(b.session) || a.paneId.localeCompare(b.paneId, undefined, { numeric: true }));
  }

  /** The operator's choice for one agent; one never seen yet is remembered for when it shows up. */
  set(session: string, paneId: string, on: boolean): AgentNotifyRow {
    this.read();
    const k = key(session, paneId);
    const entry: AgentNotifyEntry = { ...(this.agents[k] ?? { firstSeen: this.now() }), on, why: "set" };
    this.agents = { ...this.agents, [k]: entry };
    this.write();
    return { ...entry, session, paneId };
  }

  /**
   * Bring the file in line with a session's herd, read from Herdr just now: a new agent gets its
   * switch, one that left is marked gone, one gone long enough is forgotten.
   */
  reconcile(session: string, herd: readonly AgentView[]): void {
    this.read();
    const now = this.now();
    const seed = this.seeding && !this.seeded.has(session);
    this.seeded.add(session);
    const next = { ...this.agents };
    let changed = false;
    const present = new Set<string>();
    for (const agent of herd) {
      const k = key(session, agent.paneId);
      present.add(k);
      const was = next[k];
      const facts = { name: nameOf(agent), workspace: agent.workspaceLabel, cwd: agent.cwd || undefined, agent: agent.agent };
      if (!was) {
        const supervisor = isSupervisor(agent, this.patterns, this.home);
        next[k] = { on: seed || supervisor, why: seed ? "existing" : supervisor ? "supervisor" : "new", ...defined(facts), firstSeen: now };
        changed = true;
        continue;
      }
      if (was.gone !== undefined || (Object.keys(facts) as Array<keyof typeof facts>).some((f) => facts[f] !== undefined && facts[f] !== was[f])) {
        const { gone: _gone, ...kept } = was;
        next[k] = { ...kept, ...defined(facts) };
        changed = true;
      }
    }
    for (const [k, entry] of Object.entries(next)) {
      if (split(k).session !== session || present.has(k)) continue;
      if (entry.gone === undefined) {
        next[k] = { ...entry, gone: now };
        changed = true;
      } else if (now - entry.gone > AGENT_NOTIFY_FORGET_MS) {
        delete next[k];
        changed = true;
      }
    }
    if (!changed) return;
    this.agents = next;
    this.write();
  }

  /** Re-read the file when it changed since the last look; "missing" when there is none. */
  private read(): "missing" | "read" | "same" {
    let stamp: string;
    try {
      const st = statSync(this.file);
      stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch {
      return "missing";
    }
    if (stamp === this.stamp) return "same";
    try {
      this.agents = coerce(JSON.parse(readFileSync(this.file, "utf8"))).agents;
    } catch {
      /* unreadable: keep what we had */
    }
    this.stamp = stamp;
    return "read";
  }

  private write(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ agents: this.agents } satisfies AgentNotifyFile, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    const st = statSync(this.file);
    this.stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
  }
}

function key(session: string, paneId: string): string {
  return `${session}/${paneId}`;
}

function split(k: string): { session: string; paneId: string } {
  const at = k.indexOf("/");
  return { session: k.slice(0, at), paneId: k.slice(at + 1) };
}

function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

const WHYS: readonly AgentNotifyWhy[] = ["existing", "supervisor", "new", "set"];

/** Whatever the file holds, as entries that have at least a switch and a reason; anything else is dropped. */
export function coerce(raw: unknown): AgentNotifyFile {
  const agents: Record<string, AgentNotifyEntry> = {};
  const rows = (raw as { agents?: unknown } | null)?.agents;
  if (typeof rows !== "object" || rows === null) return { agents };
  for (const [k, v] of Object.entries(rows as Record<string, unknown>)) {
    const e = v as Partial<AgentNotifyEntry> | null;
    if (!k.includes("/") || typeof e !== "object" || e === null || typeof e.on !== "boolean" || !WHYS.includes(e.why as AgentNotifyWhy)) continue;
    const text = (s: unknown) => (typeof s === "string" && s ? s : undefined);
    agents[k] = {
      on: e.on,
      why: e.why as AgentNotifyWhy,
      ...defined({ name: text(e.name), workspace: text(e.workspace), cwd: text(e.cwd), agent: text(e.agent) }),
      firstSeen: typeof e.firstSeen === "number" ? e.firstSeen : 0,
      ...(typeof e.gone === "number" ? { gone: e.gone } : {}),
    };
  }
  return { agents };
}
