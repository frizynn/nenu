import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cssRules, declarations } from "@/test/css-rules";

// The tab and pane strips' contracts that fail silently: jsdom lays nothing out, so these read the
// declared values and the bench measures the rendered result (redesign-shots/strips).

const css = readFileSync(resolve(import.meta.dirname, "strips.css"), "utf8");
const LAYER = "@layer components";
const COARSE = "@media (pointer: coarse)";
const px = (value: string | undefined) => Number(/^(-?[\d.]+)px$/.exec(value ?? "")?.[1] ?? Number.NaN);
const band = (name: "tabs" | "panes", at: string[] = [LAYER]) =>
  declarations(css, `.strip[data-workbench-navigation-band="${name}"]`, at);
const chipReach = () => cssRules(css).find((rule) => rule.selectors.includes(".strip-chip::after"))?.decls ?? {};

describe("strip chips", () => {
  it("mark the selected tab or pane with the neutral selection fill, never the accent", () => {
    expect(declarations(css, '.strip-chip[aria-current="true"]', [LAYER]).background).toBe("var(--workbench-row-selected)");
    expect(css).not.toMatch(/--primary/);
  });

  it("never grow past 60% of a phone or 240px on a desk, so one long name can't hide its siblings", () => {
    expect(declarations(css, ".strip-chip", [LAYER])["max-width"]).toBe("min(60vw, 240px)");
  });

  // --subtle-foreground on the open chip's fill reads 4.43:1 in light; text at 13px needs 4.5.
  it("draw the open chip's sibling number in the muted ink, which holds 4.5:1 on its fill", () => {
    expect(declarations(css, '.strip-chip[aria-current="true"] .strip-chip-tag', [LAYER]).color).toBe("var(--muted-foreground)");
  });

  // A short name with no dot ("ui", a shell "x") left the chip, and its touch target, 37px wide.
  it("never narrow below 44px, with a short name centred", () => {
    const chip = declarations(css, ".strip-chip", [LAYER]);
    expect(chip["min-width"]).toBe("44px");
    expect(chip["justify-content"]).toBe("center");
  });

  // At 24px the first letter of "She…", cut 21px from the edge, kept about 85% of its ink and the
  // name read as stopped mid-word (combined QA 19); at 40px it keeps about half
  // (redesign-shots/sheet-system/strip-fade.ts). The open chip is revealed clear of this width.
  it("fade the edge a strip can still scroll toward over about five letters of a name", () => {
    expect(declarations(css, '.strip-scroller[data-overflow~="start"]', [LAYER])["--fade-start"]).toBe("40px");
    expect(declarations(css, '.strip-scroller[data-overflow~="end"]', [LAYER])["--fade-end"]).toBe("40px");
  });
});

describe("strips on a touch screen", () => {
  it("take 32px each, so both bands together leave the thread more room than the two old ones did", () => {
    expect(declarations(css, ".strip", [LAYER, COARSE]).height).toBe("32px");
  });

  // What these declarations promise is a 44px reach where nothing covers it: a pane pill, and a tab
  // with no pane row under it. With the pane row showing, that row covers a tab's reach and the tab
  // keeps about 30px (the bench measures the real hit boxes with elementFromPoint).
  it("hang a chip's touch target below its band, to 44px from the pill's top edge", () => {
    const chip = px(declarations(css, ".strip-chip", [LAYER]).height);
    // Two open chips stacked keep a gap between them.
    expect(chip).toBeLessThan(32);
    expect(chip + px(declarations(css, ".strip", [LAYER, COARSE])["--reach"])).toBe(44);
    // The pseudo-element sits in the chip's padding box, so the 1px border is added back.
    expect(chipReach()).toMatchObject({ inset: "-1px", bottom: "calc(-1px - var(--reach))" });
  });

  // 0.65.0 set pointer-events: none on the scroller so taps under a row's reach band reached the
  // thread. A swipe that started between two chips then hit the row, not the scroller, and scrolled
  // nothing (bench, Chromium); WebKit on iOS leaves a scroller with pointer-events: none out of its
  // touch hit test altogether (inferred), which is "I can't scroll the tabs with my finger".
  it("let a finger scroll a strip from anywhere on it, a chip or the gap between two", () => {
    expect(declarations(css, ".strip-scroller", [LAYER, COARSE])["pointer-events"]).toBeUndefined();
    expect(declarations(css, ".strip-scroller", [LAYER])["pointer-events"]).toBeUndefined();
  });

  it("let the pane row cover a tab's reach, and never reach up into the header", () => {
    // Reaching up would gain nothing anyway: the header paints over its own bottom edge.
    expect(chipReach().top).toBeUndefined();
    // The tab row's reach goes under the pane row, never over its pills.
    expect(Number(band("panes")["z-index"])).toBeGreaterThan(Number(band("tabs")["z-index"]));
  });
});

describe("the project's panel toggle", () => {
  // 30px to the eye. Its ::after hangs from inside the 1px border, so -7px each way reached 42px.
  it("reaches 44px tall for a finger without growing the header", () => {
    const toggle = declarations(css, ".project-toggle", [LAYER]);
    const block = declarations(css, ".project-toggle::after", [LAYER]).inset?.split(" ")[0];
    const border = px(toggle.border?.split(" ")[0]);
    expect(px(toggle.height) - 2 * border - 2 * px(block)).toBeGreaterThanOrEqual(44);
  });
});
