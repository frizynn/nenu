import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { declarations } from "@/test/css-rules";

// The navigation's rows, where a contract fails silently: jsdom compiles no stylesheet, so these read
// the declared values and the bench looks at the result (redesign-shots/sheet-system).

const css = readFileSync(resolve(import.meta.dirname, "nav.css"), "utf8");
const LAYER = "@layer components";

describe("a chat's row that can't be opened", () => {
  // An unreachable session in the Sessions sheet: its name went grey while "Unreachable" under it
  // kept the muted ink, so the state outshone the name.
  it("draws its name and the line under it in the disabled ink, the line never louder than the name", () => {
    expect(declarations(css, "button.nav-pane:disabled", [LAYER]).color).toBe("var(--disabled-foreground)");
    expect(declarations(css, "button.nav-pane:disabled .nav-pane-detail", [LAYER]).color).toBe("inherit");
  });

  it("takes no hover fill, since there is nothing to open", () => {
    expect(declarations(css, "button.nav-pane:disabled:hover", [LAYER, "@media (hover: hover)"]).background).toBe("none");
  });
});

describe("a row More folds", () => {
  // The fold is a grid, and its clipped box is no scroller, so it kept a grid item's automatic minimum:
  // a chat's whole name. One long name widened every row and label past the bar, and a sideways swipe
  // scrolled the list until the projects read "M" (21/10). bun scripts/e2e/sidebar.ts measures the bar.
  it("lets its box narrow to the bar, so a long name ends in an ellipsis instead of widening the list", () => {
    const inner = declarations(css, ".nav-reveal-inner", [LAYER]);
    expect(inner["min-width"]).toBe("0");
    expect(inner.overflow).toBe("clip");
  });
});
