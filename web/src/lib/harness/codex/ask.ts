// Codex's `request_user_input` question card — a `Question X/Y (N unanswered)` header, the
// question line, pointer-numbered options with two-space-split descriptions (including the
// tool's own auto-added "None of the above" row), and a `tab to add notes | enter to submit …`
// footer. Digits confirm directly: a digit answers the CURRENT question, advancing a
// multi-question set and submitting on the last one (live-probed 2026-08-22 on 1-question and
// 2-question calls; ASK_NOTES.md). The notes flow stays in the terminal: when the notes box is
// focused the footer flips to `tab or esc to clear notes …` and this detector refuses — a digit
// would type into the box. Esc interrupts the WHOLE conversation and is never emitted. Pure;
// no pane access.
//
// Notes (2026-10-10, Codex 0.160.1, PROBES_2026_10_NOTES.md): `Down`/`Up` move `›`, `tab` opens a
// `› Add notes` box under the options for the pointed row, typed text replaces that placeholder, and
// Enter submits the pointed option with `user_note: <text>`. Only the row whose own description
// advertises notes (`None of the above … notes (tab)`) on a single-question card was walked, so only
// it is marked `amend`. `detectAskNotes` reads the open box for the bridge's read-back; the buttons
// view still refuses that state, because a digit there types into the box.

import type { StyledLine } from "../../blocks";
import type { PromptModel, PromptOption } from "../prompt-model";
import { lastNonBlankIndex, lineText, regionSignature, rstrip, skipBlanksUp } from "./markers";

export interface AskRegion {
  model: PromptModel;
  startLine: number;
}

