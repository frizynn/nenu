// The free-text reply's guard, in the composer's terms.
//
// Issue #34: with a Claude permission dialog focused, typed text is swallowed and the submit key
// ANSWERS THE DIALOG. The bridge's one-request send (bridge/guarded-send.ts, POST /send) guards
// against it: it types unsubmitted, waits until the adapter sees the text in the input box, and only
// then submits. This module holds what both sides share: the evidence check that a draft on screen
// is the text just typed (`draftCarriesSend`, imported by the bridge), and the mapping of the
// bridge's answer to what the composer does next.

import type { SendOutcome } from "./types";

export type ReplyOutcome =
  /** Text was verified in the input box and the submit key went through. */
  | { status: "sent" }
  /**
   * The bridge's PRE-FLIGHT refused: a live read could not see an input box on screen, so NO REPLY TEXT was
   * typed and no submit key was sent. Distinct from `stalled`, which is reported only after the text
   * has already gone into the pane. The caller keeps the draft and may offer a deliberate override
   * (`force`).
   *
   * `noEcho` carries the password prompt the refusing read was looking at, when it was one — see
   * lib/no-echo.ts.
   */
  | { status: "blocked"; error: string; noEcho?: string }
  /** Text never reached the input box — NO submit key was sent. The caller MUST keep the draft.
   *  `noEcho`: the prompt the last verification read saw, when the reason the text never appeared is
   *  that the screen is deliberately not showing it — see lib/no-echo.ts. */
  | { status: "stalled"; error: string; noEcho?: string }
  /** Transport/RPC failure. `textDelivered` = text is in the pane but unsubmitted; don't resend. */
  | { status: "error"; error: string; textDelivered?: boolean };

/** Minimum visible characters that must match before we believe the input box holds OUR text. */
export const MIN_MATCH_CHARS = 8;

const REGEXP_META = /[.*+?^${}()|[\]\\]/g;

/** The exact gap extractInputDraft's fold inserts at a wrap seam: one plain space, always. Any
 *  other gap on screen is whitespace the operator really typed, so `sent` must carry it too. */
const FOLD_SEAM = " ";

/** `Intl.Segmenter` is the newest platform API anything in this bundle depends on (Firefox 125,
 *  Safari 14.1), and this module is in the main chunk — composer.tsx imports it eagerly, so a
 *  module-scope `new Intl.Segmenter` on an engine without it throws at evaluation and white-screens
 *  the whole PWA at boot. Feature-detect instead: an unsupported engine must lose grapheme
 *  precision, never the app. The `null` branches below fall back to per-code-point counting, which
 *  is exactly what this check did before clusters were understood at all — a match that stops mid
 *  cluster slips through there, as it always did. */
const GRAPHEMES =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/** A cluster nobody can see: whitespace, or formatting controls that render as nothing at all
 *  (LRM/RLM, zero-width space, soft hyphen). A cluster that merely CONTAINS one still counts — the
 *  ZWJ inside a family emoji is joining visible characters, not standing in for them. */
const UNREADABLE = /^[\s\p{Default_Ignorable_Code_Point}]+$/u;

/** Visible characters. The floor below is a claim about how much of the message is legible on
 *  screen, so it must count what a reader counts — one emoji is one character, not the 11 UTF-16
 *  code units a ZWJ family sequence happens to occupy, and an invisible control is not a character
 *  at all however many of them are threaded through the text.
 *
 *  Segmenting the string AS GIVEN matters: stripping its spaces first can fuse the neighbours into
 *  one cluster. "🇯 🇵" is two characters, but strip the space and the regional indicators pair into
 *  the single flag "🇯🇵" — one character, and a floor half as high as it should be. */
function visibleLength(s: string): number {
  let n = 0;
  if (GRAPHEMES === null) {
    // Code points, not code units — a lone surrogate half is never a character on any engine.
    for (const ch of s) if (!UNREADABLE.test(ch)) n += 1;
    return n;
  }
  for (const segment of GRAPHEMES.segment(s)) if (!UNREADABLE.test(segment.segment)) n += 1;
  return n;
}

/** Every offset in `s` where one visible character ends and the next begins, plus both ends. A match
 *  that starts or stops anywhere else has sliced a character in half — "👩‍👧‍👦" is a code-unit
 *  substring of "👨‍👩‍👧‍👦", but it is a DIFFERENT character and must not verify as that one. */
function characterBoundaries(s: string): Set<number> {
  const bounds = new Set<number>([s.length]);
  if (GRAPHEMES === null) {
    let i = 0;
    for (const ch of s) {
      bounds.add(i);
      i += ch.length;
    }
    return bounds;
  }
  for (const segment of GRAPHEMES.segment(s)) bounds.add(segment.index);
  return bounds;
}

