import { render, screen } from "@testing-library/react";
import { vi } from "vitest";

import { StartAgent } from "./start-agent";

vi.mock("react-router", async (original) => ({ ...await original<typeof import("react-router")>(), useRevalidator: () => ({ revalidate: async () => {}, state: "idle" }) }));

// A shell pane's way to start an agent is a page action: the large Button every empty state and
// page offers (44 high, 16 px, auto width), Codex in ink and Claude Code outlined beside it.
it("offers Start Codex and Start Claude Code as the page's large buttons", () => {
  render(<StartAgent paneId="w1:sh" disabled={false} ready />);
  const codex = screen.getByRole("button", { name: "Start Codex" });
  const claude = screen.getByRole("button", { name: "Start Claude Code" });
  expect(codex).toHaveClass("ui-button-lg", "bg-foreground", "text-base");
  expect(claude).toHaveClass("ui-button-lg", "text-base");
  expect(claude).not.toHaveClass("bg-foreground");
});
