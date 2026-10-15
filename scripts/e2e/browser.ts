import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Playwright is a dependency of scripts/e2e only (its own package.json, pinned, 7-day cooldown), so
// the root typecheck must not need it installed. It is loaded by a computed specifier and typed by
// the few calls the bench makes. playwright-core never downloads a browser: it uses the revision
// already in Playwright's cache (webkit-2287 for 1.60.0).

export interface Request { url(): string; method(): string }
export interface Route { request(): Request; fulfill(opts: { json?: unknown; status?: number }): Promise<void> }
export interface Locator {
  click(opts?: { timeout?: number }): Promise<void>;
  hover(opts?: { timeout?: number }): Promise<void>;
  fill(text: string, opts?: { timeout?: number }): Promise<void>;
  press(key: string, opts?: { timeout?: number }): Promise<void>;
  isVisible(): Promise<boolean>;
  count(): Promise<number>;
  selectOption(value: string): Promise<unknown>;
  waitFor(opts?: { state?: "visible" | "attached"; timeout?: number }): Promise<void>;
  first(): Locator;
  last(): Locator;
  innerText(): Promise<string>;
  getAttribute(name: string): Promise<string | null>;
  screenshot(opts: { path?: string; animations?: "disabled" }): Promise<Uint8Array>;
  getByText(text: string | RegExp, opts?: { exact?: boolean }): Locator;
  getByRole(role: string, opts?: { name?: string | RegExp; exact?: boolean }): Locator;
  getByLabel(text: string | RegExp, opts?: { exact?: boolean }): Locator;
}
export interface Page {
  goto(url: string, opts?: { waitUntil?: "load" | "domcontentloaded" }): Promise<unknown>;
  on(event: "request", fn: (req: Request) => void): void;
  screenshot(opts: { path?: string; fullPage?: boolean; animations?: "disabled" }): Promise<Uint8Array>;
  getByText(text: string | RegExp, opts?: { exact?: boolean }): Locator;
  getByRole(role: string, opts?: { name?: string | RegExp; exact?: boolean }): Locator;
  getByPlaceholder(text: string | RegExp): Locator;
  getByLabel(text: string | RegExp, opts?: { exact?: boolean }): Locator;
  locator(selector: string, opts?: { hasText?: string | RegExp }): Locator;
  url(): string;
  evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
  addInitScript<A>(fn: (arg: A) => void, arg: A): Promise<void>;
  clock: { install(opts: { time: number }): Promise<void> };
  route(url: string, handler: (route: Route) => unknown): Promise<void>;
  keyboard: { press(key: string): Promise<void>; type(text: string, opts?: { delay?: number }): Promise<void> };
  mouse: { move(x: number, y: number): Promise<void>; wheel(dx: number, dy: number): Promise<void> };
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  goBack(): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  waitForFunction<A>(fn: (arg: A) => unknown, arg: A, opts?: { timeout?: number }): Promise<unknown>;
  close(): Promise<void>;
}
export interface Context { newPage(): Promise<Page>; close(): Promise<void> }
export interface Browser {
  newContext(opts: Record<string, unknown>): Promise<Context>;
  close(): Promise<void>;
}

export const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  reducedMotion: "reduce",
  colorScheme: "dark",
} as const;

export const DESKTOP = {
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  reducedMotion: "reduce",
  colorScheme: "dark",
} as const;

/** The per-user cache dir: ~/Library/Caches on macOS, $XDG_CACHE_HOME or ~/.cache elsewhere. */
export function userCacheDir(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches");
  return process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
}

/** Where the browsers live: $PLAYWRIGHT_BROWSERS_PATH, else Playwright's cache. */
export function browsersCache(): string {
  return process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(userCacheDir(), "ms-playwright");
}

// NENU_E2E_BROWSER=chromium runs the same flows when the cached WebKit misbehaves on a host. It is a
// fallback for a broken machine, not a substitute: Safari-only bugs only show up under WebKit.
export async function launchWebkit(): Promise<Browser> {
  const engine = process.env.NENU_E2E_BROWSER === "chromium" ? "chromium" : "webkit";
  const cache = browsersCache();
  const prefix = engine === "chromium" ? "chromium" : "webkit-";
  if (!existsSync(cache) || !readdirSync(cache).some((d) => d.startsWith(prefix))) {
    throw new Error(`no cached ${engine} under ${cache}; this bench never downloads browsers`);
  }
  const specifier = "playwright-core";
  let mod: Record<"webkit" | "chromium", { launch(opts: { headless: boolean }): Promise<Browser> }>;
  try {
    mod = await import(specifier);
  } catch {
    throw new Error("playwright-core is not installed: run `bun install` in scripts/e2e");
  }
  return mod[engine].launch({ headless: true });
}
