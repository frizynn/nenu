import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessageQueueStrip } from "./message-queue-strip";
import { PendingTurns } from "./pending-turns";
import { imageChip } from "@/lib/message-images";

/** Opens row n's ⋯ and returns the menu it shows. */
async function menuOf(user: ReturnType<typeof userEvent.setup>, n: number) {
  await user.click(screen.getByRole("button", { name: `Queued message ${n} actions` }));
  return screen.getByRole("dialog", { name: "Queued message" });
}

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
  await user.click(within(await menuOf(user, 1)).getByRole("button", { name: "Edit" }));
  const input = screen.getByRole("textbox", { name: "Edit queued message" });
  await user.clear(input);
  await user.type(input, "Revised");
  await user.click(screen.getByRole("button", { name: "Save queued message" }));
  expect(change).toHaveBeenLastCalledWith("edit", "Revised", item);
  await user.click(within(await menuOf(user, 1)).getByRole("button", { name: "Send now" }));
  expect(change).toHaveBeenLastCalledWith("send", undefined, item);
  await user.click(within(await menuOf(user, 1)).getByRole("button", { name: "Remove" }));
  expect(change).toHaveBeenLastCalledWith("remove", undefined, item);
});

it("keeps uncertain deliveries visible without offering an unsafe retry", async () => {
  const user = userEvent.setup();
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
  const menu = await menuOf(user, 1);
  expect(within(menu).getAllByRole("button").map((b) => b.textContent).filter(Boolean)).toEqual(["Remove"]);
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
  expect(screen.getAllByText("Queued")).toHaveLength(2);
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
  const menu = await menuOf(user, 1);
  expect(within(menu).getAllByRole("button").map((b) => b.textContent).filter(Boolean)).toEqual(["Send here", "Remove"]);
  await user.click(within(menu).getByRole("button", { name: "Send here" }));
  expect(change).toHaveBeenLastCalledWith("send", undefined, item);
});

it("shows a message Claude's own queue still holds, with Read it now armed by the composer", async () => {
  const user = userEvent.setup();
  const readNow = vi.fn();
  const delivered = [{ id: "d1", text: "read me", sentAt: 1, deliveryMode: "asap" as const, native: "enqueued" as const }];
  const { rerender } = render(
    <MessageQueueStrip agent="claude" messages={[]} delivered={delivered} busy={false} error="" change={vi.fn()} readNow={readNow} />,
  );
  expect(screen.getByText("In Claude's queue, read after this step.")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Read it now" }));
  expect(readNow).toHaveBeenCalledWith("d1");
  rerender(
    <MessageQueueStrip agent="claude" messages={[]} delivered={delivered} busy={false} error="" change={vi.fn()} readNow={readNow} readNowArmed="d1" />,
  );
  expect(screen.getByRole("button", { name: "Tap again to read it now" })).toBeInTheDocument();
});

it("draws a row queued on another device exactly as this device draws its own", () => {
  const row = { id: "q1", text: "after this turn", state: "queued" as const, createdAt: 1, revision: 1, deliveryMode: "afterTurn" as const, waitingFor: "working" as const };
  const strip = render(<MessageQueueStrip agent="claude" messages={[row]} busy={false} error="" change={vi.fn()} />);
  const elsewhere = within(strip.container).getByRole("status").textContent;
  strip.unmount();
  const own = render(
    <PendingTurns
      sends={[{ id: "s1", text: "after this turn", state: "queued", queueId: "q1", queueState: "queued", deliveryMode: "afterTurn", waitingFor: "working", agent: "claude" }]}
      actions={{ retry: vi.fn(), edit: vi.fn(), remove: vi.fn(), sendNow: vi.fn(), readNow: vi.fn(), openTerminal: vi.fn() }}
    />,
  );
  expect(within(own.container).getByRole("status").textContent).toBe(elsewhere);
  expect(elsewhere).toBe("Queued Waiting for Claude to finish this turn.");
});

it("edits a queued message's words with each picture kept in its place; a chip the edit breaks takes its picture", async () => {
  const user = userEvent.setup();
  const change = vi.fn().mockResolvedValue(true);
  const up = "/home/you/.local/state/nenu/uploads";
  const red = `${up}/w1_p1-mv8g-0a1b2c3d.png`;
  const blue = `${up}/w1_p1-mv8g-0a1b2c3e.png`;
  const item = { id: "q", text: `first ${red} then ${blue} end`, state: "queued" as const, createdAt: 1, revision: 2 };
  render(<MessageQueueStrip messages={[item]} busy={false} error="" change={change} />);
  await user.click(within(await menuOf(user, 1)).getByRole("button", { name: "Edit" }));
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Edit queued message" });
  expect(input).toHaveValue(`first ${imageChip(1)} then ${imageChip(2)} end`);
  // A tap inside a chip puts the cursor at its end, so typing never lands in one.
  input.focus();
  input.setSelectionRange(9, 9);
  fireEvent.select(input);
  expect(input.selectionStart).toBe(`first ${imageChip(1)}`.length);
  // A Backspace into chip 1: picture 1 leaves with all of its chip, and blue becomes picture 1.
  const end = `first ${imageChip(1)}`.length;
  fireEvent.change(input, { target: { value: input.value.slice(0, end - 1) + input.value.slice(end), selectionStart: end - 1, selectionEnd: end - 1 } });
  expect(input).toHaveValue(`first  then ${imageChip(1)} end`);
  // React wrote the corrected text back; the cursor stays where the Backspace left it.
  expect(input.selectionStart).toBe("first ".length);
  await user.click(screen.getByRole("button", { name: "Save queued message" }));
  expect(change).toHaveBeenLastCalledWith("edit", `first  then ${blue} end`, item);
});
