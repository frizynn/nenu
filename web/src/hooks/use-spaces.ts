import { openNewAgent } from "@/lib/spawn";

// Entry point for "new tab". It opens the shared new-agent sheet (components/new-agent-sheet.tsx),
// which creates the shell, starts the chosen agent and jumps into the pane. The callback is
// module-level, so it is stable across renders.
const newTab = (workspaceId: string) => openNewAgent({ kind: "tab", workspaceId });

export function useSpaceActions() {
  return { newTab };
}
