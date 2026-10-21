import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// Two contracts the screen can't show in a test run. Every icon draws through components/ui/icon, so
// the set changes in one file; and nothing in Nenu animates forever: a state that lasts (working,
// busy, sending, loading) is a still glyph, and motion only answers a tap and ends. A spinner left on
// for a whole turn cost about 1 s of CPU every 30 s on the bench (2026-10-15 audit). One exception,
// asked for by the operator (ADR 0117): the glow across a running turn's live line, which moves by
// transform alone, in steps, and is in the page only while it is on screen on a shown page.

const src = import.meta.dirname;
const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) return sources(path);
  return /\.(tsx?|css)$/.test(entry.name) && !entry.name.includes(".test.") ? [path] : [];
});
const files = sources(src).map((path) => ({ path: relative(src, path), text: readFileSync(path, "utf8") }));
const offenders = (pattern: RegExp) => files.filter((f) => pattern.test(f.text)).map((f) => f.path);

it("draws every icon through the facade, with no icon package behind it", () => {
  const pkg = ["lucide", "react"].join("-");
  expect(offenders(new RegExp(`from "${pkg}"`))).toEqual([]);
  const manifest = JSON.parse(readFileSync(join(src, "../package.json"), "utf8"));
  expect(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter((name) => /icon|lucide/.test(name))).toEqual([]);
});

it("runs no animation forever but the live line's glow, and that one moves only a composited layer", () => {
  expect(offenders(/\binfinite\b/)).toEqual(["index.css"]);
  expect(offenders(/\banimate-(spin|pulse|ping|bounce)\b/)).toEqual([]);
  const css = code(files.find((f) => f.path === "index.css")!.text);
  const forever = [...css.matchAll(/^\s*\.([\w-]+)\s*\{[^}]*\binfinite\b[^}]*\}/gm)].map((m) => m[1]);
  expect(forever).toEqual(["glow-window", "glow-copy"]);
  for (const name of ["glow-window", "glow-copy"]) {
    const frames = new RegExp(`@keyframes ${name} \\{([^@]*?)\\}\\s*(?=@|\\.|$)`).exec(css)?.[1] ?? "";
    expect(frames.match(/\b[a-z-]+(?=\s*:)/g)).toEqual(["transform", "transform"]);
    expect(css).toMatch(new RegExp(`\\.${name} \\{[^}]*steps\\(30\\)`));
  }
  // Only the glow draws them, and only while it may move (work-activity-label.tsx).
  expect(offenders(/glow-window/).filter((path) => path !== "index.css")).toEqual(["components/work-activity-label.tsx"]);
});

// One set of lengths and one curve (index.css --motion-*): a control 120 ms, a panel 180 ms, a page
// 280 ms, all on cubic-bezier(0.2, 0, 0, 1). A stylesheet names the token; a component takes Tailwind's
// duration-120/180/280 and ease-out, which index.css points at the same tokens.
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

it("moves in the shared lengths and curve", () => {
  const tokens = /--motion-[a-z]+:[^;]*;/g;
  const css = files.filter((f) => f.path.endsWith(".css"));
  expect(css.flatMap((f) => [...code(f.text).replace(tokens, "").matchAll(/\b(?!0m?s\b)\d+m?s\b|cubic-bezier\([^)]*\)|(?<![\w-])ease(-in|-out|-in-out)?\b|(?<![\w-])linear\b(?!-gradient)/g)]
    .map((m) => `${f.path}: ${m[0]}`))).toEqual([]);
  const tsx = files.filter((f) => /\.tsx?$/.test(f.path));
  expect(tsx.flatMap((f) => [...code(f.text).matchAll(/\bduration-(?!(120|180|280)\b)[\w[\]]+|\bease-(in|in-out|linear|\[)[^\s"]*/g)]
    .map((m) => `${f.path}: ${m[0]}`))).toEqual([]);
});

it("keeps the script's motion constants equal to the stylesheet's tokens", async () => {
  const motion = await import("./lib/motion");
  const root = readFileSync(join(src, "index.css"), "utf8");
  expect(root).toContain(`--motion-control: ${motion.MOTION_CONTROL_MS}ms;`);
  expect(root).toContain(`--motion-panel: ${motion.MOTION_PANEL_MS}ms;`);
  expect(root).toContain(`--motion-ease: ${motion.MOTION_EASE};`);
});

it("times a script's exit or arrival by the shared lengths", () => {
  // A timer that unmounts a layer once its CSS motion ends must last exactly as long as that motion;
  // a literal drifts the day the token moves (FOLD_OPEN_MS stayed 220 against a 180 fold). A
  // gesture's own physics (image-viewer's double tap and hand-off) is not a token's to set.
  const tsx = files.filter((f) => /\.tsx?$/.test(f.path));
  expect(tsx.flatMap((f) => [...code(f.text).matchAll(/\bconst \w*_(OPEN|SHUT|EXIT|ENTER|FADE|SLIDE)_MS = \d+/g)].map((m) => `${f.path}: ${m[0]}`))).toEqual([]);
  expect(tsx.flatMap((f) => [...code(f.text).matchAll(/reducedMotion\(\) \? \d+ : \d+/g)].map((m) => `${f.path}: ${m[0]}`))).toEqual([]);
});
