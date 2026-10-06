import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { ProjectOverview } from "./project-overview";

test("lists registered projects including inactive ones and opens the project entity", async () => {
  const onOpen = vi.fn();
  render(<ProjectOverview projects={[{
    slug: "demo", name: "Demo Project", goal: "Ship safely", status: "active",
    coordinator: { paneId: "p", agent: "claude", liveStatus: "idle" },
    threads: [{ id: "t-0001", title: "Done", parentId: "root", role: "worker", status: "resolved" }],
  }]} onOpen={onOpen} />);

  const row = screen.getByRole("button", { name: /Demo Project/ });
  expect(row).toHaveTextContent("No open tasks");
  expect(row).toHaveAccessibleName(/^Demo Project.*coordinator idle$/);
  await userEvent.click(row);
  expect(onOpen).toHaveBeenCalledWith("demo");
});
