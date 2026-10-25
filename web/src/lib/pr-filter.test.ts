import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ReviewEntry } from "./home-stats";
import { DEFAULT_PR_FILTER, filterReviews, matchesQuery, usePrFilter, type PrFilter } from "./pr-filter";

const entry = (number: number, extra: Partial<ReviewEntry> = {}): ReviewEntry => ({
  key: `acme/shop#${number}`, title: `PR ${number}`, repo: "shop", owner: "acme", number, draft: false, updatedAt: number, inUse: true, ...extra,
});
const numbers = (rows: readonly ReviewEntry[]) => rows.map((row) => row.number);
const filter = (extra: Partial<PrFilter>): PrFilter => ({ ...DEFAULT_PR_FILTER, ...extra });

describe("pull request filter", () => {
  const entries = [
    entry(1, { review: "approved" }),
    entry(2, { checks: { passed: 1, failed: 1, pending: 0 } }),
    entry(3, { repo: "api", key: "acme/api#3", inUse: false }),
    entry(4, { repo: "api", key: "acme/api#4", inUse: false, draft: true }),
    entry(5, { review: "changes_requested" }),
  ];

  it("lists the PRs of the repos in use unless asked for all", () => {
    expect(numbers(filterReviews(entries, DEFAULT_PR_FILTER).shown)).toEqual([1, 2, 5]);
    expect(numbers(filterReviews(entries, filter({ scope: "all" })).shown)).toEqual([1, 2, 3, 4, 5]);
  });

  it("narrows by state and by repo, any of those chosen", () => {
    expect(numbers(filterReviews(entries, filter({ states: ["attention"] })).shown)).toEqual([2, 5]);
    expect(numbers(filterReviews(entries, filter({ scope: "all", states: ["ready", "draft"] })).shown)).toEqual([1, 4]);
    expect(numbers(filterReviews(entries, filter({ scope: "all", repos: ["acme/api"] })).shown)).toEqual([3, 4]);
  });

  it("narrows nothing when every repo in the scope is chosen", () => {
    expect(filterReviews(entries, filter({ repos: ["acme/shop"] })).repos).toEqual([]);
    expect(filterReviews(entries, filter({ scope: "all", repos: ["acme/shop"] })).repos).toEqual(["acme/shop"]);
  });

  it("leaves out a chosen repo with no PR in the scope, rather than emptying the list", () => {
    const narrowed = filterReviews(entries, filter({ repos: ["acme/api"] }));
    expect(narrowed.repos).toEqual([]);
    expect(numbers(narrowed.shown)).toEqual([1, 2, 5]);
  });

  it("says what each step kept, the search last", () => {
    const steps = filterReviews(entries, filter({ states: ["attention", "ready"] }), "#5");
    expect([steps.scoped, steps.kept, steps.shown].map(numbers)).toEqual([[1, 2, 5], [1, 2, 5], [5]]);
  });

  it("finds a PR by every word of its title, accents and case aside, or by its number", () => {
    const pr = entry(2319, { title: "fix(facturas): no facturar de nuevo una venta" });
    expect(["FACTUR venta", "factúrar", "#2319", "231", " "].map((query) => matchesQuery(pr, query))).toEqual([true, true, true, true, true]);
    expect(["facturas compra", "#2320", "23 19"].map((query) => matchesQuery(pr, query))).toEqual([false, false, false]);
    // The first key of "#2319" narrows nothing yet.
    expect(matchesQuery(pr, "#")).toBe(true);
  });

  it("keeps the choice on this device, and forgets what it cannot read", () => {
    const { result } = renderHook(() => usePrFilter());
    expect(result.current.filter).toEqual(DEFAULT_PR_FILTER);
    act(() => result.current.set(filter({ scope: "all", states: ["draft"], repos: ["acme/api"] })));
    expect(JSON.parse(localStorage.getItem("nenu:pr-filter:v1")!)).toEqual({ scope: "all", repos: ["acme/api"], states: ["draft"] });
    act(() => result.current.set(DEFAULT_PR_FILTER));
    expect(localStorage.getItem("nenu:pr-filter:v1")).toBeNull();
    localStorage.setItem("nenu:pr-filter:v1", JSON.stringify({ scope: "everything", repos: [1, "acme/shop"], states: ["draft", "merged"] }));
    const { result: again } = renderHook(() => usePrFilter());
    expect(again.current.filter).toEqual({ scope: "inUse", repos: ["acme/shop"], states: ["draft"] });
  });
});
