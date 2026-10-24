import { act, renderHook } from "@testing-library/react";

import { HERDR_ORDER, orderWorkspaces, useWorkspaceOrder, type WorkspaceOrder } from "./workspace-order";

const herd = [{ id: "w1", name: "Nenu" }, { id: "w2", name: "awam" }, { id: "w3", name: "Terminal 10" }, { id: "w4", name: "Terminal 9" }];
const ids = (order: WorkspaceOrder, items = herd) => orderWorkspaces(items, (w) => w.id, (w) => w.name, order).map((w) => w.id);

describe("orderWorkspaces", () => {
  it("keeps Herdr's order by default", () => {
    expect(ids(HERDR_ORDER)).toEqual(["w1", "w2", "w3", "w4"]);
  });

  it("sorts by name as a person reads it: any case, numbers by value", () => {
    expect(ids({ mode: "name", custom: [] })).toEqual(["w2", "w1", "w4", "w3"]);
  });

  it("puts a custom order first, a workspace opened since at its end in Herdr's order, and drops a closed one", () => {
    const custom: WorkspaceOrder = { mode: "custom", custom: ["w3", "gone", "w1"] };
    expect(ids(custom)).toEqual(["w3", "w1", "w2", "w4"]);
  });

  it("keeps the custom order aside while another mode shows", () => {
    expect(ids({ mode: "herdr", custom: ["w4", "w3"] })).toEqual(["w1", "w2", "w3", "w4"]);
  });
});

describe("useWorkspaceOrder", () => {
  beforeEach(() => localStorage.clear());

  it("remembers the choice on this device and tells every reader", () => {
    const first = renderHook(() => useWorkspaceOrder());
    const second = renderHook(() => useWorkspaceOrder());
    expect(first.result.current.order).toEqual(HERDR_ORDER);
    act(() => first.result.current.set({ mode: "custom", custom: ["w2", "w1"] }));
    expect(second.result.current.order).toEqual({ mode: "custom", custom: ["w2", "w1"] });
    expect(JSON.parse(localStorage.getItem("nenu:workspace-order:v1")!)).toEqual({ mode: "custom", custom: ["w2", "w1"] });
    act(() => first.result.current.set(HERDR_ORDER));
    expect(localStorage.getItem("nenu:workspace-order:v1")).toBeNull();
  });

  it("reads a stored order it cannot make sense of as Herdr's", () => {
    localStorage.setItem("nenu:workspace-order:v1", JSON.stringify({ mode: "shuffle", custom: [1] }));
    expect(renderHook(() => useWorkspaceOrder()).result.current.order).toEqual(HERDR_ORDER);
  });
});
