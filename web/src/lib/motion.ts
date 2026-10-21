import { useEffect } from "react";
import { matchRoutes, useLocation, useNavigate, type DataRouter, type RouterNavigateOptions, type To } from "react-router";

/**
 * How a page change moves, the way a phone's navigation does: a deeper page slides in from the right
 * over the one it leaves (push), the back control slides the page out to the right (pop), and any other
 * change (the tab bar's Home, a sibling pane, a pick in the sidebar) cross-fades in place. Every pane
 * sits at one route depth, so a move between a coordinator and its threads names its motion (armMotion).
 * Reduced motion, and a desk, where the sidebar must stay put beside the page, turn every change into
 * the cross-fade. index.css draws each one.
 */
export type Motion = "push" | "pop" | "fade";

/** index.css's --motion-* tokens, for the few motions drawn from script (Web Animations). */
export const MOTION_CONTROL_MS = 120;
export const MOTION_PANEL_MS = 180;
export const MOTION_EASE = "cubic-bezier(0.2, 0, 0, 1)";

/** How long the old page may stay frozen on screen while the next one loads. Past it the change goes
 *  through as it always did, unanimated; under NAV_BUSY_THRESHOLD_MS, so a slow link still shows the bar. */
export const MOTION_BUDGET_MS = 300;

/** Each route's place in the hierarchy, on its `handle` (router.tsx). A route without one sits at Home's level. */
export interface MotionHandle {
  depth?: number;
}

// The router whose navigations animate, for the settle check below. One per page.
let active: DataRouter | null = null;
// A motion the next navigation asked for by name (armMotion).
let armed: Motion | undefined;
// The transition waiting for its page, and the motion it is drawing.
let waiting: { from: string; release: () => void } | null = null;
let drawing: object | null = null;

/**
 * Animate the navigations this app starts. Only `router.navigate` is wrapped, and only `<Link>`,
 * `useNavigate` and our own code call it: a poll's revalidation, a loader's redirect and the browser's
 * Back never come through here, so they never start a transition. React Router's own `viewTransition`
 * flag stays unused, because it replays a transition on every revalidation after a Back
 * (.adr/0078-page-motion-runs-only-on-navigations-the-app-starts.md).
 */
export function animateNavigations(router: DataRouter): void {
  active = router;
  const navigate = router.navigate;
  router.navigate = ((to: To | number | null, opts?: RouterNavigateOptions) => {
    if (typeof to === "number") {
      const motion = motionFor(router, to, opts);
      return motion ? move(router, motion, () => navigate(to)) : navigate(to);
    }
    const stamped = { ...opts, state: stamp(router, to, opts) };
    const motion = motionFor(router, to, opts);
    return motion ? move(router, motion, () => navigate(to, stamped)) : navigate(to, stamped);
  }) as DataRouter["navigate"];
}

// The page an entry was pushed from, kept in its history state so it survives a reload. A replace keeps
// the entry's place in the history, so it keeps the page before it too, and so does a navigation to the
// page already shown, which React Router turns into a replace.
const FROM = "nenuFrom";

function stamp(router: DataRouter, to: To | null, opts: RouterNavigateOptions | undefined): unknown {
  const here = router.state.location;
  const path = here.pathname + here.search;
  const there = typeof to === "string" ? new URL(to, new URL(path, "http://nenu.invalid")) : undefined;
  const stays = opts?.replace || (there !== undefined && there.pathname + there.search === path);
  const from = stays ? fromOf(here.state) : path;
  if (from === undefined) return opts?.state;
  const state: unknown = opts?.state;
  return { ...(typeof state === "object" && state !== null ? state : {}), [FROM]: from };
}

function fromOf(state: unknown): string | undefined {
  const from = typeof state === "object" && state !== null ? (state as Record<string, unknown>)[FROM] : undefined;
  return typeof from === "string" ? from : undefined;
}

/** One screen, whatever it shows inside (a coordinator's tab, a docked thread): its path and session. */
function sameScreen(a: string, b: string): boolean {
  const [x, y] = [new URL(a, "http://nenu.invalid"), new URL(b, "http://nenu.invalid")];
  return x.pathname === y.pathname && x.searchParams.get("s") === y.searchParams.get("s");
}

/**
 * Go up to `parent`, sliding out as a pop. When the entry before this one is that parent, this is the
 * browser's Back, so the app's back and the system's agree and the history never grows; otherwise the
 * parent replaces this page, so the system's Back skips it as a pop would have.
 */
