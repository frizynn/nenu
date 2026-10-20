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

import { isUploadPath, uploadName } from "../message-images";

export type SendPiece = { kind: "text"; text: string } | { kind: "image"; path: string };

/** A picture Nenu uploaded: an upload whose generated name is its image bytes' (bridge/uploads.ts). */
function isPicture(word: string): boolean {
  return isUploadPath(word) && uploadName(word) === null;
}

/** The message cut at its pictures' paths, in order; one text piece when it holds none. */
export function sendPieces(text: string): SendPiece[] {
  const pieces: SendPiece[] = [];
  let words = "";
  for (const part of text.split(/(\s+)/)) {
    if (!isPicture(part)) {
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

const strip = (s: string) => s.replace(/\s+/g, "");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether the input box shows `sent` typed piece by piece: its words in order, an `[Image #N]` where
 * each picture's path was and nothing else. A piece the CLI may collapse into a paste token of its
 * own matches that token too, from `collapsed` (a whitespace-free regex source, or null when the
 * piece stays literal). Whitespace is not compared: the box wraps, and Codex spaces its tokens.
 */
export function placedPicturesCarrySend(sent: string, draft: string, collapsed: (piece: string) => string | null = () => null): boolean {
  const pieces = sendPieces(sent);
  if (!pieces.some((piece) => piece.kind === "image")) return false;
  let pattern = "";
  for (const piece of pieces) {
    if (piece.kind === "image") {
      pattern += "\\[Image#\\d+\\]";
      continue;
    }
    const literal = strip(piece.text);
    if (!literal) continue;
    const token = collapsed(piece.text);
    pattern += token ? `(?:${escape(literal)}|${token})` : escape(literal);
  }
  return new RegExp(`^${pattern}$`).test(strip(draft));
}
