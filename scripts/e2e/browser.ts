import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Playwright is a dependency of scripts/e2e only (its own package.json, pinned, 7-day cooldown), so
// the root typecheck must not need it installed. It is loaded by a computed specifier and typed by
// the few calls the bench makes. playwright-core never downloads a browser: it uses the revision
// already in Playwright's cache (webkit-2287 for 1.60.0).

export interface Request { url(): string; method(): string; postDataJSON(): unknown }
export interface Route {
  request(): Request;
  fetch(): Promise<{ text(): Promise<string> }>;
  fulfill(opts: { json?: unknown; status?: number; body?: string; contentType?: string }): Promise<void>;
}
export interface APIResponse { status(): number; headers(): Record<string, string>; json(): Promise<unknown> }
export interface APIRequest { get(url: string): Promise<APIResponse> }
export interface Locator {
  click(opts?: { timeout?: number; modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift"> }): Promise<void>;
  hover(opts?: { timeout?: number }): Promise<void>;
  dblclick(opts?: { timeout?: number }): Promise<void>;
  focus(): Promise<void>;
  fill(text: string, opts?: { timeout?: number }): Promise<void>;
  inputValue(): Promise<string>;
  setInputFiles(files: { name: string; mimeType: string; buffer: Buffer }): Promise<void>;
  press(key: string, opts?: { timeout?: number }): Promise<void>;
  isVisible(): Promise<boolean>;
  count(): Promise<number>;
  selectOption(value: string): Promise<unknown>;
  waitFor(opts?: { state?: "visible" | "attached" | "hidden"; timeout?: number }): Promise<void>;
  first(): Locator;
  last(): Locator;
  nth(index: number): Locator;
  filter(opts: { hasText?: string | RegExp }): Locator;
  innerText(): Promise<string>;
  getAttribute(name: string, opts?: { timeout?: number }): Promise<string | null>;
  scrollIntoViewIfNeeded(): Promise<void>;
  boundingBox(opts?: { timeout?: number }): Promise<{ x: number; y: number; width: number; height: number } | null>;
  evaluateAll<T>(fn: (elements: Element[]) => T): Promise<T>;
  evaluate<T>(fn: (element: Element) => T): Promise<T>;
  allTextContents(): Promise<string[]>;
  locator(selector: string): Locator;
  screenshot(opts: { path?: string; animations?: "disabled" }): Promise<Uint8Array>;
  getByText(text: string | RegExp, opts?: { exact?: boolean }): Locator;
  getByRole(role: string, opts?: { name?: string | RegExp; exact?: boolean }): Locator;
  getByLabel(text: string | RegExp, opts?: { exact?: boolean }): Locator;
}
export interface Page {
  goto(url: string, opts?: { waitUntil?: "load" | "domcontentloaded" }): Promise<unknown>;
  on(event: "request", fn: (req: Request) => void): void;
  screenshot(opts: { path?: string; fullPage?: boolean; animations?: "disabled" | "allow"; clip?: { x: number; y: number; width: number; height: number } }): Promise<Uint8Array>;
  getByText(text: string | RegExp, opts?: { exact?: boolean }): Locator;
  getByRole(role: string, opts?: { name?: string | RegExp; exact?: boolean }): Locator;
  getByPlaceholder(text: string | RegExp): Locator;
  getByLabel(text: string | RegExp, opts?: { exact?: boolean }): Locator;
  locator(selector: string, opts?: { hasText?: string | RegExp }): Locator;
  getByTitle(text: string | RegExp): Locator;
  url(): string;
  waitForURL(url: string, opts?: { timeout?: number }): Promise<void>;
  request: APIRequest;
  evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
  addInitScript<A>(fn: (arg: A) => void, arg: A): Promise<void>;
  clock: { install(opts: { time: number }): Promise<void> };
  route(url: string, handler: (route: Route) => unknown): Promise<void>;
  keyboard: { press(key: string): Promise<void>; type(text: string, opts?: { delay?: number }): Promise<void> };
  touchscreen: { tap(x: number, y: number): Promise<void> };
  mouse: { move(x: number, y: number, opts?: { steps?: number }): Promise<void>; down(): Promise<void>; up(): Promise<void>; wheel(dx: number, dy: number): Promise<void>; click(x: number, y: number): Promise<void> };
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  goBack(): Promise<unknown>;
  reload(): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  waitForFunction<A>(fn: (arg: A) => unknown, arg: A, opts?: { timeout?: number }): Promise<unknown>;
  close(): Promise<void>;
}
export interface Context {
  newPage(): Promise<Page>;
  close(): Promise<void>;
  waitForEvent(event: "page", opts?: { timeout?: number }): Promise<Page>;
  request: APIRequest;
  /** Chromium only. */
  newCDPSession(page: Page): Promise<{ send(method: string, params?: Record<string, unknown>): Promise<unknown> }>;
}
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

/**
 * The installed Google Chrome, headless (`--headless=new --no-sandbox`), driven through
 * playwright-core: for captures meant to match what Chrome draws. $NENU_E2E_CHROME names another binary.
 */
export async function launchChrome(): Promise<Browser> {
  const executablePath = process.env.NENU_E2E_CHROME ?? "/usr/bin/google-chrome";
  if (!existsSync(executablePath)) throw new Error(`no Chrome at ${executablePath}; set NENU_E2E_CHROME`);
  const specifier = "playwright-core";
  const mod = await import(specifier) as { chromium: { launch(opts: Record<string, unknown>): Promise<Browser> } };
  return mod.chromium.launch({ executablePath, headless: true, args: ["--headless=new", "--no-sandbox"] });
}

// NENU_E2E_BROWSER=chromium runs the same flows when the cached WebKit misbehaves on a host. It is a
// fallback for a broken machine, not a substitute: Safari-only bugs only show up under WebKit.
export async function launchWebkit(): Promise<Browser> {
  return launchEngine(process.env.NENU_E2E_BROWSER === "chromium" ? "chromium" : "webkit");
}

/** The cached WebKit or Chromium, for a bench that compares the two engines on the same flow. */
export async function launchEngine(engine: "webkit" | "chromium"): Promise<Browser> {
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

/** What a real session reports through its journal: its model, effort and how full its context is. */
export async function reportModel(page: Page, usedPercent = 11): Promise<void> {
  await page.route("**/api/pane/*/history*", async (route) => {
    const json = JSON.parse(await (await route.fetch()).text()) as Record<string, unknown>;
    if (json.available) json.telemetry = { source: "journal", model: "claude-opus-5-5", effort: "medium", context: { usedTokens: usedPercent * 2_000, windowTokens: 200_000, usedPercent } };
    await route.fulfill({ json });
  });
}

/** In the page: each row under a box that is wider inside than it is drawn, whose controls touch, or whose branch is cut to its icon. */
export function brokenRows(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".composer-meta")).flatMap((meta) => {
    const row = meta.getBoundingClientRect();
    if (row.width === 0) return [];
    const controls = Array.from(meta.querySelectorAll("button")).filter((el) => !el.closest("#composer-chip-panel"))
      .map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0);
    const touch = controls.some((r, i) => controls.some((o, j) => j !== i && r.left < o.right - 1 && r.right > o.left + 1));
    const out = controls.some((r) => r.left < row.left - 1 || r.right > row.right + 1);
    // A branch drawn in the row keeps some of its name: never a bare icon.
    const bare = Array.from(meta.querySelectorAll(".composer-place-branch .truncate")).some((el) => el.getClientRects().length > 0 && el.getBoundingClientRect().width < 24);
    return meta.scrollWidth > meta.clientWidth + 1 || touch || out || bare ? [meta.innerText.replace(/\s+/g, " ")] : [];
  });
}
