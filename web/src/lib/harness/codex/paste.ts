import { placedPicturesCarrySend } from "../inline-images";

// Codex replaces a sufficiently large paste with one atomic token while keeping the full payload
// internally: `[Pasted Content N chars]` (optionally suffixed ` #2`, ` #3`, … when equal-sized
// placeholders coexist). This is public, documented Codex TUI behavior. The reply guard cannot find
// the original text on screen in that state, so the exact Unicode character count is supplemental
// evidence that THIS send reached the composer. It never accepts surrounding text or a mismatched
// count, and it only widens evidence after a real Codex composer has already been located.

const LARGE_PASTE_CHAR_THRESHOLD = 1000;
const PASTED_CONTENT = /^\[Pasted Content ([1-9]\d*) chars\](?: #(?:[2-9]|[1-9]\d+))?$/;

export function codexDraftCarriesSend(sent: string, draft: string): boolean {
  const match = PASTED_CONTENT.exec(draft.trim());
  if (match === null) return false;
  const count = Number(match[1]);
  return count > LARGE_PASTE_CHAR_THRESHOLD && count === [...sent].length;
}

/** A text piece of a message with pictures in place, as Codex may collapse it (every piece goes as a paste). */
function collapsedPiece(piece: string): string | null {
  const count = [...piece].length;
  return count > LARGE_PASTE_CHAR_THRESHOLD ? `\\[PastedContent${count}chars\\](?:#\\d+)?` : null;
}

/** The Codex adapter's supplemental send evidence: a paste token, or pictures in their places. */
export function codexCarriesSend(sent: string, draft: string): boolean {
  return codexDraftCarriesSend(sent, draft) || placedPicturesCarrySend(sent, draft, collapsedPiece);
}
