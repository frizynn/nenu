// A deliberately small Markdown parser for transcript prose.
//
// WHY HAND-ROLLED. Agent output is Markdown, and reading it raw on a phone (`## Heading`, `**bold**`)
// is worse than reading it formatted. But the repo's hard rule is that pane/agent text renders as
// React TEXT NODES, never `innerHTML` — that's the XSS boundary (CLAUDE.md §"Security posture",
// ARCHITECTURE.md §6). So this produces an AST, and the renderer turns it into React elements. No
// HTML string is ever constructed, which keeps the boundary provable rather than trusted, and adds
// no dependency to a phone bundle that currently has seven.
//
// SCOPE. The subset agents actually emit: headings, fenced code, lists, blockquotes, rules,
// paragraphs, GFM tables; inline bold/italic/code/links, images that name a LOCAL file (shown
// through the pane's file route, never fetched from the network), and LaTeX math (kept as its TeX
// source; the renderer draws it). Not HTML passthrough.
//
// FLAT BY DESIGN, LISTS ASIDE. Blocks don't nest: a table inside a blockquote or a list item is read
// as the outer block's text, so a quoted table still collapses into a run-on line. Closing that means
// a recursive block parser, which is a different program from this one — and agents put tables at the
// top level, where the collapse actually hurt (#72). The one nesting read is a list's own: an item
// indented under another is its sub-item, since agents nest a bold heading's points under it and
// drawn as siblings they lose which heading they belong to.
//
// TWO DELIBERATE OMISSIONS, both because this content is code-heavy:
//  - `_underscore_` emphasis is NOT supported. It would mangle `snake_case_identifiers`, which
//    appear constantly in agent output, and Claude writes emphasis with asterisks anyway.
//  - `*emphasis*` requires non-space just inside both delimiters, so a shell glob like
//    "rename *.ts to *.tsx" isn't silently swallowed into an italic run.

/**
 * An inline run within a paragraph/heading/list item.
 *
 * Emphasis and links carry CHILD SPANS, not a flat string, because agents nest them constantly —
 * ``**`c6fe96`**`` (bold wrapping code) is routine in agent prose, and a flat model rendered those
 * backticks literally. `code` is the one leaf: its content is verbatim by definition.
 */
import { FILE_EXTENSIONS, FILE_LOCATION, FILE_NAMES, localFilePath } from "./file-links";

export type MdSpan =
  /**
   * `files`: the local files these words name in passing, for the chat's file list; drawn as words.
   * `command`: a slash command the operator typed (lib/slash-command.ts), drawn in its tint.
   */
  | { kind: "text"; text: string; files?: string[]; command?: true }
  | { kind: "code"; text: string }
  /** LaTeX, verbatim like code: `$…$` and `\(…\)` inline, `$$…$$` and `\[…\]` as display. */
  | { kind: "math"; text: string; display: boolean }
  | { kind: "file"; path: string; spans: MdSpan[] }
  /** `![alt](local-image)`. Only a local raster path; a remote image stays a link. */
  | { kind: "image"; path: string; alt: string }
  | { kind: "bold"; spans: MdSpan[] }
  | { kind: "italic"; spans: MdSpan[] }
  /** `href` is already scheme-checked; anything unsafe never becomes a link (see `safeHref`). */
  | { kind: "link"; href: string; spans: MdSpan[] };

export type MdBlock =
  | { kind: "heading"; level: number; spans: MdSpan[] }
  | { kind: "paragraph"; spans: MdSpan[] }
  /** Fenced code. `text` is verbatim — never inline-parsed. */
  | { kind: "code"; lang: string; text: string }
  /** A display formula on lines of its own. `text` is its TeX, never inline-parsed. */
  | { kind: "math"; text: string }
  | MdList
  | { kind: "quote"; spans: MdSpan[] }
  /**
   * GFM table. `align` is one entry per column (null = unaligned), and every row is padded or
   * truncated to that width so the renderer never has to reason about ragged input.
   */
  | { kind: "table"; align: MdAlign[]; header: MdSpan[][]; rows: MdSpan[][][] }
  | { kind: "rule" };

export type MdAlign = "left" | "center" | "right" | null;

/** A list item: its words, then the lists indented under it. */
export interface MdListItem { spans: MdSpan[]; lists: MdList[] }
export interface MdList { kind: "list"; ordered: boolean; items: MdListItem[] }

