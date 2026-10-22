import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { coerceMarkPicks, CoordinatorMarks } from "./coordinator-marks.ts";

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

describe("CoordinatorMarks", () => {
  test("two picks at once both land, in memory and on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nenu-marks-"));
    try {
      const file = join(dir, "marks.json");
      const marks = new CoordinatorMarks(file);
      for (let round = 0; round < 20; round++) {
        await Promise.all([marks.set("acme", "t-0001", { icon: "leaf" }), marks.set("acme", "t-0002", { tone: "pink" }), marks.set("other", "t-0001", { icon: "moon" })]);
      }
      const want = { acme: { "t-0001": { icon: "leaf" }, "t-0002": { tone: "pink" } }, other: { "t-0001": { icon: "moon" } } };
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(want);
      expect(new CoordinatorMarks(file).of("acme")).toEqual(want.acme);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
