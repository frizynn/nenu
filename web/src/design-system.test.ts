import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { META_COLOR } from "./hooks/use-theme";
import { HUE_NAMES } from "./lib/project-glyph";
import { TYPE_SCALE } from "./lib/utils";
import { cssRules, declarations } from "./test/css-rules";

// The design tokens' contracts that fail silently: a text tone mixed with transparent (it measured
// 3.16:1 in light), a browser chrome colour that drifts from the page, type sizes that ignore the
// browser's text size, and the loading strip drawn under the iPhone's status bar. The bench measures
// the rendered result; these keep the source from sliding back.

const src = import.meta.dirname;
const read = (path: string) => readFileSync(resolve(src, path), "utf8");
const indexCss = read("index.css");

function filesEndingIn(dir: string, ext: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesEndingIn(path, ext);
    return entry.name.endsWith(ext) && !entry.name.includes(".test.") ? [path] : [];
  });
}
const stylesheets = (dir: string) => filesEndingIn(dir, ".css");

const root = declarations(indexCss, ":root");

/** `--name: light-dark(<light>, <dark>)` from index.css, as the two hex halves. */
function themed(name: string): [string, string] {
  const match = root[`--${name}`]?.match(/^light-dark\((#[0-9a-f]{3,6}), (#[0-9a-f]{3,6})\)$/i);
  if (!match) throw new Error(`--${name} is not a light-dark() pair of hex colours`);
  return [match[1]!.toLowerCase(), match[2]!.toLowerCase()];
}

function luminance(hex: string): number {
  const full = hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join("")}` : hex;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(full.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** `--name: light-dark(<light>, <dark>)` from index.css, either half hex or `oklch(L C H)`, both as hex. */
function themedColor(name: string): [string, string] {
  const match = root[`--${name}`]?.match(/^light-dark\((#[0-9a-f]{3,6}|oklch\([^)]*\)), (#[0-9a-f]{3,6}|oklch\([^)]*\))\)$/i);
  if (!match) throw new Error(`--${name} is not a light-dark() pair of hex or oklch colours`);
  return [toHex(match[1]!), toHex(match[2]!)];
}

/** An `oklch(L C H)` colour as sRGB hex (Björn Ottosson's OKLab matrices), clipped to the gamut. */
function toHex(color: string): string {
  const parts = color.match(/^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/);
  if (!parts) return color.toLowerCase();
  const [l, c, h] = parts.slice(1).map(Number) as [number, number, number];
  const a = c * Math.cos((h * Math.PI) / 180), b = c * Math.sin((h * Math.PI) / 180);
  const [L, M, S] = [l + 0.3963377774 * a + 0.2158037573 * b, l - 0.1055613458 * a - 0.0638541728 * b, l - 0.0894841775 * a - 1.291485548 * b].map((v) => v ** 3) as [number, number, number];
  const linear = [4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S, -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S, -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S];
  return "#" + linear.map((v) => Math.min(1, Math.max(0, v))).map((v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055))
    .map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
}

const GROUNDS = ["background", "card", "popover", "workbench-sidebar"] as const;

describe("text colour", () => {
  it("never takes a tone from alpha in a stylesheet", () => {
    const offenders = stylesheets(src).flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/(?:^|[;{\s])color:\s*([^;}]*)/g)]
        .filter((m) => /color-mix\(.*transparent/.test(m[1]!))
        .map((m) => `${relative(src, file)}: color: ${m[1]!.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it("has a solid tertiary tone that clears 4.5:1 on the page, a card and the sidebar in both themes", () => {
    const subtle = themed("subtle-foreground");
    for (const ground of ["background", "card", "workbench-sidebar"]) {
      const halves = themed(ground);
      halves.forEach((bg, i) => expect(contrast(subtle[i]!, bg), `${ground} ${i ? "dark" : "light"}`).toBeGreaterThanOrEqual(4.5));
    }
  });
});

describe("surfaces", () => {
  // The Cursor-style board's tokens sheet: three steps of grey under the content (sidebar, page,
  // raised) and a floating layer, in each theme.
  it("steps the grounds as the board does: sidebar, page, raised and floating", () => {
    expect(themed("workbench-sidebar")).toEqual(["#f1f1f1", "#0f0f10"]);
    expect(themed("background")).toEqual(["#f7f7f7", "#161617"]);
    expect(themed("card")).toEqual(["#fdfdfd", "#1e1e20"]);
    expect(themed("popover")).toEqual(["#fff", "#232325"]);
  });

  it("keeps the text ladder at least as legible on the page as the board measured it", () => {
    const floors = { foreground: [15.7, 15.4], "muted-foreground": [6.9, 8.7], "subtle-foreground": [4.9, 5.5] };
    const page = themed("background");
    for (const [token, [light, dark]] of Object.entries(floors)) {
      const tone = themed(token);
      expect(contrast(tone[0], page[0]), `${token} light`).toBeGreaterThanOrEqual(light!);
      expect(contrast(tone[1], page[1]), `${token} dark`).toBeGreaterThanOrEqual(dark!);
    }
  });

  it("keeps links, status words and the error tone at 4.5:1 on every ground, and the label on a primary fill too", () => {
    for (const token of ["primary", "destructive", "status-blocked", "status-working", "status-done", "status-idle", "status-unknown"]) {
      const tone = themedColor(token);
      for (const ground of GROUNDS) {
        themed(ground).forEach((bg, i) => expect(contrast(tone[i]!, bg), `${token} on ${ground} ${i ? "dark" : "light"}`).toBeGreaterThanOrEqual(4.5));
      }
    }
    const fill = themedColor("primary");
    const label = themed("primary-foreground");
    fill.forEach((bg, i) => expect(contrast(label[i]!, bg), `primary-foreground ${i ? "dark" : "light"}`).toBeGreaterThanOrEqual(4.5));
  });

  it("draws every project hue at 3:1 on every ground a project's glyph sits on", () => {
    for (const hue of HUE_NAMES) {
      const tone = themedColor(`glyph-${hue}`);
      for (const ground of GROUNDS) {
        themed(ground).forEach((bg, i) => expect(contrast(tone[i]!, bg), `${hue} on ${ground} ${i ? "dark" : "light"}`).toBeGreaterThanOrEqual(3));
      }
    }
  });
});

describe("radii", () => {
  it("takes every radius in the app's own stylesheets from the scale, or a pill or circle, or none edge to edge", () => {
    const files = [resolve(src, "index.css"), resolve(src, "workbench.css"), resolve(src, "components/file-preview.css"), ...stylesheets(resolve(src, "styles"))];
    const offenders = files.flatMap((file) =>
      cssRules(readFileSync(file, "utf8"))
        .filter((rule) => rule.decls["border-radius"] && !/^(0|var\(--radius-(sm|md|lg|xl|2xl)\)|9999px|50%)$/.test(rule.decls["border-radius"]))
        .map((rule) => `${relative(src, file)}: ${rule.selectors.join(", ")} { border-radius: ${rule.decls["border-radius"]} }`),
    );
    expect(offenders).toEqual([]);
  });
});

describe("type scale", () => {
  it("defines every step in rem, so the browser's text size scales it", () => {
    // The same list teaches cn() the scale (lib/utils.ts), so a step added here merges too.
    for (const step of TYPE_SCALE) {
      expect(indexCss, step).toMatch(new RegExp(`--text-${step}:\\s*[\\d.]+rem;`));
    }
  });

  it("gives a coarse pointer its own variant", () => {
    expect(indexCss).toMatch(/@custom-variant coarse \(@media \(pointer: coarse\)\);/);
  });
});

describe("chrome", () => {
  it("paints the browser bar and the boot splash with the page's own background", () => {
    const [light, dark] = themed("background");
    const html = read("../index.html");
    expect(html).toContain(`<meta name="theme-color" content="${light}" media="(prefers-color-scheme: light)" />`);
    expect(html).toContain(`<meta name="theme-color" content="${dark}" media="(prefers-color-scheme: dark)" />`);
    expect(html).toMatch(new RegExp(`\\.boot-splash \\{[^}]*background: light-dark\\(${light}, ${dark}\\)`));
  });

  it("keeps the browser bar on the page's background after load, when useTheme rewrites the metas", () => {
    const [light, dark] = themed("background");
    expect(META_COLOR).toEqual({ light, dark });
  });

  it("gives every header the status bar's surface, mixed from the page background", () => {
    expect(root["--chrome"]).toMatch(/^color-mix\(in oklab, var\(--background\) /);
    expect(declarations(read("workbench.css"), ".workbench-app-header").background).toBe("var(--chrome)");
  });

  it("starts the loading strip under the status bar, not behind it", () => {
    expect(declarations(indexCss, ".busy-bar").top).toBe("calc(var(--app-viewport-top, 0px) + env(safe-area-inset-top, 0px))");
  });

  it("keeps one focus ring: a 2px outline 2px out", () => {
    const focus = cssRules(indexCss).find((rule) => rule.atRules.join() === "@layer base" && rule.selectors.some((s) => s.endsWith(":focus-visible") && s.includes("button")));
    expect(focus?.decls).toMatchObject({ outline: "2px solid var(--ring)", "outline-offset": "2px" });
  });

  it("never lets a control that styles its own focus drop the ring without drawing one", () => {
    // The shared ring lives in @layer base, so a focus-visible:outline-none utility beats it. A
    // control that restyles its focus (a tint, a border) and drops the outline must draw a ring, or a
    // keyboard user tabbing to it sees nothing: the busy-send rows' tint measured 1.09:1 on the card.
    const offenders = filesEndingIn(src, ".tsx").flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/"([^"\n]*)"|`([^`]*)`/g)]
        .map((m) => m[1] ?? m[2]!)
        .filter((classes) => /\boutline-none\b/.test(classes) && /\bfocus-visible:(?!outline)/.test(classes) && !/\bfocus-visible:ring/.test(classes))
        .map((classes) => `${relative(src, file)}: ${classes}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe("hover", () => {
  it("fills a control on hover only where a pointer hovers, so a tap on a phone leaves nothing lit", () => {
    // A touch browser keeps :hover on whatever a finger tapped until the next tap: the drawer's Search
    // opened with its button still filled. Tailwind's hover: variant already sits behind
    // @media (hover: hover); the app's own stylesheets put theirs there too. `:not(:hover)` only takes
    // a fill away, so it needs no guard.
    const files = [resolve(src, "index.css"), resolve(src, "workbench.css"), resolve(src, "components/file-preview.css"), ...stylesheets(resolve(src, "styles"))];
    const offenders = files.flatMap((file) =>
      cssRules(readFileSync(file, "utf8"))
        .filter((rule) => rule.selectors.some((s) => s.replace(/:not\(:hover\)/g, "").includes(":hover")))
        .filter((rule) => !rule.atRules.some((at) => /\(hover: hover\)/.test(at)))
        .map((rule) => `${relative(src, file)}: ${rule.selectors.join(", ")}`),
    );
    expect(offenders).toEqual([]);
  });
});