// Only these schemes may become a real link. Everything else (javascript:, data:, vbscript:, or a
// bare word) renders as plain text — a link is the one place this view could otherwise hand a URL
// straight to the browser.
const SAFE_SCHEME = /^(https?:|mailto:)/i;

/** The href to use for a link, or null when it must not become one. */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (href === "") return null;
  // Scheme-relative ("//evil.com") inherits the page scheme and is a real navigation — allow it, it
  // can only ever be http(s) here. A rooted or relative path stays same-origin, which is harmless.
  if (href.startsWith("/") || href.startsWith("#")) return href;
  return SAFE_SCHEME.test(href) ? href : null;
}

// A pull request's page as GitHub (and GitHub Enterprise) address it, with a tab or an anchor after it.
const PULL_REQUEST = /^https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#]\S*)?$/i;

/** `owner/repo#N` for a link to a pull request, else null. */
export function pullRequestRef(href: string): string | null {
  const m = PULL_REQUEST.exec(href);
  return m ? `${m[1]}/${m[2]}#${m[3]}` : null;
}

// TeX inside math delimiters: an escaped character (so `\$` and `\}` stay in the formula), or anything
// but a dollar, a backslash, a backtick or a newline. No backtick means a formula never swallows a
// code span, and code is never math.
const TEX = String.raw`\\[^\n]|[^\\$\`\n]`;
// Its first and last characters: the same, minus whitespace.
const TEX_EDGE = String.raw`\\[^\n]|[^\\$\`\s]`;

// One pass reads every construct, so the file detector (chat-files.ts) and the renderer see the same
// thing: a URL is a URL to its end, never a path after its port or in its query; a link's target is a
// link; code is code. Leftmost wins, and at one position the earlier alternative wins: code before
// emphasis before links, any `scheme://` before a path, `$$` before `$`. Emphasis bodies forbid a
// leading/trailing space (see the glob note above) and can't span a newline.
const SCHEME = "[a-z][a-z\\d+.-]{0,31}";
// A path segment stops at whitespace, a quote, a bracket, a separator and every character that may
// precede a path, so an attempt never re-reads text another attempt already passed.
const SEGMENT = String.raw`[^\s"'\`<>()[\]{}|/\\,;:=*$]+`;
const FILE_PATH = String.raw`(?:\.{0,2}/|/)?(?:${SEGMENT}/)*(?:${SEGMENT}\.(?:${FILE_EXTENSIONS})|(?:${FILE_NAMES}))${FILE_LOCATION}?`;
const INLINE_RE = new RegExp(
  [
    "(?<fence>`+)(?<code>[^`]+?)\\k<fence>",
    "\\*\\*(?<bold>\\S(?:[^\\n]*?\\S)?)\\*\\*",
    "\\*(?<italic>\\S(?:[^\\n*]*?\\S)?)\\*",
    "(?<bang>!?)\\[(?<label>[^\\]\\n]*)\\]\\((?<target><[^>\\n]+>|[^)\\s]+)\\)",
    // An autolink, `<https://…>`, and a URL in prose, short of the punctuation that ends a sentence.
    // An agent writes either meaning a link: a file URL opens the file it names, a web URL itself.
    `<(?<autolink>${SCHEME}:[^\\s<>]+)>`,
    String.raw`\b(?<url>${SCHEME}://[^\s"'\`<>()[\]{}|\\*]*[^\s"'\`<>()[\]{}|\\*.,;:!?])`,
    String.raw`\$\$(?<displayMath>(?:${TEX})+?)\$\$`,
    String.raw`\\\[(?<bracketMath>(?:${TEX})+?)\\\]`,
    String.raw`\\\((?<parenMath>(?:${TEX})+?)\\\)`,
    // A dollar is also a price and a shell variable, so `$5 and $10`, `$HOME/$USER` and `${A}/${B}`
    // are not formulas: no space just inside, and nothing word-like after the closing `$`. The
    // opening `$` must not follow a word character either (checked below).
    String.raw`\$(?<dollarMath>(?:${TEX_EDGE})(?:(?:${TEX})*?(?:${TEX_EDGE}))?)\$(?![\w\${(])`,
    // A quoted name may hold spaces ("docs/My Report.pdf"); it counts only when it is a file name.
    String.raw`(?<quote>["'])(?<quoted>[^"'\`\n*[\]<>$\\]{1,4096})\k<quote>`,
    // A path in plain words, after a space, a bracket or a separator.
    String.raw`(?<lead>^|[\s([{:;,=])(?<path>${FILE_PATH})(?=$|[\s),.;:!?\]}])`,
  ].join("|"),
  "gi",
);

