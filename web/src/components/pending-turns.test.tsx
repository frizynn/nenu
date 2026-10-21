import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PendingTurns } from "./pending-turns";
import type { LocalSend, LocalSendActions } from "@/lib/local-sends";

const actions = (): LocalSendActions => ({
  retry: vi.fn(), edit: vi.fn(), remove: vi.fn(), sendNow: vi.fn(), readNow: vi.fn(), openTerminal: vi.fn(),
});

const queued: LocalSend = {
  id: "s1", text: "after this turn", state: "queued", queueId: "q1", queueState: "queued",
  deliveryMode: "afterTurn", agent: "claude",
};

describe("PendingTurns", () => {
  it("marks a queued message with a Queued badge, Edit and Remove one tap away and Send now behind the ⋯", async () => {
    const user = userEvent.setup();
    const handlers = actions();
    render(<PendingTurns sends={[queued]} actions={handlers} />);

    expect(screen.getByText("after this turn")).toBeInTheDocument();
    const status = screen.getByRole("status");
    expect(within(status).getByText("Queued")).toBeInTheDocument();
    expect(status).toHaveTextContent("Queued Waiting for Claude to finish this turn.");
    // Edit and Remove are on the line: one tap each (ADR 0117).
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(handlers.remove).toHaveBeenCalledExactlyOnceWith(queued);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(handlers.edit).toHaveBeenCalledExactlyOnceWith(queued);
    // Skipping the wait the operator chose stays a deliberate second step.
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Queued message actions" }));
    const menu = screen.getByRole("dialog", { name: "Queued message" });
    expect(within(menu).getAllByRole("button").map((b) => b.textContent).filter(Boolean)).toEqual(["Send now"]);
  });

  it("lets a message in Claude's own queue be edited or removed with one tap, beside Read it now", async () => {
    const user = userEvent.setup();
    const handlers = actions();
    const inClaude: LocalSend = { ...queued, native: "enqueued", queueState: undefined };
    render(<PendingTurns sends={[inClaude]} actions={handlers} />);
    expect(screen.getByRole("status")).toHaveTextContent("In Claude's queue.");
    expect(screen.getByRole("button", { name: "Read it now" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(handlers.edit).toHaveBeenCalledExactlyOnceWith(inClaude);
  });

  it("closes the open ⋯ when the message starts going, and does not reopen it on its own", async () => {
    const user = userEvent.setup();
    const handlers = actions();
    const { rerender } = render(<PendingTurns sends={[queued]} actions={handlers} />);
    await user.click(screen.getByRole("button", { name: "Queued message actions" }));
    expect(screen.getByRole("dialog", { name: "Queued message" })).toBeInTheDocument();

    // The turn ends and the bridge starts delivering it: nothing is left to manage.
    rerender(<PendingTurns sends={[{ ...queued, queueState: "sending" }]} actions={handlers} />);
    expect(screen.queryByRole("dialog", { name: "Queued message" })).toBeNull();

    // A delivery that falls back to the queue offers the ⋯ again, closed until it is tapped.
    rerender(<PendingTurns sends={[queued]} actions={handlers} />);
    expect(screen.getByRole("button", { name: "Queued message actions" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog", { name: "Queued message" })).toBeNull();
  });

  it("tells two queued messages' ⋯ apart by the message each one manages", () => {
    const second: LocalSend = { ...queued, id: "s4", queueId: "q2", text: "and then deploy" };
    render(<PendingTurns sends={[queued, second]} actions={actions()} />);
    const menus = screen.getAllByRole("button", { name: "Queued message actions" });
    expect(menus[0]).toHaveAccessibleDescription("after this turn");
    expect(menus[1]).toHaveAccessibleDescription("and then deploy");
  });

  it("keeps a failed send's remedy on the line, where the failure is", async () => {
    const user = userEvent.setup();
    const handlers = actions();
    const failed: LocalSend = { id: "s2", text: "ship it", state: "failed", error: "Not sent" };
    render(<PendingTurns sends={[failed]} actions={handlers} />);

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(handlers.retry).toHaveBeenCalledExactlyOnceWith(failed);
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });

  it("says Sending… with nothing to tap while the send is in flight", () => {
    render(<PendingTurns sends={[{ id: "s3", text: "on its way", state: "sending" }]} actions={actions()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Sending…");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
