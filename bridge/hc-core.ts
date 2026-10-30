import { basename } from "node:path";

import type { WireAgent, WireSnapshot } from "./herdr-client.ts";
import type { AgentStatus } from "./types.ts";

// herdr-core (`hc`) seen as a Herdr session, read only. Pure: hc's own records in, the Herdr wire
// shapes the rest of the bridge already reads out (HERDR_API.md). hc-client.ts runs `hc connect`.
//
// What maps: a live terminal is a pane, its address its pane id; Herdr.app's `herdr.space` and
// `herdr.tab` labels place it, named from the `herdr-app` core document; the program's own status
// record (OSC 7501) is the agent and its state.

/** One OSC 7501 record, the program's own words. */
export interface HcStatus {
  state: string;
  app?: string;
  msg?: string;
  title?: string;
  kind?: string | null;
  progress?: number | null;
}

/** The fields of hc's `Terminal` this adapter reads. */
export interface HcTerminal {
  address: string;
  state: string;
  cwd: string;
  pid?: number | null;
  name?: string | null;
  title?: string | null;
  labels?: Record<string, string>;
  status?: HcStatus | null;
  foreground?: { pid: number; name: string; argv: string[]; cwd: string } | null;
  turn?: number | null;
}

/** The part of the `herdr-app` document Herdr.app keeps its spaces and tabs in. */
export interface HcAppDoc {
  spaces?: Array<{ id: string; name?: string; folder?: string; tabs?: Array<{ id: string; name?: string }> }>;
}

const HC_STATUS: Record<string, AgentStatus> = {
  idle: "idle",
  working: "working",
  blocked: "blocked",
  done: "done",
  // A program that stopped on an error waits for a person, as a blocked one does.
  error: "blocked",
};

/** hc's state words onto Herdr's; a word hc adds later reads as unknown. */
export function hcAgentStatus(status: HcStatus | null | undefined): AgentStatus {
  return (status && HC_STATUS[status.state]) ?? "unknown";
}

/** The harness names Nenu's adapters know, from the app a program reports (`claude-code` → claude). */
export function hcAgentName(status: HcStatus | null | undefined): string | null {
  const app = status?.app?.trim();
  if (!app) return null;
  return app === "claude-code" ? "claude" : app;
}

// A machine's terminal is `machine/t7`; a pane id travels in a URL path segment, so the slash becomes
// a colon, which no hc machine name or address uses.
export const hcPaneId = (address: string): string => address.replace("/", ":");
export const hcAddress = (paneId: string): string => paneId.replace(":", "/");

/** Each machine's terminals are one session: `hc` for this one, `hc@<machine>` for another (ADR 0135). */
export const hcSessionName = (machine: string): string => (machine ? `hc@${machine}` : "hc");
export const isHcSession = (session: string): boolean => session === "hc" || session.startsWith("hc@");

/** The machine a terminal runs on, "" for this one. */
export const hcMachine = (address: string): string => (address.includes("/") ? address.split("/")[0]! : "");

/**
 * The herd as `session.snapshot` would report it. `docs` holds each machine's `herdr-app` document
 * ("" for this one); a terminal Herdr.app did not place goes in one space per machine named `hc`.
 * `sessions` maps a terminal address to its agent's own session id when the caller could find one.
 */
