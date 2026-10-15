import { navSearch, type SearchGroup } from "@/lib/nav-search";
import type { MachineView } from "@/lib/types";

// Herdr's saved machines as the snapshot lists them (bridge/machines.ts). A machine is a session to
// the browser: `?s=@<label>` reaches its Nenu, so a pane there opens, reads and writes like one here.
// With one machine the snapshot has no `machines` and none of this shows.

type WithMachines = { machines?: readonly MachineView[]; session?: string };

/** A machine's session starts with `@`, which no Herdr session name can. */
export const isMachineSession = (session: string | undefined): boolean => session?.startsWith("@") ?? false;

/** The machine this snapshot is about, when there is more than one. */
export function currentMachine(data: WithMachines | undefined): MachineView | undefined {
  return data?.machines?.find((machine) => machine.session === data.session);
}

/** Every machine but the one on screen, in Herdr's order (this bridge's own first). */
export function otherMachines(data: WithMachines | undefined): MachineView[] {
  return data?.machines?.filter((machine) => machine.session !== data.session) ?? [];
}

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
