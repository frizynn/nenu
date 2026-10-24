import type { MdBlock, MdList, MdSpan } from "./markdown";

/**
 * A slash command as the operator types it (`/merge-pr`, `/plugin:skill`), drawn in its own tint in
 * the draft and in the sent message. Any name counts, whether or not the agent offers it: the mark
 * says "this is a command", not "this one exists". It starts the text or follows whitespace, its name
 * starts with a letter, and only sentence punctuation may follow it before the next space. So a path
 * (`/Users/fran`, `a/b`, `/notes.md`), a URL and a slash inside a word are never marked.
 */
const SLASH_COMMAND = /(?<=^|\s)\/\p{L}[\p{L}\p{N}_-]*(?::[\p{L}\p{N}_-]+)*(?=[.,;:!?)]*(?:\s|$))/gu;

export interface SlashCommand { start: number; end: number }

/** Every slash command in `text`. `boundary` is false when the text continues a word before it. */
export function slashCommands(text: string, boundary = true): SlashCommand[] {
  return [...text.matchAll(SLASH_COMMAND)]
    .filter((m) => boundary || m.index > 0)
    .map((m) => ({ start: m.index, end: m.index + m[0].length }));
}

/**
 * The parsed message with its slash commands marked on the text spans that hold them. Only the
 * operator's words are walked: code, links, files and math keep their own reading, and a span starts
 * after whitespace only when the character before it in the message was one.
 */
export function markSlashCommands(blocks: MdBlock[]): MdBlock[] {
  return blocks.map((block) => {
    switch (block.kind) {
      case "heading": case "paragraph": case "quote": return { ...block, spans: markSpans(block.spans) };
      case "list": return markList(block);
      default: return block;
    }
  });
}

function markList(list: MdList): MdList {
  return { ...list, items: list.items.map((item) => ({ spans: markSpans(item.spans), lists: item.lists.map(markList) })) };
}

/** `prev` is the character before these spans: empty at a block's start. */
function markSpans(spans: MdSpan[]): MdSpan[] {
  let prev = "";
  const walk = (list: MdSpan[]): MdSpan[] => list.flatMap((span): MdSpan[] => {
    if (span.kind === "bold" || span.kind === "italic") {
      prev = "*";
      const inner = walk(span.spans);
      prev = "*";
      return [{ ...span, spans: inner }];
    }
    if (span.kind !== "text") {
      prev = "x";
      return [span];
    }
    const found = slashCommands(span.text, prev === "" || /\s/.test(prev));
    prev = span.text.at(-1) ?? prev;
    if (!found.length) return [span];
    const out: MdSpan[] = [];
    let at = 0;
    for (const { start, end } of found) {
      if (start > at) out.push({ kind: "text", text: span.text.slice(at, start) });
      out.push({ kind: "text", text: span.text.slice(start, end), command: true });
      at = end;
    }
    if (at < span.text.length) out.push({ kind: "text", text: span.text.slice(at) });
    return out;
  });
  return walk(spans);
}
