import { useCallback, useContext, useSyncExternalStore } from "react";
import { UNSAFE_DataRouterContext, type RouterState } from "react-router";

// React Router's own hooks subscribe their caller to the router: useRevalidator to its whole state,
// useNavigate to the route context, both rebuilt on every revalidation. A live event runs one (loading,
// then idle), so a component that only ever calls revalidate() or navigates to a path redrew twice per
// event, and with it everything under it. These read the router itself, whose context is stable, and
// subscribe to nothing, or to the one value they select. They matter where a component would otherwise
// redraw for nothing; one that reads loader data redraws on every run anyway, and keeps React Router's.

function useRouter() {
  const context = useContext(UNSAFE_DataRouterContext);
  if (!context) throw new Error("the router hooks need a data router");
  return context.router;
}

/** The router's revalidate(), stable for the router's life, without re-rendering on its state. */
export function useRevalidate(): () => Promise<void> {
  const router = useRouter();
  return useCallback(() => router.revalidate(), [router]);
}

/**
 * navigate() to an absolute path, stable for the router's life, without re-rendering on the route
 * context. It goes through router.navigate, which lib/motion.ts wraps, as useNavigate's does.
 */
export function useNavigateTo(): (path: string) => void {
  const router = useRouter();
  return useCallback((path: string) => void router.navigate(path), [router]);
}

/**
 * One value read off the router's state, re-rendering only when it changes. `select` must return a
 * primitive (or a value the state holds), so an unchanged pick compares equal.
 */
export function useRouterState<T>(select: (state: RouterState) => T): T {
  const router = useRouter();
  const read = () => select(router.state);
  return useSyncExternalStore(router.subscribe, read, read);
}
