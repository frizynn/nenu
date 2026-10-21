import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { arrange, DEFAULT_LAYOUT, foldSection, hideSection, moveSection, usePanelLayout } from "./panel-layout";

const DEFAULTS = ["threads", "waiting", "changes", "this"];

afterEach(() => vi.restoreAllMocks());

it("keeps the operator's order and places a section it never saw after the one it follows by default", () => {
  expect(arrange(DEFAULTS, DEFAULT_LAYOUT)).toEqual(DEFAULTS);
  // Stored before Waiting on you existed for this coordinator: it comes back after Threads.
  expect(arrange(DEFAULTS, { ...DEFAULT_LAYOUT, order: ["changes", "threads", "this"] })).toEqual(["changes", "threads", "waiting", "this"]);
  // A section that leads by default stays first; one the panel no longer draws is dropped.
  expect(arrange(DEFAULTS, { ...DEFAULT_LAYOUT, order: ["this", "gone", "changes"] })).toEqual(["threads", "waiting", "this", "changes"]);
});

it("moves a section one place and no further than either end", () => {
  const up = moveSection(DEFAULTS, DEFAULT_LAYOUT, "changes", -1);
  expect(arrange(DEFAULTS, up)).toEqual(["threads", "changes", "waiting", "this"]);
  expect(moveSection(DEFAULTS, DEFAULT_LAYOUT, "threads", -1)).toBe(DEFAULT_LAYOUT);
  expect(moveSection(DEFAULTS, DEFAULT_LAYOUT, "this", 1)).toBe(DEFAULT_LAYOUT);
});

it("folds and hides by id, once each", () => {
  const folded = foldSection(foldSection(DEFAULT_LAYOUT, "changes", true), "changes", true);
  expect(folded.folded).toEqual(["changes"]);
  expect(foldSection(folded, "changes", false).folded).toEqual([]);
  expect(hideSection(DEFAULT_LAYOUT, "this", true).hidden).toEqual(["this"]);
});

it("remembers a layout per kind on this device, and Reset forgets it", () => {
  const { result } = renderHook(() => usePanelLayout("coordinator"));
  act(() => result.current.set(hideSection(result.current.layout, "this", true)));
  expect(result.current.layout.hidden).toEqual(["this"]);
  expect(JSON.parse(localStorage.getItem("nenu.panel-layout:coordinator")!)).toMatchObject({ hidden: ["this"] });
  expect(renderHook(() => usePanelLayout("thread")).result.current.layout).toBe(DEFAULT_LAYOUT);
  act(() => result.current.reset());
  expect(result.current.layout).toBe(DEFAULT_LAYOUT);
  expect(localStorage.getItem("nenu.panel-layout:coordinator")).toBeNull();
});

it("reads a damaged entry as the default, and keeps a layout for the page while the store throws", () => {
  localStorage.setItem("nenu.panel-layout:thread", "{not json");
  expect(renderHook(() => usePanelLayout("thread")).result.current.layout).toBe(DEFAULT_LAYOUT);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
  const { result } = renderHook(() => usePanelLayout("private"));
  act(() => result.current.set(foldSection(result.current.layout, "changes", true)));
  expect(result.current.layout.folded).toEqual(["changes"]);
});

it("keeps a layout for the page when the store reads but will not write (a full quota)", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("QuotaExceededError"); });
  const { result } = renderHook(() => usePanelLayout("full"));
  act(() => result.current.set(foldSection(result.current.layout, "threads", true)));
  expect(result.current.layout.folded).toEqual(["threads"]);
});