// Emphasis nests, so parsing recurses into each body. Every level strips at least one delimiter pair,
// so it always terminates — this bound is belt-and-braces against pathological input, past which the
// remaining text is simply left as text.
const MAX_INLINE_DEPTH = 6;

/** A URL in prose: the file it names, a link to itself, or (an unsafe scheme) its words. */
function urlSpan(url: string, literal: string): MdSpan {
  const path = localFilePath(url);
  if (path) return { kind: "file", path, spans: [{ kind: "text", text: url }] };
  const href = safeHref(url);
  return href ? { kind: "link", href, spans: [{ kind: "text", text: pullRequestRef(href) ?? href }] } : { kind: "text", text: literal };
}

/** Parse one line/paragraph of inline Markdown. Pure, and recursive through emphasis/link bodies. */
export function parseInline(text: string, depth = 0): MdSpan[] {
  const spans: MdSpan[] = [];
  const push = (span: MdSpan) => {
    if (span.kind === "text" && span.text === "") return;
    // Text that a refused delimiter split stays one run, so find highlights can span it.
    const prev = spans.at(-1);
    if (span.kind === "text" && prev?.kind === "text") {
      prev.text += span.text;
      if (span.files) (prev.files ??= []).push(...span.files);
    } else spans.push(span);
  };
  if (depth >= MAX_INLINE_DEPTH) {
    push({ kind: "text", text });
    return spans;
  }

  // A fresh regex per call: INLINE_RE is stateful (`g`), and recursion would otherwise clobber the
  // parent's lastIndex mid-scan.
  const re = new RegExp(INLINE_RE.source, INLINE_RE.flags);
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    const g = m.groups!;
    const before = text[m.index - 1] ?? "";
    // `US$5` or `\$x$`: a dollar after a word character or a backslash opens nothing, and neither does
    // the apostrophe in "Fran's". A quote that holds no file name is just punctuation, and a colon
    // glued to a word starts an address (`javascript:x.png`, `localhost:8443/a.html`), not a path.
    // Keep it as text and scan on from the next character, where something else may still start.
    if ((g.dollarMath !== undefined && /[\w\\$]/.test(before))
      || (g.quoted !== undefined && (/\w/.test(before) || !localFilePath(g.quoted)))
      || (g.lead === ":" && /\w/.test(before))) {
      re.lastIndex = m.index + 1;
      continue;
    }
    // A path's match starts at the space or bracket before it, which stays text.
    push({ kind: "text", text: text.slice(last, m.index + (g.lead?.length ?? 0)) });
    if (g.code !== undefined) push({ kind: "code", text: g.code }); // leaf: content is verbatim
    else if (g.bold !== undefined) push({ kind: "bold", spans: parseInline(g.bold, depth + 1) });
    else if (g.italic !== undefined) push({ kind: "italic", spans: parseInline(g.italic, depth + 1) });
    else if (g.label !== undefined && g.target !== undefined) {
      const path = localFilePath(g.target);
      const href = safeHref(g.target);
      // An unsafe target keeps its literal Markdown, so nothing silently disappears from the text.
      if (g.bang && path && /\.(?:png|jpe?g|gif|webp)$/i.test(path)) push({ kind: "image", path, alt: g.label });
      else if (path) push({ kind: "file", path, spans: parseInline(g.label || path, depth + 1) });
      else if (href) push({ kind: "link", href, spans: parseInline(g.label || href, depth + 1) });
      else push({ kind: "text", text: m[0] });
    } else if (g.autolink !== undefined) push(urlSpan(g.autolink, m[0]));
    else if (g.url !== undefined) push(urlSpan(g.url, g.url));
    else if (g.quoted !== undefined) push({ kind: "text", text: m[0], files: [localFilePath(g.quoted)!] });
    else if (g.path !== undefined) {
      const path = localFilePath(g.path);
      push({ kind: "text", text: g.path, ...(path ? { files: [path] } : {}) });
    } else {
      const tex = g.displayMath ?? g.bracketMath ?? g.parenMath ?? g.dollarMath ?? "";
      const display = g.displayMath !== undefined || g.bracketMath !== undefined;
      push(tex.trim() ? { kind: "math", text: tex.trim(), display } : { kind: "text", text: m[0] });
    }
    last = m.index + m[0].length;
  }
  push({ kind: "text", text: text.slice(last) });
  return spans;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^\s*(?:```|~~~)\s*(\S*)/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const UL_ITEM = /^\s*[-*+]\s+(.*)$/;
const OL_ITEM = /^\s*\d+[.)]\s+(.*)$/;
const isItem = (line: string) => UL_ITEM.exec(line) ?? OL_ITEM.exec(line);

/** A line's leading whitespace in columns, a tab reaching the next stop of four. */
function indentOf(line: string): number {
  let columns = 0;
  for (const char of line) {
    if (char === " ") columns++;
    else if (char === "\t") columns += 4 - (columns % 4);
    else break;
  }
  return columns;
}

/**
 * The list that starts at `start`, an item line. Its items share the first one's indent (give or
 * take a column, as hand-aligned numbers drift), an item two or more columns deeper starts a list
 * under the item before it, and a shallower one, a change of marker kind or any other line ends it.
 */
function parseList(lines: string[], start: number): { list: MdList; end: number } {
  const base = indentOf(lines[start]!);
  const ordered = OL_ITEM.test(lines[start]!);
  const items: MdListItem[] = [];
  let i = start;
  while (i < lines.length) {
    const item = isItem(lines[i]!);
    if (!item) break;
    const indent = indentOf(lines[i]!);
    if (indent < base) break;
    const parent = items.at(-1);
    if (indent > base + 1 && parent) {
      const nested = parseList(lines, i);
      parent.lists.push(nested.list);
      i = nested.end;
      continue;
    }
    // A run stays one list only while its marker kind holds — a switch starts a new block.
    if (OL_ITEM.test(lines[i]!) !== ordered) break;
    items.push({ spans: parseInline(item[1] ?? ""), lists: [] });
    i++;
  }
  return { list: { kind: "list", ordered, items }, end: i };
}
const QUOTE = /^\s*>\s?(.*)$/;

// A table is recognised by its DELIMITER row, never by the header alone: a line of prose containing
// a pipe is common, `| --- | :-: |` under it is not. Both spellings agents emit are accepted —
// with outer pipes and without — but the row must carry at least one pipe, so a bare `---` stays a
// horizontal rule, and every cell must be dashes (optionally colon-flanked), so `|---|:` is not one.
const TABLE_DELIM = /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*(?::?-+:?\s*\|?)?\s*$/;

/** Split one table row into raw cell strings. `\|` is an escaped pipe, not a column break. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "\\" && line[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "|") {
      cells.push(cur);
      cur = "";
    } else cur += ch;
  }
  cells.push(cur);
  // Outer pipes produce empty edge cells; they are punctuation, not columns.
  if (cells.length > 1 && cells[0]!.trim() === "") cells.shift();
  if (cells.length > 1 && cells[cells.length - 1]!.trim() === "") cells.pop();
  return cells.map((c) => c.trim());
}

function parseAlign(line: string): MdAlign[] {
  return splitRow(line).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

/**
 * Pad/truncate a BODY row to the header's width, so the renderer can assume a rectangle. Ragged body
 * rows are legal GFM and agents emit them; a ragged delimiter row is not — see `startsTable`.
 */
function fitRow(line: string, width: number): MdSpan[][] {
  const cells = splitRow(line)
    .slice(0, width)
    .map((cell) => parseInline(cell));
  while (cells.length < width) cells.push([]);
  return cells;
}

/**
 * True when `line` opens a table — i.e. the line under it is a delimiter row of the SAME width.
 *
 * The width check is what GFM requires, and it is load-bearing here rather than pedantic: without
 * it, any prose line containing a pipe that happens to sit above a dashed line becomes a table split
 * at that pipe. Matching the spec keeps the false positives out.
 *
 * Two side doors remain, both rare enough to leave: a header that also parses as a list item
 * (`1. Name | Value`) is claimed by the list branch, which runs first, and the body loop below takes
 * any pipe-bearing line — so two tables with no blank line between them merge into one.
 */
const startsTable = (line: string, next: string | undefined) =>
  line.includes("|") &&
  next !== undefined &&
  TABLE_DELIM.test(next) &&
  splitRow(next).length === splitRow(line).length;

// A display formula on lines of its own: `$$` or `\[` opens a line, the matching `$$` or `\]` ends
// one, and the TeX between is never read as Markdown (a `- c &= d` row is not a bullet). A blank line
// ends the search, as it ends a formula in TeX, so an unclosed `$$` stays prose instead of swallowing
// the rest of the message. `$$x$$ is …` on one line is prose with a formula in it, for parseInline.
const MATH_CLOSE: Record<string, string> = { "$$": "$$", "\\[": "\\]" };

function mathBlock(lines: string[], start: number): { text: string; end: number } | null {
  const first = lines[start]!.trim();
  const close = MATH_CLOSE[first.slice(0, 2)];
  if (!close) return null;
  const body: string[] = [];
  for (let j = start; j < lines.length; j++) {
    const line = j === start ? first.slice(2) : lines[j]!.trim();
    if (j > start && line === "") return null;
    if (line.endsWith(close)) {
      body.push(line.slice(0, -close.length));
      const text = body.join("\n").trim();
      return text ? { text, end: j + 1 } : null;
    }
    if (line.includes(close)) return null;
    body.push(line);
  }
  return null;
}

/**
 * Parse Markdown into blocks. Pure — no React, no DOM — so the whole grammar is unit-testable and
 * the renderer stays a dumb mapping from AST to elements.
 */
export function parseMarkdown(source: string): MdBlock[] {
  const lines = source.split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code first: its body is literal, so nothing inside is parsed as Markdown.
    const fence = FENCE.exec(line);
    if (fence) {
      const lang = fence[1] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i]!)) body.push(lines[i++]!);
      i++; // consume the closing fence (or run off the end on an unterminated block)
      blocks.push({ kind: "code", lang, text: body.join("\n") });
      continue;
    }

    const math = mathBlock(lines, i);
    if (math) {
      blocks.push({ kind: "math", text: math.text });
      i = math.end;
      continue;
    }

    // A rule must be checked before list items, or "---" reads as a bullet.
    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1]!.length,
        spans: parseInline(heading[2] ?? ""),
      });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length) {
        const q = QUOTE.exec(lines[i]!);
        if (!q) break;
        body.push(q[1] ?? "");
        i++;
      }
      blocks.push({ kind: "quote", spans: parseInline(body.join(" ").trim()) });
      continue;
    }

    if (isItem(line)) {
      const { list, end } = parseList(lines, i);
      blocks.push(list);
      i = end;
      continue;
    }

    // Tables come last of the recognised blocks: every other construct wins a line that could be
    // read as either, and a table is the only one that needs to look ahead.
    if (startsTable(line, lines[i + 1])) {
      const header = splitRow(line).map((cell) => parseInline(cell));
      // Widths already match — `startsTable` refused the row otherwise — so the columns line up
      // without padding either side.
      const align = parseAlign(lines[i + 1]!);
      i += 2;
      const rows: MdSpan[][][] = [];
      // The body runs until a blank line or anything that isn't a pipe row — a table that bumps
      // into a heading or a fence ends there rather than swallowing it.
      while (i < lines.length && lines[i]!.trim() !== "" && lines[i]!.includes("|")) {
        rows.push(fitRow(lines[i]!, header.length));
        i++;
      }
      blocks.push({ kind: "table", align, header, rows });
      continue;
    }

    // Paragraph: consecutive lines until a blank or a line that starts some other block. Joined with
    // a space, since a hard-wrapped paragraph should reflow to the phone's width, not keep its
    // source line breaks.
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      if (
        l.trim() === "" ||
        HEADING.test(l) ||
        FENCE.test(l) ||
        RULE.test(l) ||
        QUOTE.test(l) ||
        isItem(l) ||
        startsTable(l, lines[i + 1]) ||
        mathBlock(lines, i)
      )
        break;
      para.push(l.trim());
      i++;
    }
    blocks.push({ kind: "paragraph", spans: parseInline(para.join(" ")) });
  }

  return blocks;
}
