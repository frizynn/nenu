// A message with pictures in its places, as a CLI that attaches a pasted image path takes it (ADR 0104).
//
// Claude Code and Codex attach an image when its path arrives as a bracketed paste of its own, and
// draw `[Image #N]` at the cursor. Measured 2026-10-20 in Herdr panes on Claude Code 2.1.304 and Codex
// 0.162.1: typing "first the red one ", pasting the red picture's path alone, typing " then the blue
// one ", pasting the blue one's and typing " and that is all" leaves
//
//     ❯ first the red one [Image #1] then the blue one [Image #2] and that is all       (Claude)
//     › first the red one [Image #1]  then the blue one [Image #2]  and that is all     (Codex)
//
// and each CLI logs the message as the terminal would have sent it: Claude its text with the tokens
// in place and the pictures after, Codex the pictures (`<image name=[Image #1]>`) and then the text.
// Pasted inside a longer paste the same paths are text (Claude splits them onto lines, Codex keeps
// them), and Claude attaches a picture a beat after its paste (150 ms measured): text sent on its heels
// lands before the token. So the bridge types the message piece by piece and waits for each token.

import { isPicturePath } from "../upload-path";

export type SendPiece = { kind: "text"; text: string } | { kind: "image"; path: string };

/** The message cut at its pictures' paths, in order; one text piece when it holds none. */
export function sendPieces(text: string): SendPiece[] {
  const pieces: SendPiece[] = [];
  let words = "";
  for (const part of text.split(/(\s+)/)) {
    if (!isPicturePath(part)) {
      words += part;
      continue;
    }
    if (words) pieces.push({ kind: "text", text: words });
    pieces.push({ kind: "image", path: part });
    words = "";
  }
  if (words) pieces.push({ kind: "text", text: words });
  return pieces;
}

/** Whether a message holds a picture to paste in its place. */
export function hasPlacedPictures(text: string): boolean {
  return sendPieces(text).some((piece) => piece.kind === "image");
}

const TOKEN = /\[Image #\d+\]/g;

/** How many `[Image #N]` the CLI has drawn in its input box. */
export function imageTokens(draft: string | null): number {
  return draft?.match(TOKEN)?.length ?? 0;
}

/** A text without its whitespace: a box wraps, and its reading joins a word cut at the edge with a space. */
export const strip = (s: string) => s.replace(/\s+/g, "");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether the box ends with `path` as text: the CLI kept the pasted path instead of attaching it
 * (Claude 2.1.306 does for a path to no file). The agent reads a path it is given, so the picture
 * still goes, as its path. Whitespace is not compared: a long path wraps.
 */
export function pathShows(draft: string | null, path: string): boolean {
  return draft !== null && strip(draft).endsWith(strip(path));
}

/**
 * Whether the input box shows `sent` typed piece by piece: its words in order, an `[Image #N]` where
 * each picture's path was (or the path itself, when the CLI kept it as text) and nothing else. A
 * piece the CLI may collapse into a paste token of its own matches that token too, from `collapsed`
 * (a whitespace-free regex source, or null when the piece stays literal). Whitespace is not
 * compared: the box wraps, and Codex spaces its tokens.
 */
export function placedPicturesCarrySend(sent: string, draft: string, collapsed: (piece: string) => string | null = () => null): boolean {
  const pieces = sendPieces(sent);
  if (!pieces.some((piece) => piece.kind === "image")) return false;
  let pattern = "";
  for (const piece of pieces) {
    if (piece.kind === "image") {
      pattern += `(?:\\[Image#\\d+\\]|${escape(strip(piece.path))})`;
      continue;
    }
    const literal = strip(piece.text);
    if (!literal) continue;
    const token = collapsed(piece.text);
    pattern += token ? `(?:${escape(literal)}|${token})` : escape(literal);
  }
  return new RegExp(`^${pattern}$`).test(strip(draft));
}

/**
 * Whether the box holds only the start of `sent` as typed piece by piece (its whole, at most): the
 * words in order, each picture as its token or its path. A box that does is Nenu's own typing, so a
 * send that stops before Enter may clear it; anything else may be the operator's and stays.
 */
export function draftIsPartOfSend(sent: string, draft: string | null): boolean {
  const box = strip(draft ?? "");
  if (!box) return false;
  let at = 0;
  for (const piece of sendPieces(sent)) {
    if (at === box.length) return true;
    const rest = box.slice(at);
    const token = piece.kind === "image" ? /^\[Image#\d+\]/.exec(rest)?.[0] : undefined;
    if (token) {
      at += token.length;
      continue;
    }
    const literal = strip(piece.kind === "image" ? piece.path : piece.text);
    if (!rest.startsWith(literal)) return literal.startsWith(rest);
    at += literal.length;
  }
  return at === box.length;
}

// What a CLI draws for something only it holds, without its whitespace: a picture it attached
// (Claude and Codex), a paste it collapsed (Claude's `[Pasted text #N +M lines]`, Codex's
// `[Pasted Content N chars]`).
const CLI_TOKEN = /\[(?:Image#\d+|Pastedtext#\d+[^\]]*|PastedContent\d+chars)\]/;

/**
 * Whether the box holds something only the CLI has, which a copy of its text would not carry. The
 * stranded-draft preview offers no Take over for it, and the bridge never clears it (ADR 0112).
 */
export function holdsCliToken(draft: string): boolean {
  return CLI_TOKEN.test(strip(draft));
}
