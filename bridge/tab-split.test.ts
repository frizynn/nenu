import { describe, expect, test } from "bun:test";

import { splitTarget } from "./tab-split.ts";

const pane = (pane_id: string, width: number, height: number) => ({ pane_id, rect: { width, height } });

describe("splitTarget", () => {
  test("splits the largest pane, to the right while it is wide", () => {
    expect(splitTarget([pane("a", 120, 40)])).toEqual({ paneId: "a", direction: "right" });
    expect(splitTarget([pane("a", 30, 40), pane("b", 90, 40)])).toEqual({ paneId: "b", direction: "right" });
  });

  test("a tall or narrow pane splits down", () => {
    expect(splitTarget([pane("a", 60, 40), pane("b", 60, 40)])).toEqual({ paneId: "a", direction: "down" });
    expect(splitTarget([pane("a", 79, 40)])).toEqual({ paneId: "a", direction: "down" });
  });

  test("a tab with no panes has nowhere to split", () => {
    expect(splitTarget([])).toBeNull();
  });
});
