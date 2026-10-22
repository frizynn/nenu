import { describe, expect, test } from "bun:test";

import { coerceMarkPicks } from "./coordinator-marks.ts";

describe("coerceMarkPicks", () => {
  test("keeps well-formed slugs, node ids and names, and drops the rest", () => {
    expect(coerceMarkPicks({
      acme: { "t-0003": { icon: "leaf", tone: "teal" }, "t-0004": { tone: "blue", extra: 1 }, root: { icon: "leaf" }, "t-0005": { icon: "<svg>" } },
      "Bad Slug": { "t-0001": { icon: "leaf" } },
      empty: { "t-0001": {} },
    })).toEqual({ acme: { "t-0003": { icon: "leaf", tone: "teal" }, "t-0004": { tone: "blue" } } });
  });

  test("a missing or malformed file reads as no picks", () => {
    for (const raw of [undefined, null, [], "x", { acme: [] }]) expect(coerceMarkPicks(raw)).toEqual({});
  });
});
