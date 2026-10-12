import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Download, Loader2, X } from "lucide-react";

import { shortName, useFitted } from "@/lib/fit-text";
import {
  clampView, dragIntent, DOUBLE_TAP_ZOOM, IDENTITY, MAX_ZOOM, pageStep, project, resist, rubberband, shouldDismiss, velocity, zoomAt,
  type Point, type Sample, type Size, type View,
} from "./image-gestures";

// The image viewer: the picture alone on black, edge to edge, moved by the finger the way a photo app
// moves it. Pinch and double tap zoom, a zoomed picture pans, a whole one goes down to close and across
// to the next, and a single tap hides the bars. Every move tracks the finger 1:1 and every release
// carries the finger's speed on (image-gestures.ts holds the decisions). The transform is written to
// the element directly while a finger is down, so a drag never waits on a React render.

/** One picture of the gallery; null where the gallery holds something that is not a picture. */
export interface ViewerImage { key: string; src: string; label: string }

/** Space between two pictures while one slides in. */
const GAP = 24;
/** How long a tap waits to learn whether it is the first half of a double tap. */
const DOUBLE_TAP_MS = 280;
/** Leaves at twice its average speed, so a duration of 2 · distance / speed hands the finger's speed on. */
const HANDOFF = "cubic-bezier(0.25, 0.5, 0.5, 1)";
const SETTLE = "cubic-bezier(0.2, 0.9, 0.3, 1)";

export const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** A release's animation length: the finger's own speed when it had one, kept between 180 and 300ms. */
function handoffMs(distance: number, speed: number): number {
  if (reducedMotion()) return 0;
  return speed > 50 ? Math.min(300, Math.max(180, (2 * Math.abs(distance) / speed) * 1000)) : 260;
}

const transformOf = (view: View) => `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`;

/** Where the picture is on screen right now, mid-animation included, so a grab never jumps. */
function liveView(element: HTMLElement, fallback: View): View {
  const matrix = getComputedStyle(element).transform;
  if (typeof DOMMatrixReadOnly === "undefined" || !matrix || matrix === "none") return fallback;
  const m = new DOMMatrixReadOnly(matrix);
  return { scale: m.a, x: m.e, y: m.f };
}

interface Gesture {
  mode: "idle" | "pending" | "pan" | "pinch" | "dismiss" | "page";
  pointers: Map<number, Point>;
  /** Where the one-finger drag began, and the view it began from. */
  origin: Point;
  from: View;
  pinch: { distance: number; mid: Point; from: View } | null;
  samples: Sample[];
}

