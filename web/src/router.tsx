import { createBrowserRouter, type RouteObject } from "react-router";

import { BootSplash, RootError, RootLayout } from "@/routes/root";
import { HomeRoute } from "@/routes/home";
import { SpaceRoute } from "@/routes/space";
import { DetailRoute } from "@/routes/detail";
import { HistoryRoute } from "@/routes/history";
import { SettingsRoute } from "@/routes/settings";
import { NodeRoute } from "@/routes/node";
import { ProjectRoute } from "@/routes/project";
import { NotFoundRoute } from "@/routes/not-found";
import { historyLoader, rootLoader, paneLoader, PANE_ROUTE_ID, ROOT_ROUTE_ID } from "@/lib/loaders";
import { animateNavigations, armMotion, type MotionHandle } from "@/lib/motion";
import { listenForOpen } from "@/lib/notification-open";

// We never use React Router's `viewTransition` flag (page motion is lib/motion.ts). React Router persists
// an "applied view transitions" map to sessionStorage ("remix-router-transitions") and replays a phantom
// same-location transition on every revalidation for any path it once saw a `viewTransition: true`
// navigation from. A device that ran an older Nenu build (which did use them) can carry a stale entry
// that fires document.startViewTransition on every poll. Clear it on boot — our code never repopulates
// it. The `:root { view-transition-name: none }` in index.css is the belt to this: even a stray
// transition then captures nothing, so there's no visible flicker regardless of this key's name.
try {
  sessionStorage.removeItem("remix-router-transitions");
} catch {
  // sessionStorage access can throw in locked-down / private contexts — ignore.
}

function depth(value: number): MotionHandle {
  return { depth: value };
}

export const routes: RouteObject[] = [
  {
    id: ROOT_ROUTE_ID,
    path: "/",
    loader: rootLoader,
    element: <RootLayout />,
    // Catches render-phase errors and loader throws (e.g. a missing :paneId) so a component bug
    // shows a recoverable screen instead of React Router's blank default.
    errorElement: <RootError />,
    HydrateFallback: BootSplash,
    children: [
      // `handle.depth` is each page's place in the hierarchy: a move deeper slides in (lib/motion.ts).
      { index: true, handle: depth(0), element: <HomeRoute /> },
      { path: "space/:spaceId", handle: depth(1), element: <SpaceRoute /> },
      { path: "project/:projectSlug", handle: depth(1), element: <ProjectRoute /> },
      { path: "project/:projectSlug/node/:nodeId", handle: depth(2), element: <NodeRoute /> },
      { path: "settings", handle: depth(1), element: <SettingsRoute /> },
      // Its map and charts load only when it is opened (Settings → Usage).
      { path: "settings/usage", handle: depth(2), lazy: async () => ({ Component: (await import("@/routes/usage")).UsageRoute }) },
      // Read only, and opened from the desk's bar: its code loads when it is opened.
      { path: "routines", handle: depth(1), lazy: async () => ({ Component: (await import("@/routes/routines")).RoutinesRoute }) },
      // Named, so RootLayout can ask for THIS route's data by id (react-router hands back undefined
      // whenever it isn't the active route) — see the "last seen" note there.
      { id: PANE_ROUTE_ID, path: "pane/:paneId", handle: depth(3), loader: paneLoader, element: <DetailRoute /> },
      // A file's own page, for a link opened in a new tab: the viewer's code loads when it is opened.
      { path: "pane/:paneId/file", handle: depth(4), lazy: async () => ({ Component: (await import("@/routes/file")).FileRoute }) },
      {
        path: "pane/:paneId/history",
        handle: depth(4),
        loader: historyLoader,
        element: <HistoryRoute />,
        // Opt OUT of the poll loop. revalidate() re-runs every active loader, and a transcript can be
        // hundreds of turns — re-pulling it every 1.5s would be pure waste, and it would fight the
        // view's own "load older" paging by resetting the page under it. History is fetched on
        // navigation; the view pages back through it with direct api calls.
        shouldRevalidate: () => false,
      },
      // Anything else is a link to nothing: answered inside the app, never by the crash screen.
      { path: "*", element: <NotFoundRoute /> },
    ],
  },
];

// Created once at module scope so the idle-lock in App can unmount/remount RouterProvider without
// losing the current location (the router instance retains it; loaders re-run fresh on remount).
export const router = createBrowserRouter(routes);
animateNavigations(router);

// A tapped notification opens its page here, as a push, instead of reloading the app (sw.ts).
if ("serviceWorker" in navigator) {
  listenForOpen(navigator.serviceWorker, (path) => {
    armMotion("push");
    void router.navigate(path);
  });
  navigator.serviceWorker.startMessages();
}
