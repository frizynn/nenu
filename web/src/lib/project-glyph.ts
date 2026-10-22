// A project's mark: one of 24 line-and-dot glyphs on a 16px grid, in one of 10 hues, picked by FNV-1a
// of its slug unless the project picked its own in Organizations. The same project draws the same mark
// on every device and after every reload, with nothing stored. The hues are theme tokens
// (`--glyph-<hue>` in index.css), so a mark follows the theme with no JavaScript.

/** One glyph as at most three paths: the 1.4px lines, the filled dots, and a dashed line. */
export interface Glyph {
  stroke: string;
  fill: string;
  dash?: string;
}

const round = (n: number) => +n.toFixed(3);
/** A filled dot as two arcs, so every dot of a glyph shares one path. */
const dot = (x: number, y: number, r = 1) => `M${round(x - r)} ${y}a${r} ${r} 0 1 0 ${round(2 * r)} 0a${r} ${r} 0 1 0 ${round(-2 * r)} 0z`;
const dots = (...at: Array<[number, number, number?]>) => at.map(([x, y, r]) => dot(x, y, r)).join("");
/** `n` dots on a circle of radius `r` round the centre, the first at `start` degrees. */
const ring = (n: number, r: number, size: number, start = -90) =>
  dots(...Array.from({ length: n }, (_, i): [number, number, number] => {
    const angle = ((start + (360 / n) * i) * Math.PI) / 180;
    return [+(8 + r * Math.cos(angle)).toFixed(2), +(8 + r * Math.sin(angle)).toFixed(2), size];
  }));

const DRAWN = {
  scatter: { stroke: "", fill: dots([4, 3.5, 1.15], [8, 3.5, 1.15], [4, 8, 1.15], [12, 8, 1.15], [8, 12.5, 1.15], [12, 12.5, 1.15]) },
  trio: { stroke: "M2.8 3h4.4L5 6.4zM8.8 3h4.4L11 6.4zM3 9l3.2 2L3 13z", fill: dots([10, 11, 0.9], [13, 11, 0.9], [11.5, 13.6, 0.9]) },
  globe: { stroke: "M8 2a6 6 0 0 0 0 12M8 2c-2.2 1.8-2.2 10.2 0 12M2.2 8H8", fill: dots([11, 2.8, 0.85], [13.2, 5, 0.85], [14, 8, 0.85], [13.2, 11, 0.85], [11, 13.2, 0.85], [11, 8, 0.85]) },
  window: { stroke: "M4 3h8a2 2 0 0 1 2 2v4.5M14 12.6V13H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2M2 6.2h12", fill: dot(12.6, 12, 2.1) },
  orbitcheck: { stroke: "M5.4 8.3l1.8 1.8 3.3-3.7", fill: "", dash: "M14 8a6 6 0 1 1-12 0 6 6 0 1 1 12 0" },
  smile: { stroke: "M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0zM5.7 9.7c1.3 1.4 3.3 1.4 4.6 0", fill: dots([6, 6.9, 0.9], [10, 6.9, 0.9]) },
  arrow: { stroke: "M3.4 5.5v5M6.4 5.5h3.4L13.6 8l-3.8 2.5H6.4z", fill: dot(1.4, 8, 0.75) },
  bolt: { stroke: "M9.2 1.8 4 9h4l-1.2 5.2L12 7H8z", fill: "" },
  leaf: { stroke: "M3 13C3 7 7 3 13 3c0 6-4 10-10 10zM3 13 8.5 7.5", fill: dots([10.6, 8.6, 0.8], [7.4, 5.4, 0.8]) },
  wave: { stroke: "M1.8 10c2-3 4.1-3 6.2 0s4.1 3 6.2 0", fill: dots([4, 4.4, 0.95], [8, 4.4, 0.95], [12, 4.4, 0.95]) },
  stack: { stroke: "M2 6l6-3.2L14 6 8 9.2zM2 9.4l6 3.2 6-3.2", fill: dot(8, 14.4, 0.8) },
  diamond: { stroke: "M8 1.8 14.2 8 8 14.2 1.8 8z", fill: dot(8, 8, 1.5) },
  orbit: { stroke: "M10.6 8a2.6 2.6 0 1 1-5.2 0 2.6 2.6 0 0 1 5.2 0z", fill: ring(6, 6, 0.9, -60) },
  matrix: { stroke: "", fill: dots(...[3.5, 8, 12.5].flatMap((y) => [3.5, 8, 12.5].map((x): [number, number, number] => [x, y, x === 8 && y === 8 ? 1.9 : 1]))) },
  spark: { stroke: "M8 1.8c.5 3.4 2.8 5.7 6.2 6.2-3.4.5-5.7 2.8-6.2 6.2-.5-3.4-2.8-5.7-6.2-6.2 3.4-.5 5.7-2.8 6.2-6.2z", fill: "" },
  flag: { stroke: "M3.5 14.2V2.4M3.5 3h8.4l-2 3 2 3H3.5", fill: dot(13.2, 12.4, 0.85) },
  key: { stroke: "M7.6 8a2.6 2.6 0 1 1-5.2 0 2.6 2.6 0 0 1 5.2 0zM7.6 8H14M12.2 8v2.4M10 8v1.6", fill: "" },
  cube: { stroke: "M8 1.8l5.6 3.1v6.2L8 14.2l-5.6-3.1V4.9zM2.6 5 8 8l5.4-3M8 8v6", fill: "" },
  peak: { stroke: "M1.8 13.2 6.2 5.6l2.6 4.4 1.8-2.8 3.6 6z", fill: dot(11.8, 3.4, 0.95) },
  moon: { stroke: "M13.2 9.6A5.6 5.6 0 1 1 6.4 2.8a4.4 4.4 0 0 0 6.8 6.8z", fill: dots([11.4, 3.2, 0.85], [13.6, 5.6, 0.65]) },
  drop: { stroke: "M8 1.9s4.6 4.6 4.6 7.7a4.6 4.6 0 0 1-9.2 0C3.4 6.5 8 1.9 8 1.9z", fill: dot(6.4, 10.2, 0.85) },
  prompt: { stroke: "M2.8 4.4 6.4 8l-3.6 3.6M8.6 11.6H13.4", fill: dot(13.4, 4.4, 0.85) },
  braces: {
    stroke: "M5.6 2.4c-1.4 0-2 .7-2 2v1.4c0 1.1-.6 2.2-1.6 2.2 1 0 1.6 1.1 1.6 2.2v1.4c0 1.3.6 2 2 2M10.4 2.4c1.4 0 2 .7 2 2v1.4c0 1.1.6 2.2 1.6 2.2-1 0-1.6 1.1-1.6 2.2v1.4c0 1.3-.6 2-2 2",
    fill: dot(8, 8, 0.95),
  },
  sun: { stroke: "M10.5 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z", fill: ring(8, 5.9, 0.85) },
} satisfies Record<string, Glyph>;

