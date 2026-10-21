import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { declarations } from "@/test/css-rules";

// The composer's layout contracts that fail silently: jsdom lays nothing out, so these read the
// declared values and the bench measures the rendered result (redesign-shots/labels-type-reach).

const css = readFileSync(resolve(import.meta.dirname, "composer.css"), "utf8");

describe("the composer", () => {
  // Below a desk the box bleeds 8px into the page gutter, whatever the gutter is, as the strips' pills
  // and the queue strip do: its + and Send sit on the column the prose starts on, and the draft keeps
  // its width. Tried at the full 16px gutter on a phone: the draft lost 16px, and a four-line draft
  // wrapped to five under the keyboard, taking 24px of thread. A fixed 8px from the edge left the box
  // 24px outside the 32px column from 640px (744px on the bench).
  it("bleeds 8px into the page gutter below a desk so the draft keeps its width, and sits on the gutter on a desk", () => {
    expect(declarations(css, ".workbench-composer").width).toBe("calc(100% - 2 * var(--page-gutter) + 16px)");
    expect(declarations(css, ".workbench-composer", ["@media (min-width: 1024px)"]).width).toBe("calc(100% - 2 * var(--page-gutter))");
  });

  // Measured on the bench: the model chip's 44px reach rose 4px into the box and took the bottom of
  // the +'s, which then reached 40px. Rising 4px still took 2px of it on a coarse tablet, where the +
  // sits 2px lower in its box (44x42 at 820px). Below the meta row there is only the home indicator's inset.
  it("grows the meta row's touch targets down, away from the + above them", () => {
    expect(declarations(css, ".composer-meta .hit-area::before", ["@media (pointer: coarse)"])).toMatchObject({ top: "-2px", transform: "translateX(-50%)" });
  });

  // A picture pasted with the phone's keyboard up laid the draft out beside the thumbnails at no width:
  // in a wrapping box the + (folded to nothing while typing) and the draft (no basis) fit on their line,
  // and the words ran off the box's right edge (bench: run.ts paste-image). The files and the row of +,
  // draft and Send are stacked, never wrapped.
  it("stacks the files over the row of +, draft and Send instead of wrapping them", () => {
    expect(declarations(css, ".composer-box")).toMatchObject({ "flex-direction": "column" });
    expect(declarations(css, ".composer-box")["flex-wrap"]).toBeUndefined();
    expect(declarations(css, ".composer-row")).toMatchObject({ display: "flex" });
  });
});
