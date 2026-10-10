import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { liveStreamUrl, resetWatchedPanes, useLiveEvents, useWatchPane } from "@/hooks/use-live-events";
import { resetLiveEvents, setMirrorShown } from "@/lib/live-events";

afterEach(() => {
  resetLiveEvents();
  resetWatchedPanes();
  vi.unstubAllGlobals();
});

it("names every watched pane on the stream URL", () => {
  expect(liveStreamUrl(undefined, undefined)).toBe("/api/events");
  expect(liveStreamUrl(undefined, "w1:p1")).toBe("/api/events?watch=w1%3Ap1");
  expect(liveStreamUrl(undefined, ["a:1", "b:2"])).toBe("/api/events?watch=a%3A1&watch=b%3A2");
});

it("adds a docked pane to the watch while it is shown and drops it after", () => {
  const urls: string[] = [];
  vi.stubGlobal("EventSource", class {
    onopen = null;
    onmessage = null;
    onerror = null;
    close = vi.fn();
    constructor(url: string) { urls.push(url); }
  });
  let docked: string | undefined = "w2:p9";
  function Probe(): ReactNode {
    useLiveEvents(undefined);
    useWatchPane(docked);
    return null;
  }
  const router = createMemoryRouter([{ path: "/pane/:paneId", element: <Probe /> }], { initialEntries: ["/pane/w1%3Ap1"] });
  const { rerender } = renderHook(() => null, { wrapper: () => <RouterProvider router={router} /> });
  expect(urls.at(-1)).toBe("/api/events?watch=w1%3Ap1&watch=w2%3Ap9");
  act(() => setMirrorShown(false));
  expect(urls.at(-1)).toBe("/api/events?watch=w2%3Ap9");
  docked = undefined;
  act(() => { void router.navigate("/pane/w1%3Ap1?x=1"); });
  rerender();
  expect(urls.at(-1)).toBe("/api/events");
});
