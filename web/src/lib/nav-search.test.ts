import { describe, expect, it } from "vitest";

import { matchRange, navSearch, type SearchHit } from "./nav-search";
import type { AgentView } from "./types";

function pane(paneId: string, extra: Partial<AgentView> = {}): AgentView {
  return { paneId, workspaceId: "w", workspaceLabel: "w", workspaceNumber: 1, tabId: "t", agent: "claude", status: "idle", cwd: "/", focused: false, ...extra };
}

describe("navigation search", () => {
  const names = (hits: SearchHit[]) => hits.map((hit) => hit.title);
  const groups = (query: string, source = herd, limit?: number) =>
    navSearch(source, query, { limit }).map((group) => [group.label, names(group.hits), group.more]);
  const herd = {
    agents: [
      pane("idle", { paneLabel: "Idle Claude", lastActiveAt: 10 }),
      pane("work", { paneLabel: "Working Claude", lastActiveAt: 30 }),
      pane("ask", { paneLabel: "Blocked Claude", lastActiveAt: 20, status: "blocked" }),
      pane("cx", { paneLabel: "Codex", agent: "codex", lastActiveAt: 40 }),
      pane("note", { paneLabel: "Notes", workspaceLabel: "claws", lastActiveAt: 50 }),
      pane("b", { paneLabel: "raw review", lastActiveAt: 5 }),
    ],
    shellPanes: [pane("sh", { kind: "shell", paneLabel: "dev server", agent: "" })],
  };

  it("lists the agents whose name matches, newest first, ahead of those matching only by where they live", () => {
    expect(groups("cla")).toEqual([["Chats", ["Working Claude", "Blocked Claude", "Idle Claude", "Notes"], 0]]);
    const work = navSearch(herd, "cla")[0]!.hits[0]!;
    expect(work).toMatchObject({ kind: "pane", key: "pane:work", place: { place: "w", tab: null } });
  });

  it("finds shells too", () => {
    expect(groups("serv")).toEqual([["Chats", ["dev server"], 0]]);
  });

  it("caps each group and says how many more there are", () => {
    const many = { agents: Array.from({ length: 11 }, (_, i) => pane(`a${i}`, { paneLabel: `Agent ${i}` })), shellPanes: [] };
    expect(groups("agent", many, 8)).toEqual([["Chats", ["Agent 0", "Agent 1", "Agent 2", "Agent 3", "Agent 4", "Agent 5", "Agent 6", "Agent 7"], 3]]);
  });

  it("finds a workspace by its name, ahead of Chats", () => {
    const ws = (workspaceId: string, number: number, label: string) => ({ workspaceId, number, label, focused: false, activeTabId: "", tabCount: 2, paneCount: 1 });
    const source = { ...herd, workspaces: [ws("w9", 9, "claws"), ws("w2", 2, "api")] };
    expect(groups("claw", source)).toEqual([["Workspaces", ["claws"], 0], ["Chats", ["Notes"], 0]]);
    expect(navSearch(source, "claw")[0]!.hits[0]).toMatchObject({ kind: "workspace", key: "workspace:w9", place: { place: "2 tabs", tab: null } });
  });

  it("finds an agent by its kind, its folder or its terminal's title, below the agents whose name matches", () => {
    const source = {
      agents: [
        pane("fix", { paneLabel: "Fix login", agent: "codex", cwd: "/home/me/shop-api", terminalTitle: "vim auth.ts", lastActiveAt: 60 }),
        pane("cx", { paneLabel: "Codex", agent: "codex", lastActiveAt: 40 }),
        pane("cl", { paneLabel: "Claude", agent: "claude", lastActiveAt: 50 }),
      ],
      shellPanes: [],
    };
    expect(groups("codex", source)).toEqual([["Chats", ["Codex", "Fix login"], 0]]);
    expect(groups("shop-api", source)).toEqual([["Chats", ["Fix login"], 0]]);
    expect(groups("auth.ts", source)).toEqual([["Chats", ["Fix login"], 0]]);
    // The kind is a whole word: a partial name does not list every agent of that kind.
    expect(groups("cod", source)).toEqual([["Chats", ["Codex"], 0]]);
  });

  it("leads with the group holding the best match, so the first row picked is the closest name", () => {
    const workspaces = [{ workspaceId: "w5", number: 5, label: "old-billing", focused: false, activeTabId: "", tabCount: 2, paneCount: 0 }];
    const source = { agents: [pane("bill", { paneLabel: "Billing fix", lastActiveAt: 10 })], shellPanes: [], workspaces };
    expect(groups("billing", source)).toEqual([["Chats", ["Billing fix"], 0], ["Workspaces", ["old-billing"], 0]]);
  });

  it("finds nothing without a query", () => {
    expect(navSearch(herd, "  ")).toEqual([]);
  });

  it("locates the matched text, ignoring case", () => {
    expect(matchRange("Working Claude", "cla")).toEqual([8, 11]);
    expect(matchRange("Working Claude", " CLA ")).toEqual([8, 11]);
    expect(matchRange("Codex", "cla")).toBeNull();
    expect(matchRange("Codex", "")).toBeNull();
  });
});
