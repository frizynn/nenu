import { render, waitFor } from "@testing-library/react";
import { onTestFinished, vi } from "vitest";

import { App } from "./App";

// One default in the facade: every stroked icon draws at 1.5, and only an icon that means to
// differ (Send's arrow) names its own weight. On a desk, where the sidebar's navigation is mounted.
it("draws the navigation's icons at stroke 1.5", async () => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(min-width: 1024px)", media: query, addEventListener: () => {}, removeEventListener: () => {} }));
  onTestFinished(() => { vi.unstubAllGlobals(); });
  const { container } = render(<App />);
  await waitFor(() => expect(container.querySelector(".workbench-navigation svg.icon")).not.toBeNull());
  const icons = [...container.querySelectorAll(".workbench-navigation svg.icon, .bottom-tab-bar svg.icon")];
  expect(new Set(icons.map((icon) => icon.getAttribute("stroke-width")))).toEqual(new Set(["1.5"]));
});
