import { render, screen, within } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { SettingsRoute } from "./settings";

const root: HomeData = {
  bridge: "connected", agents: [], shellPanes: [], workspaces: [], tabs: [], projects: [], device: undefined,
  sessions: [], session: "work", snoozedUntil: null, update: undefined, error: false, authError: false,
};

it("goes back Home with the back link every page shares", async () => {
  const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/", loader: () => root, element: <Outlet />, children: [
    { index: true, element: <p>HOME</p> },
    { path: "settings", element: <SettingsRoute /> },
  ] }], { initialEntries: ["/settings?s=work"] });
  render(<RouterProvider router={router} />);
  const header = within(await screen.findByRole("banner"));
  // A link to where it goes, named for it, like a project's or a node's; never a bare "Back" button.
  expect(header.getByRole("link", { name: "Back to Home" })).toHaveAttribute("href", "/?s=work");
  expect(header.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
  router.dispose();
});

// iOS gives Web Push only to a web app opened from the Home Screen (iOS 16.4+): a Safari tab has no
// Push API, and "This browser doesn't support push" sent people looking for another browser.
describe("push on a device whose browser has no Push API", () => {
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
  const matchMedia = window.matchMedia;
  const device = ({ ua, platform, touch, standalone }: { ua: string; platform: string; touch: number; standalone: boolean }) => {
    for (const [key, value] of [["userAgent", ua], ["platform", platform], ["maxTouchPoints", touch]] as const) {
      Object.defineProperty(navigator, key, { configurable: true, get: () => value });
    }
    window.matchMedia = (query: string) => ({
      matches: standalone && query === "(display-mode: standalone)", media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    });
  };
  afterEach(() => {
    for (const key of ["userAgent", "platform", "maxTouchPoints"]) delete (navigator as unknown as Record<string, unknown>)[key];
    window.matchMedia = matchMedia;
  });

  it.each([
    ["an iPhone's Safari tab", { ua: IPHONE, platform: "iPhone", touch: 5, standalone: false }, "Add Nenu to your Home Screen to get notifications."],
    ["an iPad's Safari tab, which asks for the desktop site", { ua: MAC, platform: "MacIntel", touch: 5, standalone: false }, "Add Nenu to your Home Screen to get notifications."],
    // The UA names an iPhone outright; touch only tells an iPad's desktop UA from a Mac's.
    ["an iPhone tab that reports no touch points, as an emulator does", { ua: IPHONE, platform: "MacIntel", touch: 0, standalone: false }, "Add Nenu to your Home Screen to get notifications."],
    ["Nenu opened from an iPhone's Home Screen on an iOS without Web Push", { ua: IPHONE, platform: "iPhone", touch: 5, standalone: true }, "This browser doesn't support push notifications."],
    ["a desktop browser", { ua: MAC, platform: "MacIntel", touch: 0, standalone: false }, "This browser doesn't support push notifications."],
  ] as const)("says what to do on %s", async (_name, props, note) => {
    device(props);
    const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/", loader: () => root, element: <Outlet />, children: [
      { path: "settings", element: <SettingsRoute /> },
    ] }], { initialEntries: ["/settings"] });
    render(<RouterProvider router={router} />);
    expect(await screen.findByText(note)).toBeVisible();
    expect(screen.getByRole("switch", { name: "Push notifications" })).toBeDisabled();
    router.dispose();
  });
});
