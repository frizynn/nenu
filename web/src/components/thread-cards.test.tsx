import { render, screen } from "@testing-library/react";
import { vi } from "vitest";

import type { ProjectThreadView, ProjectView } from "@/lib/types";
import { ThreadCards } from "./thread-cards";

const node = (id: string, title: string, parentId: string, extra: Partial<ProjectThreadView> = {}): ProjectThreadView =>
  ({ id, title, parentId, role: "worker", status: "open", ...extra });

it("shows the coordinator's open work in the tree's order and leaves the resolved to History", () => {
  const project: ProjectView = {
    slug: "awam", name: "AWAM", status: "active",
    threads: [
      node("t-1", "Hotfix", "root", { group: "idle" }),
      node("t-2", "Depot", "root", { paneId: "depot", liveStatus: "blocked" }),
      node("t-3", "Mobile", "root", { role: "coordinator", group: "working" }),
      node("t-4", "Landing", "t-3", { group: "working" }),
      node("t-5", "Old fix", "root", { status: "resolved", updated: "2026-10-10T13:00:00Z" }),
    ],
  };
  render(<ThreadCards project={project} panes={[]} readOnly={false} onOpen={vi.fn()} onChanged={vi.fn()} />);
  const cards = screen.getAllByRole("article").map((card) => card.getAttribute("aria-label"));
  expect(cards).toEqual(["Mobile", "Depot", "Hotfix"]);
});

it("draws a card's actions as the shared buttons: Merge in ink, Answer and View thread beside it at the same size", () => {
  const project: ProjectView = {
    slug: "awam", name: "AWAM", status: "active", prActions: true,
    threads: [
      node("t-1", "Depot", "root", { paneId: "depot", liveStatus: "blocked" }),
      node("t-2", "Panel", "root", { paneId: "panel", group: "ready-for-review", pr: { number: 7, state: "open", mergeBlocker: null } }),
    ],
  };
  render(<ThreadCards project={project} panes={[]} readOnly={false} onOpen={vi.fn()} onChanged={vi.fn()} />);
  const merge = screen.getByRole("button", { name: "Merge Panel" });
  expect(merge).toHaveAttribute("data-slot", "button");
  expect(merge).toHaveClass("ui-button-lg", "bg-foreground", "text-base");
  for (const button of [screen.getByRole("button", { name: "Answer" }), ...screen.getAllByRole("button", { name: "View thread" })]) {
    expect(button).toHaveClass("ui-button-lg", "text-base");
    expect(button).not.toHaveClass("bg-foreground");
  }
});
