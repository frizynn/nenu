import type { MdBlock, MdList, MdSpan } from "./markdown";

/**
 * A slash command as the operator types it (`/merge-pr`, `/plugin:skill`), drawn in its own tint in
 * the draft and in the sent message. Any name counts, whether or not the agent offers it: the mark
 * says "this is a command", not "this one exists". It starts the text or follows whitespace, its name
 * starts with a letter, and only sentence punctuation may follow it before the next space. So a path
 * (`/Users/fran`, `a/b`, `/notes.md`), a URL and a slash inside a word are never marked. Narrower
 * than the completion popup's token (skill-completion.ts), which also takes dots and a leading digit:
 * a popup offers names, while this reads finished prose, where `/notes.md` is a file and `/2026` a date.
 */
const SLASH_COMMAND = /(?<=^|\s)\/\p{L}[\p{L}\p{M}\p{N}_-]*(?::[\p{L}\p{M}\p{N}_-]+)*(?=[.,;:!?)]*(?:\s|$))/gu;

export interface SlashCommand { start: number; end: number }

/**
 * Every slash command in `text`. `start` and `end` say whether the text's edges are word boundaries:
 * false where markup is glued to that edge: a closing `**` before it, a code span right after it.
 */
export function slashCommands(text: string, { start = true, end = true } = {}): SlashCommand[] {
  return [...text.matchAll(SLASH_COMMAND)]
    .filter((m) => (start || m.index > 0) && (end || !/^[.,;:!?)]*$/.test(text.slice(m.index + m[0].length))))
    .map((m) => ({ start: m.index, end: m.index + m[0].length }));
}

/**
 * The parsed message with its slash commands noted on the text spans that hold them. Only the
 * operator's words are walked: code, links, files and math keep their own reading. A span keeps its
 * text whole, so a find match across a command still lands in one piece.
 */
export function markSlashCommands(blocks: MdBlock[]): MdBlock[] {
  return blocks.map((block) => {
    switch (block.kind) {
      case "heading": case "paragraph": case "quote": return { ...block, spans: markSpans(block.spans) };
      case "list": return markList(block);
      case "table": return { ...block, header: block.header.map((cell) => markSpans(cell)), rows: block.rows.map((row) => row.map((cell) => markSpans(cell))) };
      default: return block;
    }
  });
}

function markList(list: MdList): MdList {
  return { ...list, items: list.items.map((item) => ({ spans: markSpans(item.spans), lists: item.lists.map(markList) })) };
}

/**
 * `start` and `end`: whether these spans open and close on a word boundary, as a block's edges do and
 * an emphasis body's (inside its `**`) do not.
 */
function markSpans(spans: MdSpan[], start = true, end = true): MdSpan[] {
  let open = start;
  return spans.map((span, i): MdSpan => {
    const next = spans[i + 1];
    const close = next === undefined ? end : next.kind === "text" && /^\s/.test(next.text);
    if (span.kind === "bold" || span.kind === "italic") {
      open = false;
      return { ...span, spans: markSpans(span.spans, false, false) };
    }
    if (span.kind !== "text") {
      open = false;
      return span;
    }
    const commands = slashCommands(span.text, { start: open, end: close });
    open = /\s$/.test(span.text);
    return commands.length ? { ...span, commands } : span;
  });
}