export function hcSnapshot(
  terminals: HcTerminal[],
  docs: Map<string, HcAppDoc | null>,
  sessions: Map<string, string> = new Map(),
  version = "",
): WireSnapshot {
  const live = terminals.filter((t) => t.state === "live");
  const spaceOrder: string[] = [];
  const spaceLabel = new Map<string, string>();
  const tabOrder = new Map<string, string[]>();
  const tabLabel = new Map<string, string>();

  // Herdr.app's own order first, so a space reads as it does in the window.
  for (const [machine, doc] of docs) {
    for (const space of doc?.spaces ?? []) {
      const ws = scoped(machine, space.id);
      spaceOrder.push(ws);
      spaceLabel.set(ws, space.name || (space.folder ? basename(space.folder) || space.folder : space.id));
      const tabs = (space.tabs ?? []).map((tab, i) => {
        const id = scoped(machine, tab.id);
        tabLabel.set(id, tab.name || String(i + 1));
        return id;
      });
      tabOrder.set(ws, tabs);
    }
  }

  const panes = live.map((t) => {
    const machine = hcMachine(t.address);
    const where = (t.labels?.where ?? "").split(" / ");
    const space = t.labels?.["herdr.space"];
    const workspace_id = space ? scoped(machine, space) : scoped(machine, "hc");
    const tab = t.labels?.["herdr.tab"];
    const tab_id = tab ? scoped(machine, tab) : `${workspace_id}:tab`;
    if (!spaceLabel.has(workspace_id)) {
      spaceOrder.push(workspace_id);
      spaceLabel.set(workspace_id, (space && where[0]) || (machine ? `hc ${machine}` : "hc"));
    }
    const tabs = tabOrder.get(workspace_id) ?? [];
    if (!tabs.includes(tab_id)) tabs.push(tab_id);
    tabOrder.set(workspace_id, tabs);
    if (!tabLabel.has(tab_id)) tabLabel.set(tab_id, (tab && where[1]) || String(tabs.length));

    const agent = hcAgentName(t.status);
    const session = sessions.get(t.address);
    return {
      pane_id: hcPaneId(t.address),
      terminal_id: t.address,
      workspace_id,
      tab_id,
      focused: false,
      cwd: t.cwd,
      ...(t.foreground?.cwd ? { foreground_cwd: t.foreground.cwd } : {}),
      agent,
      agent_status: agent ? hcAgentStatus(t.status) : ("unknown" as AgentStatus),
      ...(t.name ? { label: t.name } : {}),
      terminal_title: t.status?.title || t.title || null,
      revision: 0,
      ...(agent && session ? { agent_session: { agent, kind: "id", value: session } } : {}),
    };
  });

  const paneCount = (key: "workspace_id" | "tab_id", id: string) => panes.filter((p) => p[key] === id).length;
  const used = spaceOrder.filter((ws, i) => spaceOrder.indexOf(ws) === i && paneCount("workspace_id", ws) > 0);
  const workspaces = used.map((ws, i) => {
    const tabs = (tabOrder.get(ws) ?? []).filter((tab) => paneCount("tab_id", tab) > 0);
    return {
      workspace_id: ws,
      number: i + 1,
      label: spaceLabel.get(ws) ?? ws,
      focused: false,
      pane_count: paneCount("workspace_id", ws),
      tab_count: tabs.length,
      active_tab_id: tabs[0] ?? "",
      agent_status: "unknown" as AgentStatus,
    };
  });
  const tabs = used.flatMap((ws) =>
    (tabOrder.get(ws) ?? [])
      .filter((tab) => paneCount("tab_id", tab) > 0)
      .map((tab, i) => ({
        tab_id: tab,
        workspace_id: ws,
        number: i + 1,
        label: tabLabel.get(tab) ?? String(i + 1),
        focused: false,
        pane_count: paneCount("tab_id", tab),
        agent_status: "unknown" as AgentStatus,
      })),
  );
  const agents = live.flatMap((t) => (hcAgentName(t.status) ? [hcCounters(t)] : []));
  return { version, protocol: 0, workspaces, tabs, panes, agents };
}

/**
 * Herdr's transition counters from hc's turn number, which counts the turns a program started: each
 * turn moves the state twice (into working, out of it), so a turn that started and ended between
 * two polls still moves `state_change_seq`. A dialog inside a turn (working, blocked, working) does
 * not count: hc reports no counter for it.
 */
export function hcCounters(t: HcTerminal): WireAgent {
  const turn = t.turn ?? 0;
  const working = t.status?.state === "working" || t.status?.state === "blocked";
  return {
    pane_id: hcPaneId(t.address),
    state_change_seq: 2 * turn - (working ? 1 : 0),
    completion_seq: working ? Math.max(0, turn - 1) : turn,
    ...(t.name ? { name: t.name } : {}),
  };
}

const scoped = (machine: string, id: string): string => (machine ? `${machine}:${id}` : id);

/**
 * `pane.process_info` from what hc knows: the shell it started, the foreground group's leader, and
 * the group's other pids when the caller could list them (a wrapper's child is the agent itself).
 */
