// Codex's chrome is boxless: a `› ` prompt row (wrapping onto two-space-indented continuation
// rows) with the dot-separated status row directly beneath, sitting at the buffer tail. The
// dialogs (trust / approval / ask) REPLACE that pair entirely — their own footer becomes the
// tail — so locating the composer is also the composer-vs-modal discriminator. A submitted
// message echoes into the transcript with the same `› ` prefix, which is why the walk anchors
// on the STATUS row at the tail and only then looks up for the prompt row: an echo higher in
// the transcript never has the status row directly beneath it. Pure; no pane access.

import type { StyledLine } from "../../blocks";
import {
  isBlank,
  isStatusRow,
  lastNonBlankIndex,
  lineText,
  PLACEHOLDER,
  promptText,
  rstrip,
  skipBlanksUp,
} from "./markers";

export interface ComposerBox {
  /** First renderer-owned row; particles may paint one row above the prompt. */
  chromeStartRow: number;
  /** The `› ` prompt row. */
  promptRow: number;
  /** The status or exact-command autocomplete row at the tail. */
  statusRow: number;
  /** A verified command suggestion replaces status while the slash command is being typed. */
  autocomplete?: true;
}

// A draft wraps onto indented continuation rows between the prompt row and the status row.
// Captured drafts show one; the bound is slack for longer phone-typed messages. 8 stranded a
// wrap (locateComposer returned null and the app reported a dialog). Same 100 as omp/Grok/
// Claude. A run deeper than this is not a composer (fail closed — locateComposer returns null).
const MAX_DRAFT_ROWS = 100;

// A continuation row is the composer's TWO-SPACE GUTTER followed by the draft's own text — and
// that text may ITSELF begin with spaces. Type two spaces mid-sentence, or let a soft wrap land
// inside a run of them, and Codex paints a four-space-indented row that is a perfectly healthy
// continuation. The old `/^ {2}\S/` demanded a non-space at column 2, read that row as foreign,
// and made `locateComposer` return null — which refused EVERY send in the pane with "the input
// box isn't on screen — a menu or dialog is probably up" for as long as the draft sat there. That
// is a DEADLOCK, not a transient: the refusal is itself what keeps the draft from being sent, so
// the pane never recovers on its own. Only the gutter is asserted here, because only the gutter is
// the renderer's; what the walk actually bounds the run with is the blank row above it (`isBlank`,
// checked first in the same test), and Codex separates every section of a screen with one. A `› `
// or `• ` row still starts at column 0, so neither can pass as a continuation.
const CONTINUATION = /^ {2}\s*\S/;
const PROMPT_PREFIX = "› ";

// Astra's sparkle pass (`chat_composer/sparkle.rs` in Codex 0.155.1) paints through the whole
// composer after the textarea: only an original SPACE cell with an RGB background and no modifiers
// may become one of these single-dot Braille glyphs with an RGB foreground. Restoring that exact
// paint to a space preserves words and gutters; ordinary typed Braille keeps the textarea's default
// foreground and must remain text.
const PARTICLE = /^[\u2801\u2802\u2804\u2808\u2810\u2820\u2840\u2880]+$/;
const TRUE_COLOUR = /^rgb\(\d+,\d+,\d+\)$/;

interface ParticleSurface {
  background: string;
  sawParticle: boolean;
}

function particleBackground(line: StyledLine): string | null {
  let background: string | null = null;
  for (const segment of line.segments) {
    if (
      segment.bg === undefined ||
      segment.fg === undefined ||
      !TRUE_COLOUR.test(segment.fg) ||
      segment.bold === true ||
      segment.dim === true ||
      segment.italic === true ||
      segment.underline === true ||
      segment.strike === true ||
      !PARTICLE.test(segment.text)
    ) continue;
    if (background !== null && segment.bg !== background) return null;
    background = segment.bg;
  }
  return background;
}

/** A row containing only composer padding plus RGB sparkle cells. */
function particleSurface(line: StyledLine, expectedBackground?: string): ParticleSurface | null {
  let background = expectedBackground;
  let sawParticle = false;
  for (const segment of line.segments) {
    if (segment.text.length === 0) continue;
    if (segment.bg === undefined || (background !== undefined && segment.bg !== background)) return null;
    background ??= segment.bg;
    if (segment.text.trim() === "") {
      if (segment.fg !== undefined || segment.bold === true || segment.dim === true) return null;
      continue;
    }
    if (!PARTICLE.test(segment.text) || segment.fg === undefined || !TRUE_COLOUR.test(segment.fg)) {
      return null;
    }
    if (
      segment.bold === true ||
      segment.dim === true ||
      segment.italic === true ||
      segment.underline === true ||
      segment.strike === true
    ) return null;
    sawParticle = true;
  }
  return background === undefined ? null : { background, sawParticle };
}

