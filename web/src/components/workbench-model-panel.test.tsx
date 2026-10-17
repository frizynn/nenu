import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { parseAnsi } from "@/lib/ansi";
import { splitLines, type MenuBlock } from "@/lib/blocks";
import { claudeBuildBlocks } from "@/lib/harness/claude";
import { WorkbenchModelPanel } from "./workbench-model-panel";

const rows = [
  { name: "Default (recommended)", description: "Use the agent's configured default" },
  { name: "Opus", description: "" },
  { name: "Sonnet", description: "" },
];

function panel(props: Partial<Parameters<typeof WorkbenchModelPanel>[0]> = {}) {
  const anchor = createRef<HTMLButtonElement>();
  const handlers = { onDismiss: vi.fn(), onApply: vi.fn().mockResolvedValue(undefined), onApplyError: vi.fn(),
    onLoad: vi.fn().mockResolvedValue(undefined), onMenuAction: vi.fn() };
  render(<><button ref={anchor}>Choose model</button>
    <WorkbenchModelPanel scope="s" open anchorRef={anchor} agent="claude" text="" modelPresent={false}
      catalog={{ rows, loading: false }} disabled={false} closing={false} {...handlers} {...props} /></>);
  return handlers;
}

it("applies with one tap, marks the model that runs with its version, and keeps a failure in the sheet", async () => {
  const handlers = panel({ reportedModel: "claude-opus-5-5" });
  const opus = screen.getByRole("menuitemradio", { name: "Opus" });
  expect(opus).toHaveAttribute("aria-checked", "true");
  expect(opus).toHaveTextContent("Opus 5.5");
  handlers.onApply.mockRejectedValueOnce(new Error("The picker changed. Review your selection and try again."));
  await userEvent.click(screen.getByRole("menuitemradio", { name: "Sonnet" }));
  expect(handlers.onApply).toHaveBeenCalledExactlyOnceWith("Sonnet");
  expect(handlers.onApplyError).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("alert")).toHaveTextContent("The picker changed");
  expect(screen.getByRole("dialog", { name: "Model picker" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("menuitemradio", { name: "Sonnet" }));
  expect(handlers.onApply).toHaveBeenCalledTimes(2);
  expect(handlers.onDismiss).not.toHaveBeenCalled();
});

it("shows the reported effort, and opening it asks the agent's picker for its arrows", async () => {
  const handlers = panel({ reportedEffort: "medium" });
  await userEvent.click(screen.getByRole("button", { name: /Effort\s*medium/i }));
  expect(handlers.onLoad).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "More model settings" })).toBeInTheDocument();
});

it("with the agent's picker open, steps its effort through the arrows the picker named", async () => {
  const screenLines = splitLines(parseAnsi(readFileSync(join(import.meta.dirname, "..", "fixtures", "panes", "claude--menu-model-picker.txt"), "utf8")));
  const menu = claudeBuildBlocks(screenLines).find((block): block is MenuBlock => block.kind === "menu")!;
  const handlers = panel({ menu, modelPresent: true, reportedEffort: "medium" });
  // The picker's own current row is the one marked.
  expect(screen.getByRole("menuitemradio", { name: "Default (recommended)" })).toHaveAttribute("aria-checked", "true");
  await userEvent.click(screen.getByRole("button", { name: /^Right — adjust/ }));
  await waitFor(() => expect(handlers.onMenuAction).toHaveBeenCalledWith({ keys: ["Right"], nav: true }, menu.menu));
  expect(handlers.onLoad).not.toHaveBeenCalled();
});
