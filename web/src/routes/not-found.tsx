import { Link, useLocation, useRouteLoaderData } from "react-router";
import { Unlink } from "@/components/ui/icon";

import { ColumnPage } from "@/components/column-page";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { homePath } from "@/lib/nav";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

/**
 * What an unknown URL shows, and what a 404 thrown from a loader shows: what is missing, the path so
 * a stale link can be recognised, and the one way back. Never the crash screen. `titleAs` is h1 where
 * no header titles the page (a 404 thrown past the app's frame).
 */
export function NotFound({ titleAs }: { titleAs?: "h1" }) {
  const session = useSession();
  const { pathname } = useLocation();
  // cn() is what drops buttonVariants' base text-footnote for lg's text-body on a link; bare, the label is 13px.
  return (
    <EmptyState icon={Unlink} title="Page not found" titleAs={titleAs}
      action={<Link to={homePath(session)} className={cn(buttonVariants({ size: "lg" }))}>Go to Home</Link>}>
      This link doesn&rsquo;t match anything in Nenu.
      <code className="mt-2 block font-mono text-footnote break-all text-subtle-foreground">{pathname}</code>
    </EmptyState>
  );
}

/** The catch-all route: a page like any other, so the header, the read-only notice and the tab bar stay. */
export function NotFoundRoute() {
  // SAFETY: this route is a child of the root route, whose loader returns HomeData (router.tsx).
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  return <ColumnPage data={data} title="Page not found" bodyClassName="flex flex-col justify-center"><NotFound /></ColumnPage>;
}
