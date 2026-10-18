import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { useLocation, useNavigationType } from "react-router";

import { AppHeader, SettingsGear, type HeaderBack } from "@/components/app-header";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import type { HomeData } from "@/lib/loaders";
import { cn } from "@/lib/utils";

/**
 * A page (Home, a project, a node): the shared header, the read-only notice, and the page column under
 * it. When the page draws the title as its own heading, the header's title waits until that heading
 * has scrolled under the header, the way a large title folds into a phone's navigation bar.
 */
export function ColumnPage({ data, title, back, bodyClassName, children }: {
  data: HomeData;
  title: string;
  /** Where the back control goes; Home when omitted. */
  back?: HeaderBack;
  bodyClassName?: string;
  children: ReactNode;
}) {
  const body = useRef<HTMLElement>(null);
  const headingInView = useHeadingInView(body, title);
  return (
    <div className="workbench-home flex min-h-0 min-w-0 flex-1 flex-col">
      <AppHeader bridge={data.bridge} error={data.error} title={title} titleHidden={headingInView} back={back}
        rightTrail={<SettingsGear session={data.session} />} />
      <ReadOnlyBanner device={data.device} />
      <PageBody ref={body} className={bodyClassName}>{children}</PageBody>
    </div>
  );
}

/** The page's scroller and its one column, centred in the content area as the chat is. The boot splash
 *  and Settings draw it too, so the page the app lands on does not move and every page centres alike;
 *  `columnClassName` narrows or lays out the column (Settings' 640px form). */
export function PageBody({ ref, className, columnClassName, children }: { ref?: Ref<HTMLElement>; className?: string; columnClassName?: string; children: ReactNode }) {
  const scroller = useRef<HTMLElement>(null);
  useImperativeHandle(ref, () => scroller.current!, []);
  useKeptScroll(scroller);
  return (
    <main ref={scroller} className={cn("page-body", className)}>
      <div className={cn("page-column mx-auto", columnClassName)}>{children}</div>
    </main>
  );
}

// Where each page's scroller stood, by history entry, for as long as the app runs.
const kept = new Map<string, number>();
const KEEP_TRYING_MS = 3000;

/**
 * Keeps where a page was scrolled, per history entry, and puts it back when the history steps back to
 * that entry (the back control, the system's Back), the way a phone's back shows the list as you left
 * it. What loads after the page (Your asks' list) grows it, so the position is applied again as it
 * grows, until it fits, the person scrolls, or a few seconds pass. A page pushed or replaced opens at the top.
 */
function useKeptScroll(scroller: RefObject<HTMLElement | null>): void {
  const { key } = useLocation();
  const action = useNavigationType();
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const target = action === "POP" ? kept.get(key) : undefined;
    let restoring = target !== undefined;
    const apply = () => {
      if (!restoring) return;
      element.scrollTop = target!;
      if (Math.abs(element.scrollTop - target!) < 1) restoring = false;
    };
    const stop = () => { restoring = false; };
    const save = () => { if (!restoring) kept.set(key, element.scrollTop); };
    apply();
    const growth = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(apply);
    if (element.firstElementChild) growth?.observe(element.firstElementChild);
    const timer = setTimeout(stop, KEEP_TRYING_MS);
    const touches = ["wheel", "touchstart", "keydown"] as const;
    for (const type of touches) element.addEventListener(type, stop, { passive: true });
    element.addEventListener("scroll", save, { passive: true });
    return () => {
      growth?.disconnect();
      clearTimeout(timer);
      for (const type of touches) element.removeEventListener(type, stop);
      element.removeEventListener("scroll", save);
    };
  }, [key, action, scroller]);
}

/** Whether the page's heading that says `title` is still in view in its scroller. False when no heading
 *  says it: a heading that names something else (a node under its project) never hides the bar's title. */
function useHeadingInView(scroller: RefObject<HTMLElement | null>, title: string): boolean {
  const [heading, setHeading] = useState<Element | null>(null);
  const [inView, setInView] = useState(true);
  // The heading can change with the page's data (a node that turns up after a refresh), so look again
  // after every render; only a different element starts a new watch.
  useLayoutEffect(() => {
    const headings = scroller.current?.querySelectorAll("h1, h2") ?? [];
    const found = [...headings].find((candidate) => candidate.textContent?.trim() === title) ?? null;
    if (found !== heading) setHeading(found);
  });
  const watchable = typeof IntersectionObserver !== "undefined";
  useEffect(() => {
    const root = scroller.current;
    if (!heading || !root || !watchable) return;
    // A busy page can get several crossings in one delivery, oldest first; only the last is current.
    const observer = new IntersectionObserver((entries) => setInView(entries[entries.length - 1]!.isIntersecting), { root });
    observer.observe(heading);
    return () => observer.disconnect();
  }, [heading, scroller, watchable]);
  return watchable && heading !== null && inView;
}
