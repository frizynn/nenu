import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LocalModelPicker } from "./local-model-picker";

const rows = [
  { name: "Model A", description: "Fast tasks" },
  { name: "Model B", description: "Complex tasks" },
];

it("applies a model with one tap, and the model already running just closes", async () => {
  const onApply = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(<LocalModelPicker rows={rows} currentModel="Model A" onApply={onApply} onClose={onClose} />);
  await userEvent.click(screen.getByRole("menuitemradio", { name: "Model B" }));
  expect(onApply).toHaveBeenCalledExactlyOnceWith("Model B");
  await userEvent.click(screen.getByRole("menuitemradio", { name: "Model A" }));
  expect(onApply).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "Use model" })).not.toBeInTheDocument();
});

it("moves focus with the arrows and applies nothing until a row is activated", async () => {
  const onApply = vi.fn().mockResolvedValue(undefined);
  render(<LocalModelPicker rows={rows} currentModel="Model A" onApply={onApply} onClose={vi.fn()} />);
  const a = screen.getByRole("menuitemradio", { name: "Model A" });
  const b = screen.getByRole("menuitemradio", { name: "Model B" });
  a.focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(b).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}");
  expect(a).toHaveFocus();
  await userEvent.keyboard("{End}");
  expect(b).toHaveFocus();
  expect(onApply).not.toHaveBeenCalled();
  await userEvent.keyboard("{Enter}");
  expect(onApply).toHaveBeenCalledExactlyOnceWith("Model B");
});

it("checks only the model that runs, with its version under it, and guesses none", () => {
  const { rerender } = render(<LocalModelPicker rows={rows} currentModel="Model A" currentLabel="Model A 5.5" onApply={vi.fn()} onClose={vi.fn()} />);
  const a = screen.getByRole("menuitemradio", { name: "Model A" });
  expect(a).toHaveAttribute("aria-checked", "true");
  expect(a.querySelectorAll('[aria-hidden="true"]')[0]).toHaveClass("icon-check");
  expect(within(a).getByText("Model A 5.5")).toBeInTheDocument();
  expect(screen.getByRole("menuitemradio", { name: "Model B" })).toHaveAttribute("aria-checked", "false");
  expect(screen.getByText("Complex tasks")).toBeInTheDocument();
  rerender(<LocalModelPicker rows={rows} currentModel="model a" onApply={vi.fn()} onClose={vi.fn()} />);
  for (const row of screen.getAllByRole("menuitemradio")) expect(row).toHaveAttribute("aria-checked", "false");
});

it("locks every row while one applies, its spinner in place of the check", async () => {
  let resolve!: () => void;
  const onApply = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
  render(<LocalModelPicker rows={rows} onApply={onApply} onClose={vi.fn()} />);
  await userEvent.click(screen.getByRole("menuitemradio", { name: "Model B" }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: "Model B" }));
  expect(onApply).toHaveBeenCalledTimes(1);
  for (const row of screen.getAllByRole("menuitemradio")) expect(row).toBeDisabled();
  expect(within(screen.getByRole("menuitemradio", { name: "Model B" })).getByLabelText("Applying")).toBeInTheDocument();
  await act(async () => resolve());
  for (const row of screen.getAllByRole("menuitemradio")) expect(row).toBeEnabled();
});

it("says a failure under the list and leaves every row ready to retry", async () => {
  const onApply = vi.fn().mockRejectedValueOnce(new Error("Model menu changed")).mockResolvedValueOnce(undefined);
  render(<LocalModelPicker rows={rows} onApply={onApply} onClose={vi.fn()} />);
  await userEvent.click(screen.getByRole("menuitemradio", { name: "Model B" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Model menu changed");
  expect(screen.getByRole("menuitemradio", { name: "Model B" })).toBeEnabled();
  await userEvent.click(screen.getByRole("menuitemradio", { name: "Model B" }));
  expect(onApply).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("disables every row when the picker is locked, and says when there is nothing to pick", () => {
  const props = { onApply: vi.fn(), onClose: vi.fn() };
  const { rerender } = render(<LocalModelPicker rows={[]} {...props} />);
  expect(screen.getByText("No models available yet.")).toBeInTheDocument();
  rerender(<LocalModelPicker rows={rows} disabled {...props} />);
  for (const row of screen.getAllByRole("menuitemradio")) expect(row).toBeDisabled();
});
