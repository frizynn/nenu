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

describe("Home's segmented lists", () => {
  // A phone drew the track 52px tall to give each segment a finger; the reach does that now.
  it("stay 36px to the eye on a phone and still reach 44px", () => {
    const px = (value: string | undefined) => Number(/^(-?[\d.]+)px/.exec(value ?? "")?.[1] ?? Number.NaN);
    const track = declarations(css, ".project-segmented", [LAYER]);
    const coarse = declarations(css, ".project-segmented", [LAYER, "@media (pointer: coarse)"]);
    const reach = declarations(css, ".project-segment::after", [LAYER, "@media (pointer: coarse)"]);
    expect(coarse.height).toBeUndefined();
    expect(px(track.height)).toBe(36);
    expect(px(track.height) - 2 * px(track.padding) - 2 * px(reach.inset)).toBe(44);
  });
});
