import { useEffect, useState } from "react";

import { fetchStartModels, type StartModels } from "@/lib/api";
import { DEFAULT_MODEL } from "@/lib/spawn";

/** Until the bridge answers, each agent offers its own default, which needs no list. */
export const DEFAULT_ONLY: StartModels = {
  claude: [{ id: DEFAULT_MODEL, label: "Default", hint: "The agent's own default for your account" }],
  codex: [{ id: DEFAULT_MODEL, label: "Default", hint: "The agent's own default for your account" }],
};

// One read per machine for the page's life: the lists change with a CLI release, not while a chat is written.
const loads = new Map<string, Promise<StartModels>>();

/** The models a new chat may start on, from the bridge that will check the choice (bridge/agent-start.ts). */
export function useStartModels(session: string | undefined, enabled = true): StartModels {
  const key = session ?? "";
  const [models, setModels] = useState<{ key: string; value: StartModels } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let load = loads.get(key);
    if (!load) {
      load = fetchStartModels(session);
      loads.set(key, load);
      // A failed read is tried again by the next picker that opens.
      load.catch(() => loads.delete(key));
    }
    load.then((value) => { if (live) setModels({ key, value }); }, () => undefined);
    return () => { live = false; };
  }, [key, session, enabled]);
  return models?.key === key ? models.value : DEFAULT_ONLY;
}

/**
 * The chosen model while the list has it, else nothing: the agent then starts on its default, and a
 * choice the list has not loaded yet, or another machine does not offer, stays remembered.
 */
export function listedModel(models: StartModels, agent: keyof StartModels, id: string): string | undefined {
  return models[agent].some((m) => m.id === id) ? id : undefined;
}
