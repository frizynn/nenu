import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { WorkbenchTelemetry } from "./workbench-telemetry";
import type { WorkbenchPanel } from "./workbench-telemetry";

it("leaves unreported context and limits unknown", () => {
  render(<WorkbenchTelemetry modelAvailable={false} disabled={false} onChooseModel={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Choose model" })).toBeDisabled();
  fireEvent.click(screen.getByText("Usage"));
  expect(screen.getByText("Usage is not available yet.")).toBeVisible();
  expect(screen.queryByText("Tokens not reported")).not.toBeInTheDocument();
  expect(screen.queryByText(/0%/)).not.toBeInTheDocument();
});

it("distinguishes last-message totals from context and flags stale or clipped metrics", () => {
  render(<WorkbenchTelemetry modelAvailable disabled={false} stale onChooseModel={vi.fn()}
    telemetry={{ source: "journal", model: "reported-model", tokens: { scope: "last-message", input: 100, output: 20, total: 120 }, context: { usedTokens: 100 }, fileTruncated: true }} />);
  fireEvent.click(screen.getByText("Usage · stale"));
  expect(screen.getByText("Last message")).toBeVisible();
  expect(screen.getByText(/values may be out of date/)).toBeVisible();
  expect(screen.getByText(/Only the tail/)).toBeVisible();
  expect(screen.queryByText("Context window")).not.toBeInTheDocument();
  expect(screen.queryByText(/Account limits not reported/)).not.toBeInTheDocument();
});

it("keeps a disabled model control from initiating a terminal action", () => {
  const choose = vi.fn();
  render(<WorkbenchTelemetry modelAvailable disabled onChooseModel={choose} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose model" }));
  expect(choose).not.toHaveBeenCalled();
});

it("keeps Usage and Context exclusive and closes them when typing resumes", async () => {
  render(<><WorkbenchTelemetry modelAvailable disabled={false} onChooseModel={vi.fn()} /><textarea aria-label="Draft" /></>);
  await userEvent.click(screen.getByRole("button", { name: "Usage" }));
  expect(screen.getByRole("dialog", { name: "Last reported usage" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Context usage: Unknown" }));
  expect(screen.queryByRole("dialog", { name: "Last reported usage" })).not.toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: "Context window" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("textbox"));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("textbox")).toHaveFocus();
});

it("lets the parent own model toggling and one active inspection panel", async () => {
  const choose = vi.fn();
  const panelChange = vi.fn();
  function Controlled() {
    const [panel, setPanel] = useState<WorkbenchPanel>(null);
    return <>
      <WorkbenchTelemetry panel={panel} modelOpen={panel === "model"} modelAvailable disabled={panel === "model"}
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
  await userEvent.click(screen.getByRole("button", { name: "Usage" }));
  await userEvent.click(screen.getByRole("button", { name: "Choose model" }));
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(screen.getByRole("dialog", { name: "Model picker" })).toBeInTheDocument();
});

it.each(["claude", "codex"])("shows the %s brand before history or model metadata arrives", (agent) => {
  render(<WorkbenchTelemetry agent={agent} modelAvailable disabled={false} onChooseModel={vi.fn()} />);
  expect(screen.getByRole("img", { name: `${agent} logo` })).toBeVisible();
});

it("shows the native context percentage and both quota windows", async () => {
  render(<WorkbenchTelemetry agent="claude" modelAvailable disabled={false} onChooseModel={vi.fn()} telemetry={{ source: "statusline", fileTruncated: false, context: { usedTokens: 397000, windowTokens: 1000000, usedPercent: 40 }, rateLimits: [{ name: "primary", windowMinutes: 300, usedPercent: 8 }, { name: "secondary", windowMinutes: 10080, usedPercent: 19 }] }} />);
  expect(screen.getByRole("button", { name: "Context window 40% used" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Usage" }));
  expect(screen.getByText("5h window")).toBeVisible();
  expect(screen.getByText("Weekly")).toBeVisible();
  expect(screen.getByText("8% used")).toBeVisible();
  expect(screen.getByText("19% used")).toBeVisible();
});
