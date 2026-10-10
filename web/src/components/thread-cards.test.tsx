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
