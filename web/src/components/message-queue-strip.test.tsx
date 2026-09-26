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