// Both captured footer variants start with the notes hint and carry an enter-submit verb
// (`enter to submit answer` mid-set, `enter to submit all` on the final question).
const FOOTER = /^\s*tab to add notes \| enter to submit\b/;
// The notes-focused footer — the state in which a digit types instead of answering.
const NOTES_FOOTER = /^\s*tab or esc to clear notes\b/;
const NOTES_BOX = /^\s*› Add notes\b/;
const HEADER = /^\s*Question (\d+)\/(\d+) \(\d+ unanswered\)$/;
// Selected rows lead with `  › `, unselected with four spaces.
const OPTION = /^(?:\s{2}(›) |\s{4})([1-9])\. (.+)$/;
// The open notes box: its placeholder, or the text typed into it.
const NOTES_ROW = /^\s{2}› (.*)$/;
const NOTES_PLACEHOLDER = "Add notes";
// The row whose description offers notes, and the card it was walked on.
const NOTES_OFFER = /\badd details in notes \(tab\)/i;
const SINGLE_QUESTION = /^\s*Question 1\/1 \(/;

/** request_user_input card at the tail, or null. */
export function detectAskRegion(lines: StyledLine[]): AskRegion | null {
  const texts = lines.map((l) => rstrip(lineText(l)));
  const end = lastNonBlankIndex(texts);
  let fi = end;
  if (/^\s*esc to interrupt$/.test(texts[fi] ?? "")) fi--;
  if (fi < 0) return null;
  // The notes-focused state is explicitly refused rather than merely unrecognized, so the
  // refusal survives layout drift in the rows above.
  if (NOTES_FOOTER.test(texts[fi]!)) return null;
  if (!FOOTER.test(texts[fi]!)) return null;

  // One blank row separates the footer from the option run. Descriptions may wrap.
  const bottom = skipBlanksUp(texts, fi - 1);
  if (bottom < 0) return null;
  if (NOTES_BOX.test(texts[bottom]!)) return null;
  const card = parseCard(texts, bottom);
  if (card === null) return null;
  const signature = regionSignature(lines, card.header, end + 1);
  if (signature === "") return null;

  const single = SINGLE_QUESTION.test(texts[card.header]!);
  const options = card.options.map((o) => (single && NOTES_OFFER.test(o.description ?? "") ? { ...o, amend: true as const } : o));
  return {
    // The block replaces the OPTIONS down; the header and question stay in the raw mirror.
    startLine: card.start,
    model: {
      question: card.question,
      options,
      // `select` pins the renderer's caption; the KEYS carry this harness's probed recipe. The
      // family doc describes Claude's digit-then-Enter — Codex's card submits on the digit alone
      // (probed, ASK_NOTES.md), and the explicit per-option `keys` are what the send path uses.
      family: "select",
      coreSignature: card.question,
      signature,
      ...(card.pointer !== undefined ? { pointer: card.pointer } : {}),
    },
  };
}

/** The open notes box at the tail: the card's question, the row it annotates and what it holds. */
export interface AskNotes {
  question: string;
  /** The pointed option the notes belong to. */
  row: number;
  /** `""` while the box shows its placeholder. */
  text: string;
}

/** An open notes box under a request_user_input card, or null. Read-back only; nothing types from it. */
export function detectAskNotes(lines: StyledLine[]): AskNotes | null {
  const texts = lines.map((l) => rstrip(lineText(l)));
  const fi = lastNonBlankIndex(texts);
  if (fi < 0 || !NOTES_FOOTER.test(texts[fi]!)) return null;
  const box = skipBlanksUp(texts, fi - 1);
  const notes = box < 0 ? null : NOTES_ROW.exec(texts[box]!);
  if (notes === null) return null;
  const bottom = skipBlanksUp(texts, box - 1);
  const card = bottom < 0 ? null : parseCard(texts, bottom);
  if (card === null || card.pointer === undefined) return null;
  const text = notes[1]!.trim();
  return { question: card.question, row: card.pointer, text: text === NOTES_PLACEHOLDER ? "" : text };
}

interface Card {
  question: string;
  options: PromptOption[];
  /** The option row number under `›`, when one is. */
  pointer?: number;
  /** First option row. */
  start: number;
  /** The `Question X/Y` header row. */
  header: number;
}

/** The header, question and option run ending at row `bottom`, or null when the layout is off. */
function parseCard(texts: string[], bottom: number): Card | null {
  const options: PromptOption[] = [];
  let pointer: number | undefined;
  let continuation: string[] = [];
  let i = bottom;
  for (; i >= 0; i--) {
    const t = texts[i]!;
    if (NOTES_BOX.test(t)) return null;
    const opt = OPTION.exec(t);
    if (opt === null) {
      if (/^ {6,}\S/.test(t) && !/^\s*\d+\./.test(t)) {
        continuation.unshift(t);
        continue;
      }
      break;
    }
    const raw = opt[3]!.trim();
    const split = raw.split(/\s{2,}/);
    const label = (split[0] ?? raw).trim();
    const description = split.slice(1).join(" ").trim();
    const option: PromptOption = { label, keys: [opt[2]!] };
    if (opt[1] !== undefined) pointer = Number(opt[2]);
    if (continuation.length > 0) {
      // Only description rows may continue. A label-only option stays raw when it wraps.
      const separator = /\s{2,}/.exec(raw);
      if (separator === null) return null;
      const descriptionColumn = t.indexOf(raw) + separator.index + separator[0].length;
      if (description === "" || continuation.some((row) => row.search(/\S/) < descriptionColumn)) {
        return null;
      }
      option.description = [description, ...continuation.map((row) => row.trim())].join(" ");
      continuation = [];
    } else if (description !== "") option.description = description;
    options.unshift(option);
  }
  if (continuation.length > 0 || options.length < 2) return null;
  for (let k = 0; k < options.length; k++) {
    if (options[k]!.keys[0] !== String(k + 1)) return null;
  }

  const start = i + 1;
  const questionEnd = skipBlanksUp(texts, i);
  let header = questionEnd;
  while (header >= 0 && /^ {2}\S/.test(texts[header]!) && !HEADER.test(texts[header]!)) {
    if (NOTES_BOX.test(texts[header]!)) return null;
    header--;
  }
  if (header < 0 || !HEADER.test(texts[header]!) || header === questionEnd) return null;
  const question = texts.slice(header + 1, questionEnd + 1).map((row) => row.trim()).join(" ");
  return { question, options, start, header, ...(pointer !== undefined ? { pointer } : {}) };
}
