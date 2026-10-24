import { cn, keepItems } from "./utils";

// The type scale (index.css) names its steps text-body, text-footnote and so on. tailwind-merge
// reads an unknown text-* as a colour, so without being told it dropped the size beside any text
// colour and kept two sizes side by side.
describe("cn", () => {
  it("keeps a type-scale size next to a text colour", () => {
    expect(cn("text-body", "text-muted-foreground")).toBe("text-body text-muted-foreground");
    expect(cn("text-footnote text-subtle-foreground")).toBe("text-footnote text-subtle-foreground");
  });

  it("lets a type-scale size replace another size, and the other way round", () => {
    expect(cn("text-sm", "text-body")).toBe("text-body");
    expect(cn("text-large-title", "text-xs")).toBe("text-xs");
    expect(cn("text-caption", "text-code")).toBe("text-code");
  });

  it("still lets a later colour replace an earlier one", () => {
    expect(cn("text-body text-foreground", "text-muted-foreground")).toBe("text-body text-muted-foreground");
  });
});

describe("keepItems", () => {
  it("keeps every item that says the same, and the whole list when all do", () => {
    const prev = [{ id: 1, s: "a" }, { id: 2, s: "b" }];
    const same = keepItems(prev, [{ id: 1, s: "a" }, { id: 2, s: "b" }]);
    expect(same).toBe(prev);
    const next = keepItems(prev, [{ id: 1, s: "a" }, { id: 2, s: "c" }]);
    expect(next).not.toBe(prev);
    expect(next[0]).toBe(prev[0]);
    expect(next[1]).toEqual({ id: 2, s: "c" });
  });

  it("hands back a new list when one grew or shrank", () => {
    const prev = [{ id: 1 }];
    expect(keepItems(prev, [{ id: 1 }, { id: 2 }])[0]).toBe(prev[0]);
    expect(keepItems(prev, [])).toEqual([]);
    expect(keepItems(undefined, prev)).toBe(prev);
  });
});