const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export function ImageViewer({ images, index, name, downloadUrl, error, onStep, onClose, onDismissed, onImageError, onImageLoad }: {
  images: readonly (ViewerImage | null)[];
  index: number;
  name: string;
  downloadUrl?: string;
  /** Why the picture cannot be shown, drawn in its place. */
  error?: ReactNode;
  onStep: (by: -1 | 1) => void;
  /** Leave the usual way (Done, Escape, a click beside the picture); the caller fades the layer out. */
  onClose: () => void;
  /** The picture was swiped away and is already off screen: unmount now. */
  onDismissed: () => void;
  /** A picture, shown or waiting beside the one shown, failed or loaded: an <img> says so once. */
  onImageError: (src: string) => void;
  onImageLoad: (src: string) => void;
}) {
  const [chrome, setChrome] = useState(true);
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(() => new Set());
  const root = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const title = useFitted(titleRef, titleRef, name, (max) => shortName(name, max), 80);
  const stage = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const view = useRef<View>(IDENTITY);
  const gesture = useRef<Gesture>({ mode: "idle", pointers: new Map(), origin: { x: 0, y: 0 }, from: IDENTITY, pinch: null, samples: [] });
  const lastTap = useRef<{ t: number; at: Point } | null>(null);
  const chromeTimer = useRef(0);
  const timers = useRef<number[]>([]);
  const closing = useRef(false);
  /** Lands a page turn that is still sliding, when a finger comes down on it. */
  const landing = useRef<(() => void) | null>(null);

  const previous = index > 0 ? images[index - 1] ?? null : null;
  const current = images[index] ?? null;
  const next = images[index + 1] ?? null;
  const slots = ([[previous, -1], [current, 0], [next, 1]] as const)
    .filter((slot): slot is readonly [ViewerImage, -1 | 0 | 1] => slot[0] !== null);

  const zoomElement = () => stage.current?.querySelector<HTMLElement>("[data-image-zoom]") ?? null;
  const stageSize = (): Size => ({ width: stage.current?.clientWidth || window.innerWidth, height: stage.current?.clientHeight || window.innerHeight });
  const contentSize = (): Size => {
    const image = zoomElement()?.querySelector("img");
    return { width: image?.offsetWidth ?? 0, height: image?.offsetHeight ?? 0 };
  };
  /** A pointer's position from the stage's centre, the origin every view is measured from. */
  const local = (event: { clientX: number; clientY: number }): Point => {
    const box = stage.current?.getBoundingClientRect();
    const size = stageSize();
    return { x: event.clientX - (box?.left ?? 0) - size.width / 2, y: event.clientY - (box?.top ?? 0) - size.height / 2 };
  };
  const later = (run: () => void, ms: number) => { timers.current.push(window.setTimeout(run, ms)); };

  const show = (target: View, ms = 0, easing = SETTLE) => {
    view.current = target;
    const element = zoomElement();
    if (!element) return;
    element.style.transition = ms ? `transform ${ms}ms ${easing}` : "none";
    element.style.transform = transformOf(target);
  };
  const settle = (target: View, ms = 260, easing = SETTLE) => show(clampView(target, contentSize(), stageSize()), reducedMotion() ? 0 : ms, easing);
  const slide = (offset: number, ms = 0, easing = SETTLE) => {
    const element = track.current;
    if (!element) return;
    element.style.transition = ms ? `transform ${ms}ms ${easing}` : "none";
    element.style.transform = offset ? `translate3d(${offset}px, 0, 0)` : "";
  };
  const dim = (opacity: number, ms = 0) => {
    const element = scrim.current;
    if (!element) return;
    element.style.transition = ms ? `opacity ${ms}ms linear` : "none";
    element.style.opacity = String(opacity);
  };

  // A new picture starts whole and centred; the one it replaced lets go of its zoom.
  useLayoutEffect(() => {
    view.current = IDENTITY;
    for (const element of [...(stage.current?.querySelectorAll<HTMLElement>(".image-viewer-zoom") ?? []), track.current, scrim.current]) {
      if (!element) continue;
      element.style.transition = "";
      element.style.transform = "";
      element.style.opacity = "";
    }
    root.current?.removeAttribute("data-gesture");
    lastTap.current = null;
  }, [index]);

  useEffect(() => () => {
    window.clearTimeout(chromeTimer.current);
    timers.current.forEach((timer) => window.clearTimeout(timer));
  }, []);

  // A trackpad pinch arrives as a wheel with ctrl held; a plain wheel pans a zoomed picture.
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const current = view.current;
      if (closing.current || (!event.ctrlKey && current.scale <= 1.01)) return;
      event.preventDefault();
      const target = event.ctrlKey
        ? zoomAt(current, Math.min(MAX_ZOOM, Math.max(1, current.scale * Math.exp(-event.deltaY / 100))), local(event))
        : { ...current, x: current.x - event.deltaX, y: current.y - event.deltaY };
      show(clampView(target, contentSize(), stageSize()));
    };
    // touch-action: none keeps a pinch on the picture; Safari's own gesture events would still zoom the page.
    const keep = (event: Event) => event.preventDefault();
    element.addEventListener("wheel", onWheel, { passive: false });
    element.addEventListener("gesturestart", keep);
    return () => {
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("gesturestart", keep);
    };
    // Reads refs only; bound once for the stage's life.
  }, []);

  const restore = (ms = 0) => {
    root.current?.removeAttribute("data-gesture");
    show(IDENTITY, ms, HANDOFF);
    dim(1, ms);
  };

  const dismiss = (speed: number) => {
    closing.current = true;
    const size = stageSize();
    const from = view.current;
    const ms = handoffMs(size.height, Math.max(0, speed));
    if (!ms) return onDismissed();
    show({ ...from, y: from.y + size.height }, ms, HANDOFF);
    dim(0, ms);
    later(onDismissed, ms);
  };

  const turn = (step: -1 | 1, from: number, speed: number) => {
    const target = -step * (stageSize().width + GAP);
    const land = () => { landing.current = null; onStep(step); };
    const ms = handoffMs(target - from, Math.abs(speed));
    if (!ms) return land();
    slide(target, ms, HANDOFF);
    landing.current = land;
    later(() => landing.current?.(), ms);
  };

  const onTap = (at: Point, event: ReactPointerEvent) => {
    const last = lastTap.current;
    if (last && event.timeStamp - last.t < DOUBLE_TAP_MS && Math.hypot(at.x - last.at.x, at.y - last.at.y) < 40) {
      lastTap.current = null;
      window.clearTimeout(chromeTimer.current);
      settle(view.current.scale > 1.01 ? IDENTITY : zoomAt(view.current, DOUBLE_TAP_ZOOM, at), 280);
      return;
    }
    lastTap.current = { t: event.timeStamp, at };
    // On a desk a click beside the picture leaves; a click on it waits for a double click. The stage
    // holds the pointer capture, so the event's target is always the stage: ask the picture's box.
    if (event.pointerType === "mouse") {
      const box = zoomElement()?.querySelector("img")?.getBoundingClientRect();
      const onPicture = box && event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
      if (!onPicture) onClose();
      return;
    }
    chromeTimer.current = window.setTimeout(() => { lastTap.current = null; setChrome((shown) => !shown); }, DOUBLE_TAP_MS);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (closing.current || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const g = gesture.current;
    const at = local(event);
    g.pointers.set(event.pointerId, at);
    if (g.pointers.size === 1) {
      landing.current?.();
      const element = zoomElement();
      if (element) show(liveView(element, view.current));
      g.mode = "pending";
      g.origin = at;
      g.from = view.current;
      g.samples = [{ t: event.timeStamp, ...at }];
    } else if (g.pointers.size === 2) {
      // A second finger turns whatever the first began into a pinch from the picture at rest.
      if (g.mode === "dismiss" || g.mode === "page") { slide(0); restore(); }
      const [a, b] = [...g.pointers.values()] as [Point, Point];
      g.mode = "pinch";
      g.pinch = { distance: Math.hypot(b.x - a.x, b.y - a.y) || 1, mid: midpoint(a, b), from: view.current };
      lastTap.current = null;
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g.pointers.has(event.pointerId)) return;
    const at = local(event);
    g.pointers.set(event.pointerId, at);
    const size = stageSize();
    if (g.mode === "pinch") {
      if (!g.pinch || g.pointers.size < 2) return;
      const [a, b] = [...g.pointers.values()] as [Point, Point];
      const mid = midpoint(a, b);
      const scale = g.pinch.from.scale * (Math.hypot(b.x - a.x, b.y - a.y) / g.pinch.distance);
      const zoomed = zoomAt(g.pinch.from, scale, g.pinch.mid);
      show(resist({ scale, x: zoomed.x + mid.x - g.pinch.mid.x, y: zoomed.y + mid.y - g.pinch.mid.y }, contentSize(), size));
      return;
    }
    g.samples = [...g.samples.filter((sample) => event.timeStamp - sample.t <= 100), { t: event.timeStamp, ...at }];
    const dx = at.x - g.origin.x, dy = at.y - g.origin.y;
    if (g.mode === "pending") {
      const intent = dragIntent(dx, dy, view.current.scale > 1.01);
      if (!intent) return;
      g.mode = intent;
      lastTap.current = null;
      if (intent === "dismiss") root.current?.setAttribute("data-gesture", "dismiss");
    }
    if (g.mode === "pan") {
      show(resist({ scale: g.from.scale, x: g.from.x + dx, y: g.from.y + dy }, contentSize(), size));
    } else if (g.mode === "dismiss") {
      const y = dy > 0 ? dy : rubberband(dy, size.height);
      const down = Math.max(0, y);
      show({ scale: 1 - Math.min(1, down / size.height) * 0.3, x: dx, y });
      dim(1 - Math.min(1, down / (size.height * 0.5)));
    } else if (g.mode === "page") {
      const edge = (dx > 0 && !previous) || (dx < 0 && !next);
      slide(edge ? rubberband(dx, size.width) : dx);
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g.pointers.delete(event.pointerId)) return;
    if (g.mode === "pinch") {
      const [rest] = [...g.pointers.values()];
      if (rest) {
        // The finger that stays pans from where the pinch left the picture.
        g.mode = "pan";
        g.origin = rest;
        g.from = view.current;
        g.samples = [];
      } else {
        g.mode = "idle";
        settle(view.current);
      }
      return;
    }
    if (g.pointers.size) return;
    const mode = g.mode;
    g.mode = "idle";
    const at = local(event);
    const speed = velocity(g.samples);
    const size = stageSize();
    if (mode === "pending" && event.type === "pointerup") onTap(at, event);
    else if (mode === "pan") {
      const current = view.current;
      settle({ ...current, x: current.x + project(speed.x, 0.995), y: current.y + project(speed.y, 0.995) }, 400, "cubic-bezier(0.2, 0.8, 0.2, 1)");
    } else if (mode === "dismiss") {
      if (event.type === "pointerup" && shouldDismiss(view.current.y, speed.y, size.height)) dismiss(speed.y);
      else restore(handoffMs(view.current.y, Math.abs(speed.y)));
    } else if (mode === "page") {
      const dx = at.x - g.origin.x;
      const step = event.type === "pointerup" ? pageStep(dx, speed.x, size.width, !!previous, !!next) : 0;
      if (step) turn(step, dx, speed.x);
      else slide(0, handoffMs(dx, Math.abs(speed.x)), HANDOFF);
    }
  };

  const counter = images.length > 1 ? `${index + 1} of ${images.length}` : null;
  return <div ref={root} className="image-viewer" data-chrome={chrome ? "shown" : "hidden"}>
    <div ref={scrim} className="image-viewer-scrim" aria-hidden="true" />
    <div ref={stage} className="image-viewer-stage" data-image-stage="" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      {!error && <div ref={track} className="image-viewer-track">
        {slots.map(([image, offset]) => <div key={image.key} className="image-viewer-slot" style={offset ? { transform: `translateX(calc(${offset} * (100% + ${GAP}px)))` } : undefined}>
          <div className="image-viewer-zoom" data-image-zoom={offset === 0 ? "" : undefined}>
            {/* The pictures beside this one wait for a swipe, out of the reading order. */}
            <img src={image.src} alt={offset === 0 ? image.label : ""} aria-hidden={offset === 0 ? undefined : true} draggable={false} decoding="async"
              onError={() => onImageError(image.src)} onLoad={() => { setLoaded((done) => new Set(done).add(image.src)); onImageLoad(image.src); }} />
          </div>
        </div>)}
      </div>}
    </div>
    {error && <div className="image-viewer-error">{error}</div>}
    {/* Waits 300ms before it shows, so a picture from the cache never flashes it. */}
    {!error && current && !loaded.has(current.src) && <div role="status" aria-label="Loading image" className="image-viewer-loading">
      <Loader2 className="size-6 animate-spin motion-reduce:animate-none" aria-hidden="true" />
    </div>}
    <header className="image-viewer-bar image-viewer-top">
      {/* A modal's Done, as in the document preview (file-preview.tsx). */}
      <button type="button" className="preview-done" onClick={onClose}>Done</button>
      <h2 ref={titleRef} className="image-viewer-title" aria-label={title === name ? undefined : name} title={title === name ? undefined : name}>{title}</h2>
      <div className="image-viewer-actions">
        {downloadUrl && <a href={downloadUrl} download={name} aria-label="Download image" className="image-viewer-action"><Download className="size-5" aria-hidden="true" /></a>}
        <button type="button" aria-label="Close image" onClick={onClose} className="image-viewer-action preview-close"><X className="size-5" aria-hidden="true" /></button>
      </div>
    </header>
    {counter && <nav aria-label="Gallery" className="image-viewer-bar image-viewer-bottom">
      <button type="button" aria-label="Previous" disabled={index === 0} onClick={() => onStep(-1)} className="image-viewer-action"><ChevronLeft className="size-5" aria-hidden="true" /></button>
      <span aria-live="polite" className="image-viewer-count">{counter}</span>
      <button type="button" aria-label="Next" disabled={index === images.length - 1} onClick={() => onStep(1)} className="image-viewer-action"><ChevronRight className="size-5" aria-hidden="true" /></button>
    </nav>}
  </div>;
}
