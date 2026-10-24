import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { declarations } from "@/test/css-rules";

// The chat frame's contracts that fail silently: jsdom lays nothing out and matches no :hover or
// :focus-visible, so these read the declared rules and the bench measures the rendered result.

const css = readFileSync(resolve(import.meta.dirname, "project.css"), "utf8");
const LAYER = "@layer components";

describe("the session panel's tabs", () => {
  // The panel opens from 1280px, which a touch tablet held sideways has; its tabs drew 32px tall there.
  it("reach 44px on a coarse pointer, without growing the row they sit in", () => {
    const px = (value: string | undefined) => Number(/^(-?[\d.]+)px/.exec(value ?? "")?.[1] ?? Number.NaN);
    const tab = declarations(css, ".panel-tab", [LAYER]);
    const reach = declarations(css, ".panel-tab::after", [LAYER, "@media (pointer: coarse)"]);
    expect(px(tab.height)).toBeLessThanOrEqual(36);
    expect(px(tab.height) - 2 * px(reach.inset)).toBe(44);
  });
});