export function hcProcessInfo(t: HcTerminal, group: number[] = []): unknown {
  const fg = t.foreground;
  const others = fg ? group.filter((pid) => pid !== fg.pid).map((pid) => ({ pid })) : [];
  return {
    pane_id: hcPaneId(t.address),
    shell_pid: t.pid ?? null,
    foreground_process_group_id: fg?.pid ?? null,
    foreground_processes: fg
      ? [{ pid: fg.pid, name: fg.name, argv0: fg.argv[0] ?? fg.name, argv: fg.argv, cmdline: fg.argv.join(" "), cwd: fg.cwd }, ...others]
      : [],
  };
}

// Herdr's key names (HERDR_API.md: `Enter`, `Escape`, `shift+tab`, `ctrl+c`) onto hc's (`enter`,
// `esc`, `shift+tab`, `ctrl+c`). A modifier chord keeps its `+` grammar; only the case differs.
const HC_KEY: Record<string, string> = { escape: "esc", return: "enter" };

export function hcKey(key: string): string {
  const lower = key.toLowerCase();
  return HC_KEY[lower] ?? lower;
}

/** Whether a key submits what was typed. */
export const isSubmitKey = (key: string): boolean => hcKey(key) === "enter";

/** hc pastes on its own (`terminal.send`): Nenu's bracketed-paste markers come off. */
export const unbracket = (text: string): string => text.replaceAll("\x1b[200~", "").replaceAll("\x1b[201~", "");

// ── Where a new terminal goes ──────────────────────────────────────────────────────────────────

/** A workspace id back into its machine and Herdr.app space id (`hc` is the space of unplaced ones). */
export function hcSpace(workspaceId: string): { machine: string; space: string } {
  const at = workspaceId.indexOf(":");
  return at < 0 ? { machine: "", space: workspaceId } : { machine: workspaceId.slice(0, at), space: workspaceId.slice(at + 1) };
}

/** A fresh Herdr.app-shaped id: `sp` or `tb` and 32 hex digits. */
export const hcNewId = (prefix: "sp" | "tb"): string => prefix + crypto.randomUUID().replaceAll("-", "");

/**
 * The labels that place a terminal the way Herdr.app places its own: its space, its tab and the
 * `where` it shows ("space / tab"), which names both until Herdr.app's document does. The space of
 * unplaced terminals gets no labels, so a terminal started there stays there.
 */
export function hcPlacement(space: string, tab: string, where: string): Record<string, string> {
  return space === "hc" ? {} : { "herdr.space": space, "herdr.tab": tab, where };
}

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "nu"]);

/** Whether a terminal's foreground is a shell at rest (a login shell's argv0 starts with `-`). */
export function hcAtShell(t: HcTerminal): boolean {
  const fg = t.foreground;
  if (!fg || t.status) return false;
  const name = (fg.argv[0] ?? fg.name).replace(/^-/, "").split("/").pop() ?? "";
  return SHELLS.has(name) || SHELLS.has(fg.name);
}

/** One POSIX shell line for an argv: words outside `[A-Za-z0-9_./=:@%+-]` go single-quoted. */
export function hcShellLine(argv: string[]): string {
  return argv.map((a) => (/^[A-Za-z0-9_./=:@%+-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`)).join(" ");
}

// ── An agent's own conversation id ──────────────────────────────────────────────────────────────

/** What reads a Claude Code session file on the terminal's machine: its text, or null. */
export type SessionFileReader = (pid: number) => Promise<string | null>;

/**
 * Claude Code's conversation id for a terminal, which hc does not report: the `--session-id` its
 * command line names (Nenu starts every Claude with one), else the `sessions/<pid>.json` Claude keeps
 * for a process of the foreground group. The group's leader can be a wrapper that runs Claude as its
 * child, so `pids` may name the rest of the group too.
 */
export async function hcClaudeSession(t: HcTerminal, read: SessionFileReader, pids: number[] = []): Promise<string | null> {
  if (t.status?.app !== "claude-code" || !t.foreground) return null;
  const argv = t.foreground.argv;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--session-id" && argv[i + 1]) return argv[i + 1]!;
    if (flag.startsWith("--session-id=")) return flag.slice("--session-id=".length) || null;
  }
  for (const pid of [t.foreground.pid, ...pids.filter((p) => p !== t.foreground!.pid)]) {
    const text = await read(pid).catch(() => null);
    if (text === null) continue;
    try {
      const { sessionId } = JSON.parse(text) as { sessionId?: unknown };
      if (typeof sessionId === "string" && sessionId) return sessionId;
    } catch {
      /* not a session file */
    }
  }
  return null;
}
