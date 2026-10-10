// Preloaded into the test bridge: moves the wall clock by NENU_E2E_CLOCK_SHIFT_MS while it keeps
// ticking, so time-of-day UI is the same on every run. Timers and performance.now are untouched.

const shift = Number(process.env.NENU_E2E_CLOCK_SHIFT_MS) || 0;
if (shift) {
  const RealDate = Date;
  const now = () => RealDate.now() + shift;
  globalThis.Date = new Proxy(RealDate, {
    construct: (target, args) => (args.length ? new target(...(args as [number])) : new target(now())),
    apply: () => new RealDate(now()).toString(),
    get: (target, key) => (key === "now" ? now : Reflect.get(target, key)),
  });
}