interface AnimatedComposer {
  /** Particle-free, rstripped text for prompt through the row before status. */
  texts: string[];
  background: string;
}

function composerBackground(line: StyledLine): string | null {
  const marker = line.segments.find((segment) => segment.text.length > 0);
  return marker?.text.startsWith("›") && marker.bold === true && marker.bg !== undefined
    ? marker.bg
    : null;
}

/** Replace only sparkle cells with spaces. Textarea content uses the composer background with the
 * terminal's default foreground; the sparkle pass gives its Braille cells an explicit true-colour
 * foreground. Keeping the cell as a space preserves wrap alignment. */
function withoutParticles(line: StyledLine, background: string): { text: string; saw: boolean } {
  let saw = false;
  const text = line.segments
    .map((segment) => {
      if (
        segment.bg === background &&
        segment.fg !== undefined &&
        TRUE_COLOUR.test(segment.fg) &&
        segment.bold !== true &&
        segment.dim !== true &&
        segment.italic !== true &&
        segment.underline !== true &&
        segment.strike !== true &&
        PARTICLE.test(segment.text)
      ) {
        saw = true;
        return " ".repeat([...segment.text].length);
      }
      return segment.text;
    })
    .join("");
  return { text: rstrip(text), saw };
}

/** Canonicalize a verified composer containing Astra's sparkle overlay. Null means either there
 * is no overlay or removing RGB particle cells does not leave valid prompt/continuation grammar. */
function animatedComposer(lines: StyledLine[], box: ComposerBox): AnimatedComposer | null {
  const background = composerBackground(lines[box.promptRow]!);
  if (background === null) return null;
  const texts: string[] = [];
  let sawParticle = false;
  for (let i = box.promptRow; i < box.statusRow; i++) {
    const canonical = withoutParticles(lines[i]!, background);
    texts.push(canonical.text);
    sawParticle ||= canonical.saw;
    if (i === box.promptRow) {
      if (promptText(canonical.text) === null) return null;
    } else if (!isBlank(canonical.text) && !CONTINUATION.test(canonical.text)) {
      return null;
    }
  }
  return sawParticle ? { texts, background } : null;
}

// Codex 0.153.4 replaces its statusline with this ONE suggestion after a complete slash command.
// Enter executes that exact command. Partial/multiple suggestions and skill insertion pickers do
// not establish that meaning, so they stay refused. See SLASH_NOTES.md and the captured fixtures.
const COMMAND_SUGGESTION = /^ {2}(\/[a-z][a-z0-9_-]*) {2,}\S.{0,250}$/;
const QUEUE_FOOTER = /^ {2}tab to queue message\s+\d+% context(?: left)?$/i;

/** While Codex is working it exposes a real queued-input composer, but replaces the normal model
 * status row with the exact renderer-owned `tab to queue message` footer. On narrow panes `left`
 * wraps to the final row. Tail anchoring + the bold prompt marker keep transcript lookalikes dark. */
function locateQueuedComposer(lines: StyledLine[], texts: string[], tail: number): ComposerBox | null {
  let footer = tail;
  if (/^left$/i.test(texts[tail] ?? "")) footer--;
  if (footer < 0 || !QUEUE_FOOTER.test(texts[footer] ?? "")) return null;
  const top = skipBlanksUp(texts, footer - 1);
  if (top < 0) return null;
  let sawParticleRow = false;
  for (let i = top; i >= 0 && top - i < MAX_DRAFT_ROWS; i--) {
    const t = texts[i]!;
    const background = composerBackground(lines[i]!);
    const canonicalPrompt =
      background === null ? t : withoutParticles(lines[i]!, background).text;
    if (promptText(canonicalPrompt) !== null) {
      const box: ComposerBox = { chromeStartRow: i, promptRow: i, statusRow: footer };
      const animation = animatedComposer(lines, box);
      if (sawParticleRow && animation === null) return null;
      const above =
        i > 0 && animation !== null
          ? particleSurface(lines[i - 1]!, animation.background)
          : null;
      if (above?.sawParticle === true) box.chromeStartRow = i - 1;
      const marker = lines[i]!.segments.find((segment) => segment.text.length > 0);
      return marker?.text.startsWith("›") && marker.bold === true ? box : null;
    }
    if (isBlank(t)) continue;
    const candidateBackground = particleBackground(lines[i]!);
    const candidateText =
      candidateBackground === null
        ? null
        : withoutParticles(lines[i]!, candidateBackground).text;
    if (candidateText !== null && (isBlank(candidateText) || CONTINUATION.test(candidateText))) {
      sawParticleRow = true;
      continue;
    }
    if (!CONTINUATION.test(t)) return null;
  }
  return null;
}

