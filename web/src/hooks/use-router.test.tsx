import { act, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useRevalidator } from "react-router";

import { useRevalidate, useRouterState } from "@/hooks/use-router";

// A revalidation moves the router through loading and back to idle. React Router's useRevalidator
// redraws its caller on both; these hooks must not, or a chat that only calls revalidate() redraws
// twice per live event.
describe("router hooks", () => {
  function setup() {
    const renders = { quiet: 0, selected: 0, whole: 0 };
    let revalidate: () => Promise<void> = async () => {};
    function Quiet() {
      renders.quiet++;
      revalidate = useRevalidate();
      return null;
    }
    function Selected() {
      renders.selected++;
      const loading = useRouterState((state) => state.navigation.state === "loading");
      return <p>{loading ? "loading" : "idle"}</p>;
    }
    function Whole() {
      renders.whole++;
      useRevalidator();
      return null;
    }
    // A load waits on `gate` when one is set, so a test can hold the router in "loading".
    const held: { gate?: Promise<void> } = {};
    const router = createMemoryRouter([{ path: "/", loader: async () => { await held.gate; return null; }, element: <><Quiet /><Selected /><Whole /></> }]);
    render(<RouterProvider router={router} />);
    return { renders, revalidate: () => revalidate(), router, held };
  }

  it("calls revalidate without redrawing on its state", async () => {
    const { renders, revalidate } = setup();
    await screen.findByText("idle");
    const before = { ...renders };
    await act(() => revalidate());
    expect(renders.whole).toBeGreaterThan(before.whole);
    expect(renders.quiet).toBe(before.quiet);
    expect(renders.selected).toBe(before.selected);
  });

  it("redraws a selection when what it selects changes", async () => {
    const { router, held } = setup();
    await screen.findByText("idle");
    let finish: () => void = () => {};
    held.gate = new Promise<void>((resolve) => { finish = resolve; });
    void act(() => router.navigate("/?again"));
    await screen.findByText("loading");
    await act(async () => finish());
    await screen.findByText("idle");
  });
});
