import { fireEvent, render, screen, within } from "@testing-library/react";
import { createRef, useState } from "react";
import userEvent from "@testing-library/user-event";
import { WorkbenchTelemetry } from "./workbench-telemetry";
import type { WorkbenchPanel } from "./workbench-telemetry";

it("says plainly that nothing was reported, in place of a button that led to the same sentence", () => {
  render(<WorkbenchTelemetry mode="metrics" modelAvailable={false} disabled={false} onChooseModel={vi.fn()} />);
  expect(screen.getByText("This agent hasn't reported usage yet.")).toBeVisible();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(screen.queryByText(/0%/)).not.toBeInTheDocument();
});

it("shows the context and both quota windows inline, with no intermediate Usage button", () => {
  render(<WorkbenchTelemetry mode="metrics" modelAvailable disabled={false} onChooseModel={vi.fn()} telemetry={{ source: "statusline", fileTruncated: false,
    context: { usedTokens: 26_000, windowTokens: 200_000, usedPercent: 13 },
    rateLimits: [{ name: "primary", windowMinutes: 300, usedPercent: 8 }, { name: "secondary", windowMinutes: 10080, usedPercent: 19 }] }} />);
  expect(screen.queryByRole("button", { name: /usage/i })).not.toBeInTheDocument();
  expect(screen.getByText("13% · 26k / 200k")).toBeVisible();
  expect(screen.getByRole("progressbar", { name: "Context window usage" })).toHaveAttribute("aria-valuenow", "13");
  expect(screen.getByText("5h window")).toBeVisible();
  expect(screen.getByText("Weekly")).toBeVisible();
  expect(screen.getByText("8% used")).toBeVisible();
  expect(screen.getByText("19% used")).toBeVisible();
  expect(screen.getByRole("progressbar", { name: "primary rate limit used" })).toHaveAttribute("aria-valuenow", "8");
});

it("distinguishes last-message totals from context and flags stale or clipped metrics", () => {
  render(<WorkbenchTelemetry mode="metrics" modelAvailable disabled={false} stale onChooseModel={vi.fn()}
    telemetry={{ source: "journal", model: "reported-model", tokens: { scope: "last-message", input: 100, output: 20, total: 120 }, context: { usedTokens: 100 }, fileTruncated: true }} />);
  expect(screen.getByText("Last message")).toBeVisible();
  expect(screen.getByText(/values may be out of date/)).toBeVisible();
  expect(screen.getByText(/Only the tail/)).toBeVisible();
  // Tokens without a window are no percentage.
  expect(screen.queryByRole("progressbar", { name: "Context window usage" })).not.toBeInTheDocument();
  expect(screen.queryByText(/Account limits not reported/)).not.toBeInTheDocument();
});