function locateCommandAutocomplete(lines: StyledLine[], texts: string[], tail: number): ComposerBox | null {
  const command = COMMAND_SUGGESTION.exec(texts[tail] ?? "")?.[1];
  if (!command) return null;
  const promptRow = skipBlanksUp(texts, tail - 1);
  // One or two blank rows separate the command from its suggestion in the observed renderer.
  if (promptRow < 0 || promptRow === tail - 1 || promptText(texts[promptRow]!) !== command) return null;
  if (promptRow > 0 && !isBlank(texts[promptRow - 1]!)) return null;
  // The live composer marker is bold. A plain-text transcript lookalike must not claim a composer.
  const marker = lines[promptRow]!.segments.find((segment) => segment.text.length > 0);
  if (!marker?.text.startsWith("›") || marker.bold !== true) return null;
  return { chromeStartRow: promptRow, promptRow, statusRow: tail, autocomplete: true };
}

/** The exact placeholder text is still a valid thing an operator might deliberately type. Codex
 * distinguishes its empty hint by painting the whole body dim, so extraction should use that
 * renderer evidence too instead of discarding an ordinary non-dim draft with those words. */
function isDimPlaceholder(line: StyledLine, canonicalText = rstrip(lineText(line))): boolean {
  if (promptText(canonicalText) !== PLACEHOLDER) return false;
  const bodyStart = PROMPT_PREFIX.length;
  const bodyEnd = bodyStart + PLACEHOLDER.length;
  let offset = 0;
  let sawBody = false;
  for (const segment of line.segments) {
    const next = offset + segment.text.length;
    if (Math.max(offset, bodyStart) < Math.min(next, bodyEnd)) {
      sawBody = true;
      if (segment.dim !== true) return false;
    }
    offset = next;
    if (offset >= bodyEnd) break;
  }
  return sawBody;
}

/** The composer at the buffer tail, or null (a dialog owns the screen, or the frame is torn). */
export function locateComposer(lines: StyledLine[]): ComposerBox | null {
  const texts = lines.map((l) => rstrip(lineText(l)));
  let statusRow = lastNonBlankIndex(texts);
  if (statusRow < 0) return null;
  // 0.157 adds a shortcuts hint below the status row, including an agents link in daemon mode.
  // Require the captured wording and the renderer's bold question mark before skipping that row.
  if (isShortcutsFooter(lines[statusRow]!, texts[statusRow]!)) statusRow--;
  if (statusRow < 0) return null;
  if (!isStatusRow(texts[statusRow]!, lines[statusRow])) {
    return locateQueuedComposer(lines, texts, statusRow) ?? locateCommandAutocomplete(lines, texts, statusRow);
  }

  // One blank row separates the prompt/draft run from the status row. Deliberate paragraph breaks
  // inside a multiline draft are blank too, so the bounded walk must cross them rather than treating
  // them as a dialog. Every non-blank row between the prompt and status still has to be a renderer-
  // owned continuation, which keeps the status anchor fail-closed.
  const top = skipBlanksUp(texts, statusRow - 1);
  if (top < 0) return null;
  let sawParticleRow = false;
  for (let i = top; i >= 0 && top - i < MAX_DRAFT_ROWS; i--) {
    const t = texts[i]!;
    const background = composerBackground(lines[i]!);
    const canonicalPrompt =
      background === null ? t : withoutParticles(lines[i]!, background).text;
    if (promptText(canonicalPrompt) !== null) {
      const box: ComposerBox = { chromeStartRow: i, promptRow: i, statusRow };
      const animation = animatedComposer(lines, box);
      // A column-zero particle row is admitted only after the bold prompt, shared background and
      // particle-free continuation grammar prove it belongs to this composer.
      if (sawParticleRow && animation === null) return null;
      let chromeStartRow = i;
      const above =
        i > 0 && animation !== null
          ? particleSurface(lines[i - 1]!, animation.background)
          : null;
      if (above?.sawParticle === true) chromeStartRow = i - 1;
      return { chromeStartRow, promptRow: i, statusRow };
    }
    if (isBlank(t)) continue;
    // A star can replace either gutter cell, so a real continuation may temporarily start with a
    // Braille glyph. Admit it provisionally; the prompt-level check above later requires one shared
    // composer background and valid grammar after every star is restored to a space.
    const candidateBackground = particleBackground(lines[i]!);
    const candidateText =
      candidateBackground === null
        ? null
        : withoutParticles(lines[i]!, candidateBackground).text;
    if (candidateText !== null && (isBlank(candidateText) || CONTINUATION.test(candidateText))) {
      sawParticleRow = true;
      continue;
    }
    // A foreign-shaped or nested status row means this status row is not under a composer.
    if (!CONTINUATION.test(t) || isStatusRow(t, lines[i])) return null;
  }
  return null;
}

