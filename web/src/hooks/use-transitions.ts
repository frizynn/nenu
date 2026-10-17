import { useEffect, useRef } from "react";

import type { AgentStatus, AgentView, ProjectView } from "@/lib/types";
import { displayName, displayPlace } from "@/lib/display-name";
import { homePath, panePath } from "@/lib/nav";
import { setStatus } from "@/lib/status";

/** Where the sidebar, and its +1 on a chat's row, is on screen (workbench.css). */
const DESK = "(min-width: 1024px)";

// In-app lifecycle notifications. We diff each snapshot against the previous one and surface a
// header status line when an agent starts asking for you. Background/OS notifications are handled
// separately by the server via Web Push; this is the foreground equivalent, and a phone's alone: on a
// desk the sidebar's row says it. An agent that finishes raises nothing: its row says "New" (Home on a
// phone, +1 in a desk's bar), since a toast per finish chains over the header and takes its taps (ADR 0094).
//
// The first snapshot never fires (prev is null), so opening the app doesn't spam the status line
// for agents that were already blocked — matching the server's transition semantics.
export function useAgentTransitions(agents: AgentView[], openPaneId: string | null, session?: string,
  projects?: readonly ProjectView[]) {
  const prev = useRef<{ session?: string; statuses: Map<string, AgentStatus> } | null>(null);

  useEffect(() => {
    const now = new Map(agents.map((a) => [a.paneId, a.status]));
    const before = prev.current && prev.current.session === session ? prev.current.statuses : null;
    prev.current = { session, statuses: now };
    if (!before) return;

    const changed = agents.filter((agent) => {
      const was = before.get(agent.paneId);
      return was !== undefined && was !== agent.status && agent.paneId !== openPaneId;
    });
    // A desk's sidebar marks the chat's row with a +1 (components/desk-nav.tsx), so a toast over the page would say it twice.
    if (typeof window.matchMedia === "function" && window.matchMedia(DESK).matches) return;
    const attention = changed.filter((agent) => agent.status === "blocked");
    if (!attention.length) return;

    const first = attention[0]!;
    // The pane's own name, as its header and the sidebar show it. Only the bare CLI id ("claude",
    // the last fallback) gets a capital; a label is printed as the operator wrote it.
    const name = displayName(first, projects).trim();
    const subject = attention.length > 1 ? `${attention.length} agents`
      : !name ? "Agent"
      : name === first.agent ? name.charAt(0).toUpperCase() + name.slice(1) : name;
    const title = `${subject} ${attention.length === 1 ? "needs your input" : "need your input"}`;
    const locations = [...new Set(attention.map((agent) => {
      const { place, tab } = displayPlace(agent, projects);
      return [place, tab].filter(Boolean).join(" · ");
    }))];
    const description = locations.slice(0, 3).join(", ") + (locations.length > 3 ? ` +${locations.length - 3} more` : "");
    // One agent opens its pane; several open Home, whose Needs you lists each of them.
    const to = attention.length === 1 ? panePath(first.paneId, session) : homePath(session);
    setStatus(title, "warn", undefined, { description, background: true, to });
  }, [agents, openPaneId, session, projects]);
}
