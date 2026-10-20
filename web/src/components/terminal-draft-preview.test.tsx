import { render, screen } from "@testing-library/react";
import { vi } from "vitest";

import { TerminalDraftPreview } from "./terminal-draft-preview";

// Take over is a 24 px word in the strip; the shared .hit-area gives a touch screen its 44 px reach
// (measured 69 by 24 with no reach on the bench, redesign-shots/polish-pages).
it("lets a finger reach Take over at 44 px", () => {
  render(<TerminalDraftPreview text="git commit -m 'wip'" onTakeOver={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Take over" })).toHaveClass("hit-area");
});
