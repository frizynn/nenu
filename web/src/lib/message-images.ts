import { filePathsInText } from "./chat-files";
import type { TranscriptEntry, TranscriptImagePart } from "./types";
import { isPicturePath, isUploadPath, uploadName } from "./upload-path";

export { isPicturePath, isUploadPath, uploadName };

// A message that carries images is plain text on the wire: the agent CLIs (Claude Code, Codex) read
// an image by its absolute path, so each uploaded picture's path sits in the text where the operator
// put it, and every other attached file's path goes after the prose. The bridge pastes each picture's
// path on its own, where the CLI draws its `[Image #N]` (ADR 0104). Everything the operator LOOKS at
// shows the images as images, never as paths: a numbered chip in the draft, a picture in its place in
// the conversation, "Image 1", "Image 2", … in alt text and the viewer. These helpers are the one
// place that converts between the shapes.

export const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp)$/i;
/** The CLI's own placeholder (Claude Code, Codex) where it attached a pasted image path. */
const IMAGE_TOKEN = /\[Image #\d+\]/g;

/** A slash command: a message that starts with "/", unless that is the path of a picture it opens with. */
export function isSlashCommand(text: string): boolean {
  return text.startsWith("/") && !isUploadPath(text.split(/\s/, 1)[0]!);
}

function removePaths(text: string, paths: string[]): string {
  let out = text;
  for (const path of paths) out = out.split(path).join("");
  // Removing a path leaves the spaces that separated it; collapse those, keep line breaks.
  return out.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").trim();
}

/** The prose of a message and the image paths it carries, in order, without duplicates. */
export function splitMessageImages(text: string): { text: string; images: string[] } {
  const images = [...new Set(filePathsInText(text).filter((path) => IMAGE_EXTENSION.test(path)))];
  return images.length ? { text: removePaths(text, images), images } : { text, images };
}

/** Nenu's own uploads, of every kind, leave the text — a path the operator typed stays prose. The
 *  wire puts each upload path after a space (serializeMessage), and none holds a space itself. */
export function splitDraftUploads(text: string): { text: string; uploads: string[] } {
  const uploads = [...new Set(text.split(/\s+/).filter(isUploadPath))];
  return uploads.length ? { text: removePaths(text, uploads), uploads } : { text, uploads };
}

/** The wire text: the prose, then every attached file's path, space-separated (what the composer always sent). */
export function serializeMessage(text: string, paths: readonly string[]): string {
  const body = text.trimEnd();
  if (!paths.length) return body;
  return body.trim() ? `${body} ${paths.join(" ")}` : paths.join(" ");
}

/**
 * A comparison key for "is this journal message the one I sent?" — whitespace-insensitive, and blind
 * to whether the harness kept the image paths or swapped them for its own `[Image #N]` tokens.
 */
export function messageMatchKey(text: string): string {
  const { text: prose, images } = splitMessageImages(text);
  const tokens = prose.match(IMAGE_TOKEN)?.length ?? 0;
  return `${prose.replace(IMAGE_TOKEN, " ").replace(/\s+/g, " ").trim()}\u0000${images.length + tokens}`;
}

/** "Image 1", "Image 2", … — numbered per message, the way the agent CLIs label attachments. An image's
 * accessible name and the viewer's title, never a caption printed under its thumbnail. */
export function imageLabel(index: number): string {
  return `Image ${index + 1}`;
}

/** The images an entry holds inline, in journal order (what journal-image numbers by `index`). */
export function journalImages(entry: TranscriptEntry): TranscriptImagePart[] {
  return entry.parts.filter((part): part is TranscriptImagePart => part.kind === "image");
}

// ── The draft ─────────────────────────────────────────────────────────────────────────────────────
//
// In the composer's text a picture is a chip: two blank Braille cells (the slot its icon is drawn in),
// "Image #N" and a word joiner that ends it without taking room. None of them is a character anyone
// types, a place a line breaks, or whitespace, so no trim() can take a piece of a chip at either end.
// N counts the draft's pictures in the order they were attached, as the thumbnails above the text do.

/** A chip's blank cell (its icon's slot is two) and its end: characters nobody types. */
const CELL = "\u2800";
const END = "\u2060";
const CHIP = new RegExp(`${CELL}${CELL}Image\u00a0#(\\d+)${END}`, "g");

/** The chip for the draft's picture number `n` (from 1). */
export function imageChip(n: number): string {
  return `${CELL}${CELL}Image\u00a0#${n}${END}`;
}

export interface DraftChip { number: number; start: number; end: number }

/** Every chip in a draft's text, in reading order. */
export function draftChips(text: string): DraftChip[] {
  return [...text.matchAll(CHIP)].map((m) => ({ number: Number(m[1]), start: m.index, end: m.index + m[0].length }));
}

/** The words of a draft, without its chips: what was typed. */
export function draftWords(text: string): string {
  return text.replace(CHIP, "");
}

/** The text with the pictures numbered in `gone` taken out, and the ones after them renumbered. */
export function withoutImages(text: string, gone: readonly number[]): string {
  if (!gone.length) return text;
  let out = "";
  let at = 0;
  for (const chip of draftChips(text)) {
    out += text.slice(at, chip.start);
    at = chip.end;
    if (!gone.includes(chip.number)) out += imageChip(chip.number - gone.filter((g) => g < chip.number).length);
    // A chip that leaves from between two spaces takes one of them, so the words close up.
    else if (out.endsWith(" ") && text[at] === " ") at++;
  }
  return out + text.slice(at);
}

/**
 * Keep every chip whole across one edit of the box. An edit that touches a chip anywhere (a Backspace
 * at its end, a selection across it, a letter typed inside it) takes the chip out entirely, and its
 * picture with it: the remnant leaves the text, `removed` names the picture and the caller drops it
 * from the attachments and renumbers. `caret` is where the edit left the cursor, moved for what left.
 */
export function keepChipsWhole(before: string, after: string, caret: number): { text: string; removed: number[]; caret: number } {
  const chips = draftChips(before);
  if (!chips.length) return { text: after, removed: [], caret };
  // The smallest edit that turns `before` into `after`, placed where the cursor says it ended. Two chips
  // share their first characters, so a plain prefix/suffix diff can place a deletion inside the wrong
  // one; the cursor tells them apart. A cursor that would make the edit any larger is ignored.
  const span = (start: number, tail: number) => before.length - tail - start;
  const prefix = (limit: number) => {
    let n = 0;
    while (n < limit && before[n] === after[n]) n++;
    return n;
  };
  let tail = 0;
  while (tail < before.length && tail < after.length && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  let start = prefix(Math.min(before.length, after.length) - tail);
  const anchored = after.length - caret;
  if (anchored >= 0 && anchored <= Math.min(before.length, after.length) && before.endsWith(after.slice(caret))) {
    const at = prefix(Math.min(before.length, after.length) - anchored);
    if (span(at, anchored) === span(start, tail)) [start, tail] = [at, anchored];
  }
  const end = before.length - tail; // the edit replaced before[start, end) …
  const inserted = after.length - tail; // … with after[start, inserted)
  const touched = chips.filter((chip) => (end > start ? chip.start < end && chip.end > start : chip.start < start && start < chip.end));
  if (!touched.length) return { text: after, removed: [], caret };
  // Cut what is left of each touched chip, back to front so earlier offsets hold.
  const cuts: Array<[number, number]> = [];
  for (const chip of touched) {
    if (chip.start < start) cuts.push([chip.start, Math.min(chip.end, start)]);
    if (chip.end > end) cuts.push([inserted + Math.max(0, chip.start - end), inserted + (chip.end - end)]);
  }
  let text = after;
  let moved = caret;
  for (const [from, to] of cuts.sort((x, y) => y[0] - x[0])) {
    text = text.slice(0, from) + text.slice(to);
    if (caret > from) moved -= Math.min(caret, to) - from;
  }
  const removed = touched.map((chip) => chip.number);
  // Renumber what stays: the cut chips are gone already, so only the numbers after them shift (and
  // "#10" turning "#9" moves the cursor with it).
  return { text: withoutImages(text, removed), removed, caret: withoutImages(text.slice(0, moved), removed).length };
}

/**
 * Chips that name no picture leave the text: a number past the `count` pictures, or a second chip
 * for the same picture (chip text pasted back in, or brought back by undo). The first chip for a
 * number keeps it. A chip's own characters outside a whole chip leave too: nobody types them.
 */
export function dropStrayChips(text: string, count: number, caret: number): { text: string; caret: number } {
  let out = "";
  let moved = caret;
  /** Words between chips, without a chip's own characters cut loose from one (a partial copy pasted). */
  const words = (from: number, to: number) => {
    for (let i = from; i < to; i++) {
      if (text[i] === CELL || text[i] === END) {
        if (caret > i) moved--;
      } else out += text[i];
    }
  };
  let at = 0;
  const seen = new Set<number>();
  for (const chip of draftChips(text)) {
    words(at, chip.start);
    at = chip.end;
    if (chip.number <= count && !seen.has(chip.number)) {
      seen.add(chip.number);
      out += text.slice(chip.start, chip.end);
    } else if (caret > chip.start) moved -= Math.min(caret, chip.end) - chip.start;
  }
  words(at, text.length);
  return { text: out, caret: moved };
}

/**
 * One edit of a draft holding `count` pictures, with every chip kept whole and naming exactly one
 * picture: `removed` are the pictures whose chips the edit took (renumbered already in `text`).
 */
export function editChips(before: string, after: string, caret: number, count: number): { text: string; removed: number[]; caret: number } {
  const kept = keepChipsWhole(before, after, caret);
  const clean = dropStrayChips(kept.text, count - kept.removed.length, kept.caret);
  return { ...clean, removed: kept.removed };
}

/** Chips for newly attached pictures, put into `text` at `at`. A chip pads itself on screen, and the
 *  wire sets each path off by whitespace (serializeDraft), so no space is added around them. */
export function insertImageChips(text: string, at: number, numbers: readonly number[]): { text: string; caret: number } {
  // A stale cursor inside a chip goes to its end, so a chip never splits another.
  at = draftChips(text).find((chip) => chip.start < at && at < chip.end)?.end ?? Math.min(at, text.length);
  const chips = numbers.map(imageChip).join(" ");
  return { text: text.slice(0, at) + chips + text.slice(at), caret: at + chips.length };
}

/**
 * The draft as the wire text: each chip becomes its picture's path where it sits, set off by
 * whitespace; a chip whose picture has no path yet (still uploading) leaves nothing. A picture no
 * chip names, and every other file, goes after the prose. `images[n - 1]` is picture n's path.
 */
export function serializeDraft(text: string, images: readonly (string | null)[], files: readonly string[] = []): string {
  const placed = new Set<number>();
  const body = text.replace(CHIP, (_chip, n: string, offset: number) => {
    const path = images[Number(n) - 1];
    if (!path) return "";
    placed.add(Number(n));
    const lead = offset === 0 || /\s/.test(text[offset - 1]!) ? "" : " ";
    const next = text[offset + _chip.length];
    return lead + path + (next === undefined || /\s/.test(next) ? "" : " ");
  });
  const loose = images.filter((path, i): path is string => !!path && !placed.has(i + 1));
  return serializeMessage(body, [...loose, ...files]);
}

/**
 * A wire text back into a draft: each of Nenu's picture uploads becomes a chip where it sits, and
 * every other upload leaves the text. A picture already in `known` keeps its number; a new one is
 * numbered after them. `images` is `known` plus the new pictures, in number order.
 */
export function draftFromWire(wire: string, known: readonly string[] = []): { text: string; images: string[]; files: string[] } {
  const images = [...known];
  const files: string[] = [];
  const parts = wire.split(/(\s+)/).map((part) => {
    if (!isUploadPath(part)) return part;
    if (!isPicturePath(part)) {
      if (!files.includes(part)) files.push(part);
      return "";
    }
    let n = images.indexOf(part) + 1;
    if (n === 0) n = images.push(part);
    return imageChip(n);
  });
  const text = files.length ? removePaths(parts.join(""), []) : parts.join("").trim();
  return { text, images, files };
}

// ── A sent message, in its places ─────────────────────────────────────────────────────────────────

/** A message cut where its pictures are: words, or the message's picture at `image` (from 0). */
export type MessagePiece = { kind: "text"; text: string } | { kind: "image"; image: number };

function cut(text: string, marks: ReadonlyArray<{ start: number; end: number }>): MessagePiece[] {
  const pieces: MessagePiece[] = [];
  let at = 0;
  marks.forEach((mark, image) => {
    const words = text.slice(at, mark.start);
    if (words.trim()) pieces.push({ kind: "text", text: words.trim() });
    pieces.push({ kind: "image", image });
    at = mark.end;
  });
  const rest = text.slice(at);
  if (rest.trim()) pieces.push({ kind: "text", text: rest.trim() });
  return pieces;
}

/**
 * A message as the CLI logged it, cut at its `[Image #N]` tokens: the k-th token is the message's
 * k-th picture, whatever N says (Claude numbers per session, Codex per message). Tokens past the
 * pictures stay words; pictures past the tokens are the caller's to show after.
 */
export function tokenPieces(text: string, images: number): MessagePiece[] {
  const marks = [...text.matchAll(IMAGE_TOKEN)].slice(0, images).map((m) => ({ start: m.index, end: m.index + m[0].length }));
  return cut(text, marks);
}

/** A wire text cut at the paths of Nenu's picture uploads (what the bridge pastes in place), and those paths in order. */
export function pathPieces(text: string): { pieces: MessagePiece[]; paths: string[] } {
  const paths: string[] = [];
  const marks: Array<{ start: number; end: number }> = [];
  for (const m of text.matchAll(/\S+/g)) {
    if (!isPicturePath(m[0])) continue;
    paths.push(m[0]);
    marks.push({ start: m.index, end: m.index + m[0].length });
  }
  return { pieces: cut(text, marks), paths };
}
