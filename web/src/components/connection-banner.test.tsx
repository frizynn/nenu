import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { __resetConnectionHealth, markLive, CONNECTION_LOST_MS } from "@/lib/connection-health";
import { ConnectionBanner, RECOVERY_QUIET_MS } from "./connection-banner";

type Props = Parameters<typeof ConnectionBanner>[0];
function renderBanner(initial: Partial<Props> = {}) {
  let update: (props: Partial<Props>) => void = () => {};
  function Harness() {
    const [props, setProps] = useState<Props>({ bridge: "connected", error: false, authError: false, ...initial });
    update = (next) => setProps((old) => ({ ...old, ...next }));
    return <ConnectionBanner {...props} />;
  }
  const loader = vi.fn(() => null);
  const router = createMemoryRouter([{ path: "/", loader, element: <Harness /> }], {
    hydrationData: { loaderData: { "0": null } },
  });
  const view = render(<RouterProvider router={router} />);
  return { update, loader, close: () => { view.unmount(); router.dispose(); } };
}
beforeEach(() => { vi.useFakeTimers(); __resetConnectionHealth(); });
afterEach(() => vi.useRealTimers());

it("keeps repeated brief signal losses quiet", () => {
  const h = renderBanner();
  for (let cycle = 0; cycle < 3; cycle++) {
    act(() => h.update({ error: true }));
    act(() => vi.advanceTimersByTime(6_000));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    act(() => { markLive(); h.update({ error: false }); });
    expect(screen.queryByText("Connected", { exact: true })).not.toBeInTheDocument();
  }
  h.close();
});

it("shows one notice for a sustained outage, with Retry and without Reload", () => {
  const h = renderBanner({ error: true });
  act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS));
  expect(screen.getByRole("status")).toHaveTextContent("Connection is unstable. Retrying…");
  expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Reload" })).not.toBeInTheDocument();
  h.close();
});

it("keeps the notice stable until successful reads remain stable, without a Connected flash", () => {
  const h = renderBanner({ error: true });
  act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS));
  act(() => { markLive(); h.update({ error: false }); });
  act(() => vi.advanceTimersByTime(RECOVERY_QUIET_MS - 1));
  expect(screen.getByRole("status")).toBeInTheDocument();
  act(() => h.update({ error: true }));
  act(() => vi.advanceTimersByTime(2_000));
  expect(screen.getByRole("status")).toBeInTheDocument();
  act(() => { markLive(); h.update({ error: false }); });
  act(() => vi.advanceTimersByTime(RECOVERY_QUIET_MS));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.queryByText("Connected", { exact: true })).not.toBeInTheDocument();
  h.close();
});

it("names Herdr only when the snapshot reports Herdr unavailable", () => {
  const h = renderBanner({ bridge: "disconnected" });
  act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS));
  expect(screen.getByRole("status")).toHaveTextContent("Herdr is unavailable. Retrying…");
  h.close();
});

it("dates stale content without claiming it was freshly fetched", () => {
  const h = renderBanner({ error: true, lastSeenAt: new Date(2026, 0, 2, 14, 32).getTime() });
  act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS));
  expect(screen.getByRole("status")).toHaveTextContent(/Last synced \d/);
  h.close();
});

it("Retry refreshes data without reloading the page", async () => {
  const h = renderBanner({ error: true });
  act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
  expect(h.loader).toHaveBeenCalledTimes(1);
  h.close();
});

it("shows access refusal immediately with the real sign-in escape", () => {
  const h = renderBanner({ authError: true });
  expect(screen.getByRole("alert")).toHaveTextContent("Access refused. This is not a connection problem.");
  expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/auth/");
  expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  h.close();
});