it("keeps a disabled model control from initiating a terminal action", () => {
  const choose = vi.fn();
  render(<WorkbenchTelemetry mode="model" modelAvailable disabled onChooseModel={choose} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose model" }));
  expect(choose).not.toHaveBeenCalled();
});

it("closes the context panel when typing resumes", async () => {
  const telemetry = { source: "statusline" as const, fileTruncated: false, context: { usedPercent: 40 } };
  render(<><WorkbenchTelemetry mode="model" modelAvailable disabled={false} onChooseModel={vi.fn()} telemetry={telemetry} /><textarea aria-label="Draft" /></>);
  await userEvent.click(screen.getByRole("button", { name: "Context window 40% used" }));
  expect(screen.getByRole("dialog", { name: "Context window" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("textbox"));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("textbox")).toHaveFocus();
});

it("lets the parent own model toggling and one active inspection panel", async () => {
  const choose = vi.fn();
  const panelChange = vi.fn();
  const telemetry = { source: "statusline" as const, fileTruncated: false, context: { usedPercent: 40 } };
  function Controlled() {
    const [panel, setPanel] = useState<WorkbenchPanel>(null);
    return <>
      <WorkbenchTelemetry mode="model" telemetry={telemetry} panel={panel} modelOpen={panel === "model"} modelAvailable disabled={panel === "model"}
        onChooseModel={() => { choose(); setPanel((value) => value === "model" ? null : "model"); }}
        onPanelChange={(value) => { panelChange(value); setPanel(value); }} />
      {panel === "model" && <div role="dialog" aria-label="Model picker" />}
    </>;
  }
  render(<Controlled />);
  await userEvent.click(screen.getByRole("button", { name: "Choose model" }));
  expect(panelChange).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "Model picker" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Choose model" })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "Choose model" }));
  expect(choose).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Context window 40% used" }));
  await userEvent.click(screen.getByRole("button", { name: "Choose model" }));
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(screen.getByRole("dialog", { name: "Model picker" })).toBeInTheDocument();
});

// A bare "Model" read as a caption for nothing: with no model known the chip says what a tap does, and
// where a tap can do nothing either (no picker) there is no chip until the agent reports one.
it("says Choose model while no model is known, and draws no chip where there is nothing to choose", () => {
  const { rerender } = render(<WorkbenchTelemetry mode="model" modelAvailable disabled={false} onChooseModel={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Choose model" })).toHaveTextContent(/^Choose model$/);
  rerender(<WorkbenchTelemetry mode="model" modelAvailable disabled onChooseModel={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Choose model" })).toHaveTextContent(/^Choose model$/);
  rerender(<WorkbenchTelemetry mode="model" modelAvailable={false} disabled={false} onChooseModel={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Choose model" })).not.toBeInTheDocument();
  rerender(<WorkbenchTelemetry mode="model" modelAvailable={false} disabled={false} onChooseModel={vi.fn()} telemetry={{ source: "statusline", fileTruncated: false, model: "gpt-5.5" }} />);
  expect(screen.getByRole("button", { name: "Choose model" })).toBeDisabled();
});

// A native model menu on screen opens the model panel on its own (use-workbench-panels), and the chip
// is the panel's anchor: while the panel is open the chip stays, even where nothing could be chosen
// from Nenu, or the popover lands wherever the page puts it.
it("keeps the chip while the model panel is open, as its anchor, where nothing could be chosen", () => {
  const anchor = createRef<HTMLButtonElement>();
  render(<WorkbenchTelemetry mode="model" modelAvailable={false} disabled={false} onChooseModel={vi.fn()} modelOpen modelTriggerRef={anchor} />);
  const chip = screen.getByRole("button", { name: "Choose model" });
  expect(chip).toHaveAttribute("aria-expanded", "true");
  expect(anchor.current).toBe(chip);
});

it("names the model and effort as quiet labels in one picker button", () => {
  const { rerender } = render(<WorkbenchTelemetry mode="model" modelAvailable disabled={false} onChooseModel={vi.fn()} />);
  rerender(<WorkbenchTelemetry mode="model" modelAvailable disabled={false} onChooseModel={vi.fn()} telemetry={{ source: "statusline", fileTruncated: false, model: "claude-opus-4-1", effort: "high" }} />);
  const chip = screen.getByRole("button", { name: "Choose model" });
  expect(chip).toHaveTextContent(/Opus.*high/);
  expect(within(chip).getByText("high")).toHaveClass("capitalize");
  expect(chip).not.toHaveTextContent("·");
});

it("puts the context ring beside the model in the composer row and keeps one context meter", async () => {
  const telemetry = { source: "statusline" as const, fileTruncated: false, model: "claude-opus-4-1", context: { usedPercent: 40 } };
  const onCompact = vi.fn();
  const { unmount } = render(<WorkbenchTelemetry mode="model" modelAvailable disabled={false} onChooseModel={vi.fn()} onCompact={onCompact} telemetry={telemetry} />);
  const ring = screen.getByRole("button", { name: "Context window 40% used" });
  expect(ring).toHaveTextContent("40%");
  await userEvent.click(ring);
  await userEvent.click(screen.getByRole("button", { name: "Compact context" }));
  expect(onCompact).toHaveBeenCalledOnce();
  unmount();
  render(<WorkbenchTelemetry mode="metrics" modelAvailable disabled={false} onChooseModel={vi.fn()} telemetry={telemetry} />);
  expect(screen.queryByRole("button", { name: /Context window/ })).not.toBeInTheDocument();
  expect(screen.getByText(/^40%/)).toBeVisible();
});
