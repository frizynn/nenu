import { describe, expect, it } from "vitest";

import { displayName, displayPlace } from "./display-name";
import type { AgentView } from "./types";

function pane(paneId: string, extra: Partial<AgentView> = {}): AgentView {
  return { paneId, workspaceId: "w1", workspaceLabel: "nenu", workspaceNumber: 1, tabId: "w1:t1", agent: "claude", status: "idle", cwd: "/repo", focused: false, ...extra };
}

describe("displayName", () => {
  it("falls back from the pane label to the session name, the terminal title, then the agent", () => {
    expect(displayName(pane("p", { paneLabel: "Reviewer", sessionName: "s", terminalTitle: "t" }))).toBe("Reviewer");
    expect(displayName(pane("p", { sessionName: "billing-fix", terminalTitle: "t" }))).toBe("billing-fix");
    expect(displayName(pane("p", { terminalTitle: "Running tests" }))).toBe("Running tests");
    expect(displayName(pane("p"))).toBe("claude");
    expect(displayName(pane("p", { kind: "shell" }))).toBe("shell");
  });

  it("never names a pane after its tab, so the tab can be the line under it", () => {
    expect(displayName(pane("p", { tabLabel: "redesign" }))).not.toBe("redesign");
  });
});

describe("displayPlace", () => {
  // Parts, not one string: at 390px a joined "moonward_os › redesign-…" loses the tab, the only part
  // that tells rows apart, so a view lets the place shrink first (lib/pane-name.ts).
  it("places a pane in its workspace and tab, as separate parts", () => {
    expect(displayPlace(pane("p", { tabLabel: "redesign" }))).toEqual({ place: "nenu", tab: "redesign" });
  });

  it("drops a tab whose label says nothing, and names an unlabelled workspace by number", () => {
    expect(displayPlace(pane("p"))).toEqual({ place: "nenu", tab: null });
    expect(displayPlace(pane("p", { workspaceLabel: "", workspaceNumber: 2 }))).toEqual({ place: "Workspace 2", tab: null });
  });
});
