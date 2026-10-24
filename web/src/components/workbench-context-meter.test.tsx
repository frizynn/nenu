import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkbenchContextMeter } from "./workbench-context-meter";

it("bounds the ring when the reported usage exceeds the window", async () => {
  render(<WorkbenchContextMeter usedTokens={250_000} maxTokens={200_000} />);
  await userEvent.click(screen.getByRole("button", { name: "Context window 100% used" }));
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  expect(screen.getByText("100% · 250k / 200k")).toBeInTheDocument();
});


it("compacts only on the explicit native action and closes the context sheet", async () => {
  const compact = vi.fn();
  render(<WorkbenchContextMeter usedTokens={100} maxTokens={200} onCompact={compact} />);
  await userEvent.click(screen.getByRole("button", { name: "Context window 50% used" }));
  expect(compact).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Compact context" }));
  expect(compact).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("says the percentage beside the composer row's ring, and draws nothing when no one reported it", () => {
  const { rerender } = render(<WorkbenchContextMeter usedTokens={26_000} maxTokens={200_000} />);
  expect(screen.getByRole("button", { name: "Context window 13% used" })).toHaveTextContent("13%");
  // A hollow ring with no number said nothing; an unknown context is simply not shown.
  rerender(<WorkbenchContextMeter usedTokens={null} maxTokens={null} />);
  expect(screen.queryByRole("button", { name: /^Context/ })).not.toBeInTheDocument();
});

it("lists the context, then the 5-hour and weekly limits with when each resets", async () => {
  const resetsAt = Date.now() / 1000 + 3600;
  render(<WorkbenchContextMeter reportedPercent={23} usedTokens={229_000} maxTokens={1_000_000}
    rateLimits={[{ name: "secondary", usedPercent: 90.4, windowMinutes: 10080, resetsAt }, { name: "primary", usedPercent: 51, windowMinutes: 300, resetsAt }]} />);
  await userEvent.click(screen.getByRole("button", { name: "Context window 23% used" }));
  const bars = screen.getAllByRole("progressbar");
  expect(bars.map((bar) => bar.getAttribute("aria-label"))).toEqual(["Context window usage", "5-hour limit used", "Weekly limit used"]);
  expect(bars.map((bar) => bar.getAttribute("aria-valuenow"))).toEqual(["23", "51", "90"]);
  expect(screen.getByText("23% · 229k / 1m")).toBeInTheDocument();
  expect(screen.getByText(/^51% · resets /)).toBeInTheDocument();
  // Nearly spent reads as the ring does past 90%, on the share reported rather than the one shown.
  expect(bars[2]!.firstElementChild).toHaveStyle({ backgroundColor: "var(--destructive)" });
});

it("shows only the context for a harness that reports no limits", async () => {
  render(<WorkbenchContextMeter reportedPercent={40} usedTokens={null} maxTokens={null} rateLimits={undefined} />);
  await userEvent.click(screen.getByRole("button", { name: "Context window 40% used" }));
  expect(screen.getAllByRole("progressbar")).toHaveLength(1);
  expect(screen.queryByText(/limit/)).not.toBeInTheDocument();
});
