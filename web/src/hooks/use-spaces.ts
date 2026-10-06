import { openNewAgent } from "@/lib/spawn";

// Entry points for "new tab" / "new workspace". Both open the shared new-agent sheet
// (components/new-agent-sheet.tsx), which creates the shell, starts the chosen agent and jumps into
// the pane. The callbacks are module-level, so they are stable across renders.
const newTab = (workspaceId: string) => openNewAgent({ kind: "tab", workspaceId });
const newSpace = () => openNewAgent({ kind: "workspace" });

export function useSpaceActions() {
  return { newTab, newSpace };
}