/**
 * Whether the input box's visible draft is evidence that `sent` landed there. The box WINDOWS a long
 * draft (only its tail is on screen) and FOLDS its wrapped lines together with a space, so exact
 * equality is too strict — the strongest claim that survives both is that the draft's visible
 * characters appear contiguously in what we typed.
 *
 * The fold is the subtle part. extractInputDraft joins the box's visual lines with a space, which
 * restores a REAL space only when the box happened to wrap at a word boundary; wrapping mid-run (CJK
 * has no spaces to break at) fabricates a space the sent text never had. The joined string cannot
 * say which kind each of its spaces is, and one string can hold both — "これは pull request です"
 * wrapped mid-CJK has a genuine space AND a fabricated one. So the ambiguity is per-SEAM, not
 * per-string, and no language test can resolve it.
 *
 * Hence: split the draft on whitespace and require its non-space runs to appear in `sent` in order,
 * with only whitespace between them. Every visible character still has to be there, contiguously and
 * in order — only the WIDTH of a gap the fold could have produced is treated as unknowable, which is
 * exactly what the fold destroyed. A draft that dropped or altered a non-space character still fails.
 *
 * Only a gap spelled exactly like the fold's own seam (one plain space) may collapse to nothing, and
 * only that gap is loosened at all. Any other gap — a run of spaces, a tab, an ideographic space —
 * is whitespace the terminal actually rendered, so `sent` must carry that same whitespace verbatim.
 * Without the distinction the guard would accept a screen holding "危険　実行" for a send of
 * "危険実行", or "delete　file" for "delete file": different messages, both authorised.
 *
 * The match must also land on visible-character boundaries, because a code-unit substring can cut a
 * character in half — "👩‍👧‍👦" sits inside "👨‍👩‍👧‍👦" without being it.
 *
 * The length floor stops a short unrelated remnant ("y", "n", a placeholder) from passing as a
 * match; for a send shorter than the floor, the whole thing must be there. It counts non-space
 * characters, since spaces are the part we just agreed not to trust.
 */
export function draftCarriesSend(sent: string, draft: string | null): boolean {
  if (draft === null) return false;
  // Odd indices are the gaps, even indices the runs — the gaps decide how strict each seam is.
  const parts = draft.trim().split(/(\s+)/);
  const runs = parts.filter((_part, i) => i % 2 === 0);
  const gaps = parts.filter((_part, i) => i % 2 === 1);
  if (runs.length === 0 || runs[0]!.length === 0) return false;

  const visible = runs.reduce((n, run) => n + visibleLength(run), 0);
  if (visible < Math.min(visibleLength(sent), MIN_MATCH_CHARS)) return false;

  // Runs are whitespace-free by construction, so the joined pattern can never nest quantifiers.
  const escape = (s: string) => s.replace(REGEXP_META, "\\$&");
  let pattern = escape(runs[0]!);
  for (let i = 1; i < runs.length; i++) {
    const gap = gaps[i - 1]!;
    pattern += (gap === FOLD_SEAM ? "\\s*" : escape(gap)) + escape(runs[i]!);
  }

  // Every occurrence gets its own boundary check, not just the first: an earlier hit that happens to
  // stop mid-character must not mask a later, properly aligned one. Rewinding to one past the hit's
  // start (rather than to its end) keeps overlapping occurrences reachable.
  const scan = new RegExp(pattern, "g");
  const bounds = characterBoundaries(sent);
  for (let hit = scan.exec(sent); hit !== null; hit = scan.exec(sent)) {
    if (bounds.has(hit.index) && bounds.has(hit.index + hit[0].length)) return true;
    scan.lastIndex = hit.index + 1;
  }
  return false;
}

// ── The bridge's one-request send ─────────────────────────────────────────────────────────────────

/** How the bridge words a refusal at a password prompt (bridge/guarded-send.ts NO_ECHO, NO_ECHO_TYPED). */
const PASSWORD_PROMPT = /^That's a password prompt/;

/**
 * POST /send's answer in the composer's terms. The bridge's copy is kept as it is: when the text may
 * already be in the input box (`textDelivered`) it says to check Terminal, and the composer must not
 * resend on its own. `noEchoPrompt` names the prompt on screen when the bridge refused at one.
 */
export function replyOutcomeFrom(outcome: SendOutcome, noEchoPrompt: () => string | null): ReplyOutcome {
  if (outcome.ok) return { status: "sent" };
  const noEcho = PASSWORD_PROMPT.test(outcome.error) ? (noEchoPrompt() ?? "") : undefined;
  if (!outcome.textDelivered && outcome.code === "not_ready") {
    return { status: "blocked", error: outcome.error, ...(noEcho !== undefined ? { noEcho } : {}) };
  }
  if (noEcho !== undefined) return { status: "stalled", error: outcome.error, noEcho };
  return { status: "error", error: outcome.error, textDelivered: outcome.textDelivered };
}

/**
 * Whether the next try of the same message keeps this request id. Only while the bridge can still
 * act on the earlier try: its text may be in the input box, and the same id submits it there instead
 * of typing a second copy. A failure before anything was typed, or one where the bridge already saw
 * the box without the text (stage `preflight`), gets a fresh id, so the retry sweeps whatever is
 * stranded on the input line and types again.
 */
export function retryKeepsRequestId(outcome: SendOutcome): boolean {
  return !outcome.ok && outcome.textDelivered && outcome.stage !== "preflight";
}
