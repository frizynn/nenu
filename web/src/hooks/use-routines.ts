import { useEffect, useState } from "react";

import { errorMessage } from "@/components/node-start";
import { fetchOrgRoutines, toggleOrgRoutine } from "@/lib/api";
import type { RoutineList } from "@/lib/types";

export interface Routines {
  list?: RoutineList;
  error?: string;
  /** Turns one on or off; the list then reads as Organizations answers. Rejects with the cause. */
  toggle: (name: string, on: boolean) => Promise<void>;
}

/** A project's routines, read when the page that shows them opens and never polled (as the Routines page reads them). */
export function useRoutines(project: string, session?: string): Routines {
  const [read, setRead] = useState<{ project: string; list?: RoutineList; error?: string }>();
  useEffect(() => {
    let current = true;
    fetchOrgRoutines(project, session).then(
      (list) => { if (current) setRead({ project, list }); },
      (failure: unknown) => { if (current) setRead({ project, error: errorMessage(failure) }); },
    );
    return () => { current = false; };
  }, [project, session]);
  const mine = read?.project === project ? read : undefined;
  return {
    list: mine?.list,
    error: mine?.error,
    toggle: async (name, on) => {
      const { routines } = await toggleOrgRoutine({ project, name, on }, session);
      setRead({ project, list: routines });
    },
  };
}
