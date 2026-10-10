import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessageQueueStrip } from "./message-queue-strip";

it("edits, selects for delivery and removes a queued message without changing its identity", async () => {
  const user = userEvent.setup();
  const change = vi.fn().mockResolvedValue(true);
  const item = {
    id: "draft-id",
    text: "Original",
    state: "queued" as const,
    createdAt: 1,
    revision: 2,
  };
  render(
    <MessageQueueStrip
      messages={[item]}
      busy={false}
      error=""
      change={change}
    />,
  );
  await user.click(
    screen.getByRole("button", { name: "Edit queued message 1" }),
  );
  const input = screen.getByRole("textbox", { name: "Edit queued message" });
  await user.clear(input);
  await user.type(input, "Revised");
  await user.click(screen.getByRole("button", { name: "Save queued message" }));
  expect(change).toHaveBeenLastCalledWith("edit", "Revised", item);
  await user.click(
    screen.getByRole("button", { name: "Send queued message 1 now" }),
  );
  expect(change).toHaveBeenLastCalledWith("send", undefined, item);
  await user.click(
    screen.getByRole("button", { name: "Remove queued message 1" }),
  );
  expect(change).toHaveBeenLastCalledWith("remove", undefined, item);
});

it("keeps uncertain deliveries visible without offering an unsafe retry", () => {
  render(
    <MessageQueueStrip
      messages={[
        {
          id: "uncertain",
          text: "Keep",
          state: "paused",
          createdAt: 1,
          revision: 2,
        },
      ]}
      busy={false}
      error=""
      change={vi.fn()}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "Edit queued message 1" }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Send queued message 1 now" }),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: "Remove queued message 1" }),
  ).toBeInTheDocument();
});

it("says per row and per agent why it waits, and whose device queued it", () => {
  render(
    <MessageQueueStrip
      agent="codex"
      messages={[
        { id: "a", text: "after this turn", state: "queued", createdAt: 1, revision: 1, deliveryMode: "afterTurn", waitingFor: "working", device: "Fran's iPhone" },
        { id: "b", text: "behind a dialog", state: "queued", createdAt: 2, revision: 1, deliveryMode: "steer", waitingFor: "dialog" },
      ]}
      busy={false}
      error=""
      change={vi.fn()}
    />,
  );
  expect(screen.getByText("2 messages wait in Nenu")).toBeInTheDocument();
  expect(screen.getByText(/Waiting for Codex to finish this turn\./)).toHaveTextContent("· from Fran's iPhone");
  expect(screen.getByText("Waiting. Answer the dialog first.")).toBeInTheDocument();
});

it("offers a stranded row only Send here and Remove", async () => {
  const user = userEvent.setup();
  const change = vi.fn().mockResolvedValue(true);
  const item = {
    id: "lost",
    text: "for the old conversation",
    state: "queued" as const,
    createdAt: 1,
    revision: 3,
    stranded: { reason: "The conversation in this pane changed. Send it here or remove it.", since: 1 },
  };
  render(<MessageQueueStrip agent="claude" messages={[item]} busy={false} error="" change={change} />);
  expect(screen.getByText(item.stranded.reason)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Edit queued message 1" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Send queued message 1 here" }));
  expect(change).toHaveBeenLastCalledWith("send", undefined, item);
  expect(screen.getByRole("button", { name: "Remove queued message 1" })).toBeInTheDocument();
});

it("shows a message Claude's own queue still holds, with Read it now armed by the composer", async () => {
  const user = userEvent.setup();
  const readNow = vi.fn();
  const delivered = [{ id: "d1", text: "read me", sentAt: 1, deliveryMode: "asap" as const, native: "enqueued" as const }];
  const { rerender } = render(
    <MessageQueueStrip agent="claude" messages={[]} delivered={delivered} busy={false} error="" change={vi.fn()} readNow={readNow} />,
  );
  expect(screen.getByText("In Claude's queue. Claude reads it after the step it's on.")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Read it now" }));
  expect(readNow).toHaveBeenCalledWith("d1");
  rerender(
    <MessageQueueStrip agent="claude" messages={[]} delivered={delivered} busy={false} error="" change={vi.fn()} readNow={readNow} readNowArmed="d1" />,
  );
  expect(screen.getByRole("button", { name: "Tap again to read it now" })).toBeInTheDocument();
});
