import { deviceStore } from "@/lib/device-store";
import { navSearch, type SearchGroup } from "@/lib/nav-search";
import type { AgentView, MachineState, MachineView, TabView, WorkspaceView } from "@/lib/types";

// Herdr's saved machines as the snapshot lists them (bridge/machines.ts). A machine is a session to
// the browser: `?s=@<label>` reaches its Nenu, so a pane there opens, reads and writes like one here.
// With one machine the snapshot has no `machines` and none of this shows.

type WithMachines = { machines?: readonly MachineView[]; session?: string };

/** A machine's session starts with `@`, which no Herdr session name can. */
export const isMachineSession = (session: string | undefined): boolean => session?.startsWith("@") ?? false;

/** The machine this snapshot is about, when there is more than one. */
export function currentMachine(data: WithMachines | undefined): MachineView | undefined {
  return data?.machines?.find((machine) => machine.sessions ? machine.sessions.includes(data.session ?? "") : machine.session === data.session);
}

/**
 * The machines the lists show apart, under their own names: Herdr's other machines (ADR 0084), and a
 * joined machine only while it cannot be reached, to say why. A joined machine's chats are the lists' own.
 */
export function otherMachines(data: WithMachines | undefined): MachineView[] {
  return data?.machines?.filter((machine) => machine.sessions ? machine.state !== "connected" : machine.session !== data.session) ?? [];
}

// ── Joined machines (ADR 0136) ───────────────────────────────────────
// With herdr-core on, the bridge lists machines, each joining its sessions: this one Herdr's and hc's,
// another its hc session. The lists show every machine at once, or the one this device picked.

/** The machines whose chats the lists show as their own; none without herdr-core. */
export const joinedMachines = (data: WithMachines | undefined): MachineView[] => data?.machines?.filter((machine) => machine.sessions) ?? [];

/** The machine this device's lists show, by label; "" shows every machine. */
export const useMachineFilter = deviceStore<string>("nenu:machine:v1", (raw) => {
  try {
    const value = JSON.parse(raw ?? "\"\"") as unknown;
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}, (value) => value === "", "");

interface Herd {
  agents: AgentView[];
  shellPanes: AgentView[];
  workspaces: WorkspaceView[];
  tabs: TabView[];
}

/**
 * The herd the lists show: the joined machines `filter` keeps (every one when it names none still
 * listed), each row with its session and, once more than one machine shows, the name of any machine but
 * this one (the first). Without joined machines, the snapshot's own herd.
 */
export function shownHerd<T extends Herd & WithMachines>(data: T, filter: string): T {
  const joined = joinedMachines(data).filter((machine) => machine.herd);
  if (joined.length === 0) return data;
  const kept = joined.filter((machine) => machine.label === filter);
  const shown = kept.length ? kept : joined;
  const named = (machine: MachineView) => shown.length > 1 && machine !== joined[0];
  const rows = <R extends { session?: string; machine?: string }>(machine: MachineView, list: readonly R[]): R[] =>
    list.map((row) => ({ ...row, session: row.session ?? "", ...(named(machine) ? { machine: machine.label } : {}) }));
  return {
    ...data,
    agents: shown.flatMap((m) => rows(m, m.herd!.agents)),
    shellPanes: shown.flatMap((m) => rows(m, m.herd!.shellPanes)),
    workspaces: shown.flatMap((m) => rows(m, m.herd!.workspaces)),
    tabs: shown.flatMap((m) => m.herd!.tabs.map((tab) => ({ ...tab, session: tab.session ?? "" }))),
  };
}

/** Where a row opens: its own session on a joined list, else the page's. */
export const rowSession = (row: { session?: string }, session: string | undefined): string | undefined => row.session ?? session;

/** A search group found on another machine: its rows open there. */
export interface MachineSearchGroup extends SearchGroup {
  machine: MachineView;
}

/** Search the other machines' chats and workspaces too; a hit's key names its machine so keys never collide. */
export function machineSearch(data: WithMachines, query: string, opts: { order?: Map<string, number> } = {}): MachineSearchGroup[] {
  return otherMachines(data).flatMap((machine) => {
    if (!machine.herd) return [];
    return navSearch(machine.herd, query, opts).map((group) => ({
      ...group,
      hits: group.hits.map((hit) => ({ ...hit, key: `${machine.session ?? ""}|${hit.key}` })),
      machine,
    }));
  });
}

/** A machine's state in words, where the lists and Settings show it. */
export const MACHINE_STATE_WORD: Record<MachineState, string> = {
  connected: "Connected",
  connecting: "Connecting…",
  offline: "Not connected",
  "old-nenu": "Update Nenu there",
  "no-nenu": "No Nenu there",
  disabled: "Disabled in Herdr",
  off: "Off",
};