function isShortcutsFooter(line: StyledLine, text: string): boolean {
  if (!/^ {2}(?:← for agents · )?\? for shortcuts$/.test(text)) return false;
  const marker = text.indexOf("?");
  let offset = 0;
  for (const segment of line.segments) {
    const end = offset + segment.text.length;
    if (offset <= marker && marker < end) return segment.bold === true && segment.fg !== undefined;
    offset = end;
  }
  return false;
}

/**
 * Return `lines` with the composer (prompt row through status row) removed from the tail.
 * Unchanged input is the SAME REFERENCE, so callers can treat `result === lines` as "no chrome".
 */
export function stripChrome(lines: StyledLine[]): StyledLine[] {
  const box = locateComposer(lines);
  if (box === null) return lines;
  return lines.slice(0, box.chromeStartRow);
}

/** The status row, styled, for the strip above the phone composer. Empty when no composer. */
export function extractStatusLines(lines: StyledLine[]): StyledLine[] {
  const box = locateComposer(lines);
  if (box === null || box.autocomplete) return [];
  return [lines[box.statusRow]!];
}

/**
 * The user's draft stranded in the composer: the `› ` row's text plus wrapped continuation
 * rows, joined with single spaces (Codex word-wraps — verified against the typed original on
 * the draft-wrapped capture). The placeholder is not a draft. Null = no composer / empty.
 *
 * Load-bearing: registering this adapter switches Codex panes from one-shot send to
 * type-then-verify, and THIS is the verify half.
 */
export function extractInputDraft(lines: StyledLine[]): string | null {
  const box = locateComposer(lines);
  if (box === null) return null;
  const animation = animatedComposer(lines, box);
  const texts = animation?.texts ?? lines
    .slice(box.promptRow, box.statusRow)
    .map((line) => rstrip(lineText(line)));
  const first = promptText(texts[0]!) ?? "";
  const parts = [first.trim()];
  for (let i = 1; i < texts.length; i++) {
    parts.push(texts[i]!.trim());
  }
  const draft = parts.filter((p) => p !== "").join(" ");
  if (draft === "" || (draft === PLACEHOLDER && isDimPlaceholder(lines[box.promptRow]!, texts[0]))) {
    return null;
  }
  return draft;
}

/** Typing reaches the composer only when the composer is on screen — every dialog replaces it. */
export function composerReady(lines: StyledLine[]): boolean {
  return locateComposer(lines) !== null;
}

export interface AnimatedComposerRegion {
  /** Particle-free prompt/draft run, with star cells restored to their original spaces. */
  prompt: string;
  /** Original pane row containing the final canonical prompt/draft text. */
  endRow: number;
}

/** Canonical prompt plus its physical end row, only for a style-verified animated composer. */
export function animatedComposerRegion(lines: StyledLine[]): AnimatedComposerRegion | null {
  const box = locateComposer(lines);
  if (box === null) return null;
  const animation = animatedComposer(lines, box);
  if (animation === null) return null;
  let end = animation.texts.length;
  while (end > 1 && isBlank(animation.texts[end - 1]!)) end--;
  return {
    prompt: animation.texts.slice(0, end).join("\n"),
    endRow: box.promptRow + end - 1,
  };
}

/** Canonical prompt only for a style-verified animated composer. */
export function animatedComposerPrompt(lines: StyledLine[]): string | null {
  return animatedComposerRegion(lines)?.prompt ?? null;
}

/** The prompt/draft run a destructive write is bound to. Animated star cells are restored to the
 * spaces they replaced so renderer frames cannot stale the binding; every other screen stays
 * literal. Ending at the final real draft row keeps wrapped messages inside the bounded tail. */
export function composerPrompt(lines: StyledLine[]): string | null {
  const box = locateComposer(lines);
  if (box === null) return null;
  const canonical = animatedComposerPrompt(lines);
  if (canonical !== null) return canonical;
  let end = box.statusRow;
  while (end > box.promptRow + 1 && isBlank(lineText(lines[end - 1]!))) end--;
  return lines
    .slice(box.promptRow, end)
    .map((line) => rstrip(lineText(line)))
    .join("\n");
}