export type GlyphName = keyof typeof DRAWN;
export const GLYPHS: Record<GlyphName, Glyph> = DRAWN;
export const GLYPH_NAMES = Object.keys(GLYPHS) as GlyphName[];

/** The hues in pick order; each is a `--glyph-<hue>` token tuned per theme for 3:1 on every ground. */
export const HUE_NAMES = ["red", "orange", "amber", "green", "teal", "blue", "indigo", "violet", "pink", "slate"] as const;
export type HueName = (typeof HUE_NAMES)[number];

/** Red and amber say "needs you" and "working" everywhere else, so only a project's own pick draws them. */
const STATE_HUES: ReadonlySet<HueName> = new Set(["red", "amber"]);
const HASHED_HUES = HUE_NAMES.filter((hue) => !STATE_HUES.has(hue));
/** The hues a coordinator's mark can be picked in: never red or amber, so a state keeps its colour (ADR 0122). */
export const MARK_HUES: readonly HueName[] = HASHED_HUES;

const utf8 = new TextEncoder();

/** FNV-1a over the text's UTF-8 bytes, 32 bits unsigned. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of utf8.encode(text)) hash = Math.imul(hash ^ byte, 0x01000193);
  return hash >>> 0;
}

/** The glyph and hue a project picked in Organizations (its `icon` and `tone`), empty when it picked none. */
export interface MarkPick {
  icon?: string;
  tone?: string;
}

export const isGlyph = (name: string | undefined): name is GlyphName => !!name && Object.hasOwn(GLYPHS, name);
export const isHue = (name: string | undefined): name is HueName => (HUE_NAMES as readonly string[]).includes(name ?? "");

/**
 * A project's mark: what it picked, where Nenu draws that name; otherwise its slug's. The hash's low
 * bits pick the glyph and the byte above them the hue. A slug landing on red or amber takes another hue
 * from the byte after, so every other project keeps the colour it always had.
 */
export function projectMark(slug: string, pick: MarkPick = {}): { glyph: GlyphName; hue: HueName } {
  const hash = fnv1a(slug);
  const landed = HUE_NAMES[(hash >>> 8) % HUE_NAMES.length]!;
  const hashed = STATE_HUES.has(landed) ? HASHED_HUES[(hash >>> 16) % HASHED_HUES.length]! : landed;
  return {
    glyph: isGlyph(pick.icon) ? pick.icon : GLYPH_NAMES[hash % GLYPH_NAMES.length]!,
    hue: isHue(pick.tone) ? pick.tone : hashed,
  };
}
