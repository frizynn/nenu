import { createContext, memo, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";

import { parseMarkdown, pullRequestRef, type MdBlock, type MdSpan } from "@/lib/markdown";
import { splitHighlight } from "@/lib/transcript-search";
import { FileMediaContext, FilePreviewContext } from "@/lib/file-preview-context";
import { localFilePath } from "@/lib/file-links";
import { tableHtml, tableMarkdown } from "@/lib/table-copy";
import { cn } from "@/lib/utils";
import { GitPullRequest } from "@/components/ui/icon";
import { CodeBlock } from "./code-block";
import { FileLink } from "./file-link";
import { CopyButton, QUIET_ACTION } from "./copy-button";
import { TexMath } from "./math";
import { IMAGE_EDGE } from "./message-images";

// Renders the Markdown AST as React elements. Every string from the log reaches the DOM as a TEXT
// NODE — there is no `dangerouslySetInnerHTML` here and there must never be one. That is the repo's
// XSS boundary (CLAUDE.md §"Security posture"): the parser decides *structure*, never markup, so a
// transcript containing `<script>` renders those characters and nothing executes.
//
// Sizes come from the app's type scale (index.css): prose in the body step, the size the composer
// types in, headings a step or a weight above it. This is a reading view inside a terminal-ish app,
// not a document viewer, so there is no separate prose theme.

// The active find, threaded via context rather than a prop drilled through every nested span —
// highlighting is a cross-cutting display concern, and the AST walk is already recursive.
const FindContext = createContext({ query: "", current: false });

// Every hit wears the work log's amber; the current match's go solid, so "2/7" can be found on screen.
// Exported so the work log's own marks (work-log-tools.tsx) draw from the same two classes.
export const FIND_HIT = "rounded-sm box-decoration-clone bg-amber-300/70 text-inherit dark:bg-amber-500/40";
export const FIND_CURRENT_HIT = "bg-amber-400 text-black outline outline-1 outline-amber-600 dark:bg-amber-400";

/** Literal text with find hits marked. Still text nodes — `<mark>` is structure, never parsed markup. */
function Hit({ text }: { text: string }) {
  const { query, current } = useContext(FindContext);
  if (query.trim() === "") return <>{text}</>;
  const pieces = splitHighlight(text, query);
  if (pieces.length === 1 && !pieces[0]!.hit) return <>{text}</>;
  return (
    <>
      {pieces.map((piece, i) =>
        piece.hit ? (
          <mark key={i} aria-current={current || undefined} className={cn(FIND_HIT, current && FIND_CURRENT_HIT)}>
            {piece.text}
          </mark>
        ) : (
          <span key={i}>{piece.text}</span>
        ),
      )}
    </>
  );
}

const INLINE_CODE = "rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.875em] box-decoration-clone [overflow-wrap:anywhere]";
// A short span (an identifier, a flag, a file name) sits in an inline box capped at the line, so it
// moves down whole instead of splitting `workbench-composer` at its hyphen, and breaks inside itself
// only when it is wider than a whole line, as in a bubble at page zoom. The box carries no padding of
// its own: the pill stays on the inline `code`, so a line holding one keeps the paragraph's pitch. A
// longer span flows inline and wraps where it has to; moved down whole it would leave a ragged gap.
const WHOLE = "inline-block max-w-full [overflow-wrap:anywhere]";
const WHOLE_CODE_CHARS = 24;

/** The words a span draws, for measuring a label. */
const spanText = (spans: MdSpan[]): string => spans.map((span) => "spans" in span ? spanText(span.spans) : span.kind === "image" ? span.alt : span.text).join("");

// Inside a link's label, another link (a bare pull request URL used as the label) draws as its words.
const InLinkContext = createContext(false);

// Emphasis and links hold child spans (agents nest them — ``**`sha`**`` is routine), so this recurses
// through <Spans>. `code` is the leaf.
function Span({ span }: { span: MdSpan }) {
  const openFile = useContext(FilePreviewContext);
  const inLink = useContext(InLinkContext);
  switch (span.kind) {
    case "image":
      return <InlineImage path={span.path} alt={span.alt} />;
    case "math":
      return <TexMath tex={span.text} display={span.display} />;
    case "file":
      return <FileLink path={span.path} className="text-left text-primary underline underline-offset-2 [overflow-wrap:anywhere]"><LinkLabel spans={span.spans} /></FileLink>;
    case "bold":
      return (
        <strong className="font-semibold">
          <Spans spans={span.spans} />
        </strong>
      );
    case "italic":
      return (
        <em className="italic">
          <Spans spans={span.spans} />
        </em>
      );
    case "code": {
      const path = openFile ? localFilePath(span.text) : null;
      const code = <code className={cn(INLINE_CODE, path && "text-primary underline underline-offset-2")}><Hit text={span.text} /></code>;
      // A file's link is an inline box whatever its length.
      if (path) return <FileLink path={path} className={cn(WHOLE, "text-left")}>{code}</FileLink>;
      return span.text.length <= WHOLE_CODE_CHARS ? <span className={WHOLE}>{code}</span> : code;
    }
    case "link": {
      if (inLink) return <Spans spans={span.spans} />;
      // A pull request reads as one: its icon before the label, no underline until a pointer rests on
      // it, and a short label kept whole with its icon, as a short code span is.
      const pr = pullRequestRef(span.href) !== null;
      // `href` was scheme-checked in the parser. noreferrer/noopener because these URLs come from
      // agent output, and target=_blank keeps the PWA shell alive behind the tap.
      return (
        <a
          href={span.href}
          target="_blank"
          rel="noopener noreferrer"
          className={cn("text-primary underline-offset-2 [overflow-wrap:anywhere]", pr ? "hover:underline" : "underline",
            pr && spanText(span.spans).length <= WHOLE_CODE_CHARS && WHOLE)}
        >
          {pr && <GitPullRequest aria-hidden="true" className="mr-0.5 inline-block size-[0.95em] align-[-0.125em]" />}
          <LinkLabel spans={span.spans} />
        </a>
      );
    }
    default:
      return <Hit text={span.text} />;
  }
}

/**
 * A Markdown image, in place, from the pane's own file route (the bridge contains and sniffs it).
 * Without that route, or when the file is unavailable, it degrades to the file's name.
 */
function InlineImage({ path, alt }: { path: string; alt: string }) {
  const url = useContext(FileMediaContext);
  const [failed, setFailed] = useState(false);
  const name = alt || (path.split("/").at(-1) ?? path);
  if (!url || failed) return <Span span={{ kind: "file", path, spans: [{ kind: "text", text: name }] }} />;
  const image = <img src={url(path)} alt={name} loading="lazy" decoding="async" onError={() => setFailed(true)}
    className={cn("my-1 inline-block max-h-80 max-w-full rounded-lg object-contain align-top", IMAGE_EDGE)} />;
  return <FileLink path={path} label={`Open ${name}`} className="inline-block max-w-full text-left">{image}</FileLink>;
}

// A code-formatted filename or a pull request URL inside a link is its label, never another nested
// interactive control.
const LinkLabel = ({ spans }: { spans: MdSpan[] }) => (
  <InLinkContext.Provider value><FilePreviewContext.Provider value={null}><Spans spans={spans} /></FilePreviewContext.Provider></InLinkContext.Provider>
);

const Spans = ({ spans }: { spans: MdSpan[] }) => (
  <>
    {spans.map((span, i) => (
      <Span key={i} span={span} />
    ))}
  </>
);

const ALIGN_CLASS: Record<string, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

type TableBlock = Extract<MdBlock, { kind: "table" }>;

// A cell that wraps past this many lines has stopped reading as a column.
const CRAMPED_LINES = 4;

/** Whether a drawn grid reads as one: no cell wraps into a sliver, and nothing runs past its scroller. */
function gridReads(scroller: HTMLElement): boolean {
  if (scroller.scrollWidth > scroller.clientWidth + 1) return false;
  return [...scroller.querySelectorAll("[data-cell]")].every((cell) => cell.getClientRects().length <= CRAMPED_LINES);
}

/**
 * A table keeps its grid while the grid reads in the width it has: its columns wrap to fit, and a
 * short-celled table stays a grid on a phone. Past that a phone could only pan it sideways a row at a
 * time, hiding where the row went, so each row reads instead as a block of its cells under their
 * headers. The grid is measured as drawn, in the real font; a wider column draws it again to look.
 */
function MdTable({ block }: { block: TableBlock }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // How this grid measured the last time it was on screen: whether it read, in what width.
  const [fit, setFit] = useState<{ block: TableBlock; reads: boolean; width: number } | null>(null);
  // A wider column, or other cells, draw the grid again to look.
  const rows = fit !== null && fit.block === block && !fit.reads && width <= fit.width;
  // Every layout with the grid on screen measures it.
  useLayoutEffect(() => {
    const el = box.current;
    const grid = el?.querySelector<HTMLElement>("[data-grid]");
    if (!el || !grid) return;
    const next = { block, reads: gridReads(grid), width: el.clientWidth };
    setFit((last) => last?.block === next.block && last.reads === next.reads && last.width === next.width ? last : next);
  });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={box}>
      {/* Its Copy sits above it, right-aligned like a code block's. */}
      <div className="flex justify-end">
        <CopyButton what="table" payload={() => ({ text: tableMarkdown(block), html: tableHtml(block) })} className={cn(QUIET_ACTION, "-mr-2")} />
      </div>
      {rows ? (
        <div className="divide-y border-y tabular-nums">
          {block.rows.map((row, r) => (
            <dl key={r} className="space-y-1.5 py-2.5">
              {row.map((cell, c) => (
                <div key={c}>
                  {block.header[c]?.length ? <dt className="text-footnote text-muted-foreground"><Spans spans={block.header[c]} /></dt> : null}
                  <dd className={c === 0 ? "font-semibold" : undefined}><Spans spans={cell} /></dd>
                </div>
              ))}
            </dl>
          ))}
        </div>
      ) : (
        <div data-grid className="overflow-x-auto">
          <table className="border-collapse text-footnote tabular-nums">
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  <th key={i} className={`border px-2 py-1 font-semibold ${ALIGN_CLASS[block.align[i] ?? "left"]}`}>
                    <span data-cell><Spans spans={cell} /></span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} className={`border px-2 py-1 align-top ${ALIGN_CLASS[block.align[c] ?? "left"]}`}>
                      <span data-cell><Spans spans={cell} /></span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Block({ block }: { block: MdBlock }) {
  switch (block.kind) {
    case "heading": {
      // Levels 1 and 2 take the headline step (its weight comes with it). Levels 3-6 keep the body
      // size and stand out by weight: another size step costs a phone a line for a heading agents
      // rarely nest that deep.
      const cls = block.level <= 2 ? "text-headline" : "text-body font-semibold";
      return (
        <div className={`${cls} mt-1`}>
          <Spans spans={block.spans} />
        </div>
      );
    }
    case "code":
      return (
        <CodeBlock lang={block.lang} text={block.text}>
          <Hit text={block.text} />
        </CodeBlock>
      );
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag
          className={`ml-4 space-y-0.5 ${block.ordered ? "list-decimal" : "list-disc"} marker:text-muted-foreground`}
        >
          {block.items.map((item, i) => (
            <li key={i} className="pl-0.5">
              <Spans spans={item} />
            </li>
          ))}
        </Tag>
      );
    }
    case "quote":
      return (
        <blockquote className="border-l-2 pl-2.5 text-muted-foreground italic">
          <Spans spans={block.spans} />
        </blockquote>
      );
    case "table":
      return <MdTable block={block} />;
    case "math":
      return <TexMath tex={block.text} display />;
    case "rule":
      return <hr className="border-border" />;
    default:
      return (
        <p>
          <Spans spans={block.spans} />
        </p>
      );
  }
}

/**
 * Render agent prose as formatted Markdown. Memoised on its props, all plain values: a transcript
 * re-renders on every poll and holds dozens of these, so unchanged prose skips both the parse and its
 * elements. The contexts it reads (find, file links) still reach it when they change.
 */
export const MarkdownText = memo(function MarkdownText({
  text,
  className,
  query = "",
  current = false,
}: {
  text: string;
  className?: string;
  /** Active find query — occurrences render as marks. Empty disables highlighting entirely. */
  query?: string;
  /** This text is find's current match: its hits take a solid fill the other matches don't. */
  current?: boolean;
}) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const find = useMemo(() => ({ query, current }), [query, current]);
  return (
    <FindContext.Provider value={find}>
      <div className={cn("space-y-2 text-body break-words", className)}>
        {blocks.map((block, i) => (
          <Block key={i} block={block} />
        ))}
      </div>
    </FindContext.Provider>
  );
});
