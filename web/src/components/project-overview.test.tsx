import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { ProjectOverview } from "./project-overview";

test("lists registered projects including inactive ones and opens the project entity", async () => {
  const onOpen = vi.fn();
  render(<ProjectOverview projects={[{
    slug: "demo", name: "Demo Project", goal: "Ship safely", status: "active",
    threads: [{ id: "t-0001", title: "Done", parentId: "root", role: "worker", status: "resolved" }],
  }]} onOpen={onOpen} />);

  expect(screen.getByText("Demo Project")).toBeInTheDocument();
  expect(screen.getByText("0 open threads")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /Demo Project/ }));
  expect(onOpen).toHaveBeenCalledWith("demo");
});
