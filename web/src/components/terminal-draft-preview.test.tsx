import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { TerminalDraftPreview } from "./terminal-draft-preview";

const props = { text: "git commit -m 'wip'", name: "Claude", busy: false, waiting: false, onCancel: vi.fn() };

// Each action is a 28 px word in the strip; the shared .hit-area gives a touch screen its 44 px reach
// (measured 69 by 24 with no reach on the bench, redesign-shots/polish-pages).
it("lets a finger reach every action at 44 px", () => {
  render(<TerminalDraftPreview {...props} onTakeOver={vi.fn()} onSend={vi.fn()} onDiscard={vi.fn()} />);
  for (const name of ["Send it first", "Add to my message", "Discard"]) expect(screen.getByRole("button", { name })).toHaveClass("hit-area");
});

it("settles the box's text in one tap each: send it, add it to mine, discard it (ADR 0113)", async () => {
  const onSend = vi.fn();
  const onTakeOver = vi.fn();
  const onDiscard = vi.fn();
  render(<TerminalDraftPreview {...props} onTakeOver={onTakeOver} onSend={onSend} onDiscard={onDiscard} />);
  await userEvent.click(screen.getByRole("button", { name: "Send it first" }));
  await userEvent.click(screen.getByRole("button", { name: "Add to my message" }));
  await userEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect([onSend, onTakeOver, onDiscard].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1]);
});

it("keeps Send it first and Discard for a paste only the CLI has, without Add to my message", () => {
  render(<TerminalDraftPreview {...props} text="[Pasted text #37 +27 lines]" onTakeOver={null} onSend={vi.fn()} onDiscard={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Add to my message" })).toBeNull();
  expect(screen.getByRole("button", { name: "Send it first" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Discard" })).toBeEnabled();
});

it("says a message waits on the choice, and offers to take it back", async () => {
  const onCancel = vi.fn();
  render(<TerminalDraftPreview {...props} waiting onCancel={onCancel} onTakeOver={null} onSend={vi.fn()} onDiscard={vi.fn()} />);
  expect(screen.getByRole("status")).toHaveTextContent("Your message goes as soon as you choose");
  await userEvent.click(screen.getByRole("button", { name: "Don't send mine" }));
  expect(onCancel).toHaveBeenCalledOnce();
});
