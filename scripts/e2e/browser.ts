import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Playwright is a dependency of scripts/e2e only (its own package.json, pinned, 7-day cooldown), so
// the root typecheck must not need it installed. It is loaded by a computed specifier and typed by
// the few calls the bench makes. playwright-core never downloads a browser: it uses the revision
// already in ~/Library/Caches/ms-playwright (webkit-2287 for 1.60.0).

export interface Request { url(): string; method(): string }
export interface Locator {
  click(opts?: { timeout?: number }): Promise<void>;
  fill(text: string, opts?: { timeout?: number }): Promise<void>;
  waitFor(opts?: { state?: "visible" | "attached"; timeout?: number }): Promise<void>;
  first(): Locator;
}
export interface Page {
  goto(url: string, opts?: { waitUntil?: "load" | "domcontentloaded" }): Promise<unknown>;
  on(event: "request", fn: (req: Request) => void): void;
  screenshot(opts: { path?: string; fullPage?: boolean; animations?: "disabled" }): Promise<Uint8Array>;
  getByText(text: string | RegExp, opts?: { exact?: boolean }): Locator;
  getByRole(role: string, opts?: { name?: string | RegExp; exact?: boolean }): Locator;
  getByPlaceholder(text: string | RegExp): Locator;
  locator(selector: string): Locator;
  evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
  addInitScript<A>(fn: (arg: A) => void, arg: A): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
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

function browsersCache(): string {
  return process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), "Library", "Caches", "ms-playwright");
}

export async function launchWebkit(): Promise<Browser> {
  const cache = browsersCache();
  if (!existsSync(cache) || !readdirSync(cache).some((d) => d.startsWith("webkit-"))) {
    throw new Error(`no cached WebKit under ${cache}; this bench never downloads browsers`);
  }
  const specifier = "playwright-core";
  let mod: { webkit: { launch(opts: { headless: boolean }): Promise<Browser> } };
  try {
    mod = await import(specifier);
  } catch {
    throw new Error("playwright-core is not installed: run `bun install` in scripts/e2e");
  }
  return mod.webkit.launch({ headless: true });
}