export function useGoUp(): (parent: string) => void {
  const navigate = useNavigate();
  const { state } = useLocation();
  return (parent) => {
    armMotion("pop");
    const from = fromOf(state);
    if (from !== undefined && sameScreen(from, parent)) void navigate(-1);
    else void navigate(parent, { replace: true });
  };
}

/**
 * The back control: back to the screen this one was opened from, as it was, which is the browser's Back,
 * so the app's back and the system's agree. A screen nothing in the app opened (a link, a reload with no
 * history, a launch from a notification) has none: `parent` replaces it, once, so the history never grows.
 */
export function useGoBack(): (parent: string) => void {
  const navigate = useNavigate();
  const { state } = useLocation();
  return (parent) => {
    armMotion("pop");
    if (fromOf(state) !== undefined) void navigate(-1);
    else void navigate(parent, { replace: true });
  };
}

/** The very next navigation, started in this same task, moves this way: the back control's pop, a
 *  notification's push. Gone by the next microtask, so a click that ends up not navigating leaves nothing. */
export function armMotion(motion: Motion): void {
  armed = motion;
  queueMicrotask(() => {
    armed = undefined;
  });
}

/**
 * Tells a waiting transition its page has arrived. Called from the root layout, whose effect runs after
 * its children's: a `<Navigate>` redirect has started loading by then, so the transition waits for the
 * page it lands on instead of drawing the empty page in between.
 */
export function useMotionSettle(): void {
  const { key } = useLocation();
  useEffect(() => {
    if (waiting && waiting.from !== key && active?.state.navigation.state === "idle") waiting.release();
  }, [key]);
}

function motionFor(router: DataRouter, to: To | number | null, opts: RouterNavigateOptions | undefined): Motion | undefined {
  const asked = armed;
  armed = undefined;
  if (typeof document.startViewTransition !== "function") return undefined;
  // A step through the history moves only when the app asked (its back control), never for the browser's.
  if (typeof to === "number") return asked && (window.matchMedia?.(STILL).matches ? "fade" : asked);
  // A replace corrects where you are (a redirect, a closed pane, a tab switch inside a chat): no move,
  // unless the app asked for one (the back control, a sibling's chip).
  if (opts?.replace && !asked) return undefined;
  const here = router.state.location.pathname;
  const there = typeof to === "string" ? new URL(to, new URL(here, "http://nenu.invalid")).pathname : (to?.pathname ?? here);
  if (there === here) return undefined;
  if (window.matchMedia?.(STILL).matches) return "fade";
  return asked ?? (depth(router, there) > depth(router, here) ? "push" : "fade");
}

// Where a change only cross-fades: reduced motion, or a desk (workbench.css shows the sidebar from 1024 px).
// The whole page is one picture in a transition (WebKit draws no separately named part of it), so a
// slide there would drag the sidebar along.
const STILL = "(prefers-reduced-motion: reduce), (min-width: 1024px)";

function depth(router: DataRouter, pathname: string): number {
  const handle = matchRoutes(router.routes, pathname)?.at(-1)?.route.handle as MotionHandle | undefined;
  return handle?.depth ?? 0;
}

/**
 * Navigate inside a view transition. The navigation starts in the update callback, after the old page
 * is captured, so a page that loads instantly can never be captured as the old one. The old page stays
 * frozen until the new one commits, or MOTION_BUDGET_MS, whichever comes first. Resolves with the
 * navigation, as `router.navigate` does.
 */
function move(router: DataRouter, motion: Motion, go: () => Promise<void>): Promise<void> {
  waiting?.release(); // a newer change lets go of an older one at once
  let release!: () => void;
  const arrived = new Promise<void>((resolve) => { release = resolve; });
  const hold = { from: router.state.location.key, release: () => { if (waiting === hold) waiting = null; release(); } };
  waiting = hold;
  const root = document.documentElement;
  const token = {};
  drawing = token;
  root.dataset.motion = motion;
  return new Promise<void>((resolve, reject) => {
    const transition = document.startViewTransition(() => {
      go().then(resolve, reject);
      const budget = setTimeout(() => {
        transition.skipTransition();
        hold.release();
      }, MOTION_BUDGET_MS);
      return arrived.then(() => clearTimeout(budget));
    });
    transition.ready.catch(() => {}); // a skipped transition rejects `ready`; the navigation is unaffected
    void transition.finished.catch(() => {}).finally(() => {
      if (drawing !== token) return;
      drawing = null;
      delete root.dataset.motion;
    });
  });
}
