import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";

import { PanelSections, type PanelSection } from "./panel-sections";

const SECTIONS: PanelSection[] = [
  { id: "threads", label: "Threads", body: <p>Lote de facturación</p> },
  { id: "waiting", label: "Waiting on you", urgent: true, badge: <span>2</span>, body: <p>Which bank?</p> },
  { id: "changes", label: "Changes", body: <p>3 files</p> },
];

it("folds a section shut: its rows leave the page and its head keeps its badge", async () => {
  const user = userEvent.setup();
  render(<PanelSections kind="test" sections={SECTIONS} />);
  const head = screen.getByRole("button", { name: /^Waiting on you/ });
  await user.click(head);
  await waitFor(() => expect(screen.queryByText("Which bank?")).not.toBeInTheDocument());
  expect(head).toHaveTextContent("2");
  expect(head).toHaveAttribute("aria-expanded", "false");
});

it("never hides a section that asks something of the operator", async () => {
  const user = userEvent.setup();
  render(<PanelSections kind="test" sections={SECTIONS} />);
  await user.click(screen.getByRole("button", { name: /^Arrange/ }));
  expect(screen.getByRole("button", { name: "Hide Threads" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Hide Waiting on you" })).not.toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "Waiting on you" })).getByRole("button", { name: "Move Waiting on you up" })).toBeEnabled();
});

it("keeps the keyboard in place: Arrange and Done hand focus to each other, a move keeps its arrow or the other at an end", async () => {
  const user = userEvent.setup();
  render(<PanelSections kind="test" sections={SECTIONS} />);
  await user.click(screen.getByRole("button", { name: /^Arrange/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Done" })).toHaveFocus());
  await user.click(screen.getByRole("button", { name: "Move Threads down" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Move Threads down" })).toHaveFocus());
  await user.click(screen.getByRole("button", { name: "Move Threads down" }));
  // Last now: its down arrow is disabled, so the up arrow takes the focus.
  await waitFor(() => expect(screen.getByRole("button", { name: "Move Threads up" })).toHaveFocus());
  expect(screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"))).toEqual(["Waiting on you", "Changes", "Threads"]);
  await user.click(screen.getByRole("button", { name: "Done" }));
  await waitFor(() => expect(screen.getByRole("button", { name: /^Arrange/ })).toHaveFocus());
});
