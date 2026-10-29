import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentView } from "./types.ts";

// Which agents may push at all, one switch per agent (ADR 0134). The kind switches (notify-prefs.ts)
// and Snooze still decide every alert an agent that is on would send; an agent that is off sends none.
//
// An agent is a pane, keyed `<session>/<paneId>` like the activity ledger: Herdr never reuses a pane
// id. Its first sighting decides how it starts: on when its folder matches one of the operator's
// supervisor patterns (COLLIE_NOTIFY_SUPERVISORS), off otherwise. The agents in a session's first
// herd ever keep pushing, so an upgrade silences nobody.
//
// The file is shared with `scripts/notify.ts`, which the operator runs from a terminal: every read
// checks the file's stamp first, and every change is read, made and written (a temp file and a
// rename) under a short lock, so neither side writes over the other's change.

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
  seeded: string[];
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
  /** Sessions whose first herd was already seeded (decision 3 of ADR 0134). */
  private seeded: string[] = [];
  private stamp = "";

  constructor(
    private readonly file: string,
    private readonly patterns: readonly string[],
    private readonly now: () => number = Date.now,
    private readonly home: string = homedir(),
  ) {}

  static at(stateDir: string, patterns: readonly string[]): AgentNotifyStore {
    return new AgentNotifyStore(join(stateDir, "agent-notify.json"), patterns);
  }

  /** Whether this agent may push. One the bridge has not seen yet may: the herd's next read decides it. */
  on(session: string, paneId: string): boolean {
    return this.switches(session)(paneId);
  }

  /** {@link on} for many agents of one session, reading the file once. */
  switches(session: string): (paneId: string) => boolean {
    this.read();
    const agents = this.agents;
    return (paneId) => agents[key(session, paneId)]?.on ?? true;
  }

  /** Every agent the file knows, present ones first. */
  list(): AgentNotifyRow[] {
    this.read();
    return Object.entries(this.agents)
      .map(([k, entry]) => ({ ...entry, ...split(k) }))
      .sort((a, b) => Number(a.gone !== undefined) - Number(b.gone !== undefined) || a.session.localeCompare(b.session) || a.paneId.localeCompare(b.paneId, undefined, { numeric: true }));
  }

  /** The sessions the file has seen, so a terminal command can refuse one that does not exist. */
  sessions(): string[] {
    this.read();
    return [...this.seeded];
  }

  /** The operator's choice for one agent; one never seen yet is remembered for when it shows up. */
  set(session: string, paneId: string, on: boolean): AgentNotifyRow {
    return this.locked(() => {
      const k = key(session, paneId);
      const entry: AgentNotifyEntry = { ...(this.agents[k] ?? { firstSeen: this.now() }), on, why: "set" };
      this.agents = { ...this.agents, [k]: entry };
      this.write();
      return { ...entry, session, paneId };
    });
  }

  /**
   * Bring the file in line with a session's herd, read from Herdr just now: a new agent gets its
   * switch, one that left is marked gone, one gone long enough is forgotten. A session's first herd
   * ever is seeded on, so the agents already running when this ships keep pushing.
   */
  reconcile(session: string, herd: readonly AgentView[]): void {
    this.read();
    if (this.seeded.includes(session) && !this.differs(session, herd)) return;
    this.locked(() => {
      const now = this.now();
      const seed = !this.seeded.includes(session);
      const next = { ...this.agents };
      const present = new Set<string>();
      for (const agent of herd) {
        const k = key(session, agent.paneId);
        present.add(k);
        const was = next[k];
        const facts = factsOf(agent);
        if (!was) {
          const supervisor = isSupervisor(agent, this.patterns, this.home);
          next[k] = { on: seed || supervisor, why: seed ? "existing" : supervisor ? "supervisor" : "new", ...facts, firstSeen: now };
        } else if (was.gone !== undefined || moved(was, facts)) {
          const { gone: _gone, ...kept } = was;
          next[k] = { ...kept, ...facts };
        }
      }
      for (const [k, entry] of Object.entries(next)) {
        if (split(k).session !== session || present.has(k)) continue;
        if (entry.gone === undefined) next[k] = { ...entry, gone: now };
        else if (now - entry.gone > AGENT_NOTIFY_FORGET_MS) delete next[k];
      }
      this.agents = next;
      if (seed) this.seeded = [...this.seeded, session];
      this.write();
    });
  }

  /** Whether the herd says anything the file does not hold yet, so a quiet poll neither locks nor writes. */
  private differs(session: string, herd: readonly AgentView[]): boolean {
    const present = new Set(herd.map((a) => key(session, a.paneId)));
    for (const agent of herd) {
      const was = this.agents[key(session, agent.paneId)];
      if (!was || was.gone !== undefined || moved(was, factsOf(agent))) return true;
    }
    const now = this.now();
    return Object.entries(this.agents).some(([k, e]) => split(k).session === session && !present.has(k) && (e.gone === undefined || now - e.gone > AGENT_NOTIFY_FORGET_MS));
  }

  /**
   * Read, change and write under a short exclusive lock, so the bridge and the terminal command never
   * write over each other's change. A lock older than {@link LOCK_STALE_MS} is a writer that died.
   */
  private locked<T>(change: () => T): T {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const lock = `${this.file}.lock`;
    // Who holds it, so a writer that took over a stale lock never removes the next holder's.
    const token = `${process.pid}:${Math.random()}`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const fd = openSync(lock, "wx", 0o600);
        writeFileSync(fd, token);
        closeSync(fd);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true });
      } catch {
        /* released meanwhile */
      }
      if (Date.now() > deadline) throw new Error(`${lock} is held by another writer`);
      Atomics.wait(PAUSE, 0, 0, 10);
    }
    try {
      this.read();
      return change();
    } finally {
      try {
        if (readFileSync(lock, "utf8") === token) rmSync(lock, { force: true });
      } catch {
        /* already gone */
      }
    }
  }

  /** Re-read the file when it changed since the last look. */
  private read(): void {
    let stamp: string;
    try {
      stamp = stampOf(statSync(this.file));
    } catch {
      return;
    }
    if (stamp === this.stamp) return;
    try {
      ({ agents: this.agents, seeded: this.seeded } = coerce(JSON.parse(readFileSync(this.file, "utf8"))));
    } catch {
      /* unreadable: keep what we had */
    }
    this.stamp = stamp;
  }

  private write(): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ agents: this.agents, seeded: this.seeded } satisfies AgentNotifyFile, null, 2), { mode: 0o600 });
      // The temp file's stamp is the file's once renamed; a stat after the rename could read another writer's.
      const stamp = stampOf(statSync(tmp));
      renameSync(tmp, this.file);
      this.stamp = stamp;
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  }
}

const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 10_000;
const PAUSE = new Int32Array(new SharedArrayBuffer(4));

function stampOf(st: Stats): string {
  return `${st.mtimeMs}:${st.size}:${st.ino}`;
}

function factsOf(agent: AgentView): Partial<Pick<AgentNotifyEntry, "name" | "workspace" | "cwd" | "agent">> {
  return defined({ name: nameOf(agent), workspace: agent.workspaceLabel, cwd: agent.cwd || undefined, agent: agent.agent });
}

function moved(was: AgentNotifyEntry, facts: ReturnType<typeof factsOf>): boolean {
  return (Object.keys(facts) as Array<keyof typeof facts>).some((f) => facts[f] !== was[f]);
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
  const seen = (raw as { seeded?: unknown } | null)?.seeded;
  const seeded = Array.isArray(seen) ? seen.filter((s): s is string => typeof s === "string" && s !== "") : [];
  const rows = (raw as { agents?: unknown } | null)?.agents;
  if (typeof rows !== "object" || rows === null) return { agents, seeded };
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
  return { agents, seeded };
}
