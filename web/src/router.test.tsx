import { render, screen, within } from "@testing-library/react";
import { createMemoryRouter, matchRoutes, Outlet, RouterProvider } from "react-router";

import { routes } from "./router";
import { PANE_ROUTE_ID, ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";

const home: HomeData = {
  bridge: "connected", agents: [], shellPanes: [], workspaces: [], tabs: [], sessions: [],
  device: undefined, session: undefined, snoozedUntil: null, update: undefined,
  error: false, authError: false,
};

// The app's real route table, with the root's data and layout stubbed: what an unknown URL lands on.
function open(path: string, data: HomeData = home) {
  const [root] = routes;
  const router = createMemoryRouter([{ ...root!, loader: () => data, element: <Outlet />, HydrateFallback: undefined }], {
    initialEntries: [path],
    hydrationData: { loaderData: { [ROOT_ROUTE_ID]: data } },
  });
  render(<RouterProvider router={router} />);
  return router;
}

describe("routes", () => {
  // A push opens /pane/:id (with ?s= for another session), "/" for a test push, /settings for an
  // update (sw.ts); an in-app notice opens the pane, or Home for several (use-transitions.ts). Needs
  // you is no tab of its own any more: it is the top of Home, so every one of those still lands.
  it("still opens every place a notification leads to: a pane, Home with what needs you on top, Settings", async () => {
    const leaf = (path: string) => matchRoutes(routes, path)?.at(-1)?.route;
    expect(leaf("/pane/w1%3Ap2")?.id).toBe(PANE_ROUTE_ID);
    expect(leaf("/settings")?.path).toBe("settings");
    expect(leaf("/")?.index).toBe(true);
    const asking: HomeData = {
      ...home,
      session: "qa",
      workspaces: [{ workspaceId: "w1", number: 1, label: "api", focused: true, activeTabId: "t1", tabCount: 1, paneCount: 1 }],
      agents: [{ paneId: "w1:p2", workspaceId: "w1", workspaceLabel: "api", workspaceNumber: 1, tabId: "t1", agent: "claude", status: "blocked", cwd: "/", focused: false, paneLabel: "Migrate the orders table" }],
    };
    const router = open("/?s=qa", asking);
    expect(await screen.findByRole("heading", { level: 1, name: "1 needs you" })).toBeInTheDocument();
    const needs = screen.getByRole("region", { name: "Needs you" });
    expect(within(needs).getByRole("link", { name: /Migrate the orders table/ })).toHaveAttribute("href", "/pane/w1%3Ap2?s=qa");
    router.dispose();
  });

  // A file's link opened in a new tab lands on its own page: the viewer, the whole screen.
  it("opens a file's own page in the viewer, and an address with no file as Page not found", async () => {
    const leaf = (path: string) => matchRoutes(routes, path)?.at(-1)?.route;
    expect(leaf("/pane/w1%3Ap2/file?path=docs%2Fa.md")?.path).toBe("pane/:paneId/file");
    let router = open("/pane/w1%3Ap2/file?path=docs%2Freadme.md&s=qa");
    expect(await screen.findByRole("dialog", { name: "readme.md" })).toBeInTheDocument();
    router.dispose();
    router = open("/pane/w1%3Ap2/file");
    expect(await screen.findByRole("heading", { name: "Page not found", level: 2 })).toBeInTheDocument();
    router.dispose();
  });

  it("answers an unknown URL with Page not found inside the app, not the crash screen", () => {
    const router = open("/this/does/not/exist?s=qa");
    expect(screen.getByRole("heading", { name: "Page not found", level: 2 })).toBeInTheDocument();
    expect(screen.getByText("/this/does/not/exist")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Home" })).toHaveAttribute("href", "/?s=qa");
    // The large button's body label: a link wearing buttonVariants bare keeps the base text-footnote beside it.
    expect(screen.getByRole("link", { name: "Go to Home" })).toHaveClass("ui-button-lg", "bg-foreground", "text-body");
    expect(screen.getByRole("link", { name: "Go to Home" })).not.toHaveClass("text-footnote");
    expect(screen.queryByText(/Nenu hit a problem|Something went wrong/)).not.toBeInTheDocument();
    router.dispose();
  });

  it("titles the page in its header and keeps the read-only notice, like every other page", () => {
    const router = open("/nowhere", { ...home, device: { enforced: true, authorized: false, device: "alex-iphone" } });
    expect(within(screen.getByRole("banner")).getByText("Page not found")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Read-only on this device · alex-iphone");
    router.dispose();
  });
});
