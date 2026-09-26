import { act, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider, useLoaderData } from "react-router";

import { ConnectionBanner } from "@/components/connection-banner";
import { __resetConnectionHealth, markLive } from "@/lib/connection-health";
import { PANE_ROUTE_ID, ROOT_ROUTE_ID, type HomeData, type PaneData } from "@/lib/loaders";
import type { AgentView } from "@/lib/types";
import { DetailRoute } from "./detail";

const shell: AgentView = {
  paneId: "slow-link-shell", workspaceId: "w1", workspaceLabel: "test", workspaceNumber: 1,
  tabId: "w1:t1", agent: "shell", status: "unknown", cwd: "/tmp", focused: false, kind: "shell",
};
const home: HomeData = {
  bridge: "connected", agents: [], shellPanes: [shell], workspaces: [], tabs: [], sessions: [],
  device: undefined, session: undefined, snoozedUntil: null, update: undefined,
  error: false, authError: false,
};
const pane: PaneData = {
  paneId: shell.paneId, session: undefined, text: "$ ", truncated: false, requestedLines: 60,
  revision: 1, error: false, authError: false,
};
function Layout() {
  const data = useLoaderData<HomeData>();
  return <><ConnectionBanner bridge={data.bridge} error={data.error} authError={data.authError} /><Outlet /></>;
}

it("keeps a slow successful poll usable, but reports a failed poll and recovers with the draft intact", async () => {
  __resetConnectionHealth();
  Element.prototype.scrollTo ??= () => {};
  let response = home;
  let pending: Promise<HomeData> | undefined;
  let resolve: ((value: HomeData) => void) | undefined;
  const router = createMemoryRouter([{
    id: ROOT_ROUTE_ID, path: "/", element: <Layout />, loader: async () => {
      const data = await (pending ?? response);
      if (!data.error) markLive();
      return data;
    }, children: [{ id: PANE_ROUTE_ID, path: "pane/:paneId", loader: () => pane, element: <DetailRoute /> }],
  }], { initialEntries: [`/pane/${shell.paneId}`] });
  const view = render(<RouterProvider router={router} />);
  try {
    const box = await screen.findByRole("textbox");
    fireEvent.change(box, { target: { value: "unsent draft" } });
    expect(screen.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    vi.useFakeTimers();
    pending = new Promise<HomeData>((done) => { resolve = done; });
    act(() => { void router.revalidate(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(4_200); });
    expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await act(async () => { resolve?.(home); });
    pending = undefined;
    expect(screen.queryByText("Connected", { exact: true })).not.toBeInTheDocument();

    response = { ...home, error: true };
    await act(async () => { await router.revalidate(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(4_200); });
    expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    response = home;
    await act(async () => { await router.revalidate(); });
    expect(screen.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    expect(box).toHaveValue("unsent draft");
  } finally {
    resolve?.(home);
    view.unmount();
    router.dispose();
    vi.useRealTimers();
  }
}, 10_000);
