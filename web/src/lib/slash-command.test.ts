import { parseMarkdown, type MdBlock, type MdSpan } from "./markdown";
import { markSlashCommands, slashCommands } from "./slash-command";

const marked = (text: string) => slashCommands(text).map(({ start, end }) => text.slice(start, end));

/** Every command the pass noted, in reading order. */
function commandsIn(blocks: MdBlock[]): string[] {
  const spans = (list: MdSpan[]): string[] => list.flatMap((span) =>
    span.kind === "text" ? (span.commands ?? []).map((c) => span.text.slice(c.start, c.end)) : "spans" in span ? spans(span.spans) : []);
  return blocks.flatMap((block) => block.kind === "list" ? block.items.flatMap((item) => spans(item.spans))
    : block.kind === "table" ? [...block.header, ...block.rows.flat()].flatMap(spans)
      : "spans" in block ? spans(block.spans) : []);
}

describe("slashCommands", () => {
  it("marks a command that starts the message or follows whitespace, whatever its name", () => {
    expect(marked("/merge-pr 260")).toEqual(["/merge-pr"]);
    expect(marked("pero digo cuándo escribo por ejemplo /skill que en el chat")).toEqual(["/skill"]);
    expect(marked("  /afk")).toEqual(["/afk"]);
    expect(marked("first line\n/compact keep the plan")).toEqual(["/compact"]);
    expect(marked("/a and /b\tthen /c_d")).toEqual(["/a", "/b", "/c_d"]);
  });

  it("keeps a plugin's namespace and leaves sentence punctuation out", () => {
    expect(marked("run /fran-mode:merge-pr now")).toEqual(["/fran-mode:merge-pr"]);
    expect(marked("did you try /skill? or /afk.")).toEqual(["/skill", "/afk"]);
    expect(marked("use /loop, /simplify; then /review!")).toEqual(["/loop", "/simplify", "/review"]);
    expect(marked("ends with /qué")).toEqual(["/qué"]);
    // Decomposed, as macOS file names and some pastes arrive: the accent is a combining mark.
    expect(marked("ends with /que\u0301")).toEqual(["/que\u0301"]);
  });

  it("never marks a path, a URL, a slash inside a word or a lone slash", () => {
    for (const text of [
      "/Users/fran/notes", "open /tmp/x", "a/b", "and/or", "/x/y", "see /notes.md", "/etc/hosts:12",
      "https://github.com/frizynn/nenu/pull/260", "file:///Users/fran", "//comment", "pongo con la barra /",
      "1/2", "/2026", "(/skill)", "`/skill`", "/-flag", "$HOME/bin",
    ]) expect(marked(text), text).toEqual([]);
  });

  it("does not count an edge of the text as a boundary when markup is glued to it", () => {
    expect(slashCommands("/skill", { start: false })).toEqual([]);
    expect(slashCommands("/a /b", { start: false })).toEqual([{ start: 3, end: 5 }]);
    expect(slashCommands("/a /b.", { end: false })).toEqual([{ start: 0, end: 2 }]);
  });
});

describe("markSlashCommands", () => {
  it("notes commands in a message's paragraphs, lists, quotes, tables and emphasis, keeping each span whole", () => {
    const blocks = markSlashCommands(parseMarkdown("/merge-pr 260 please\n\n- try /afk\n\n> quoted /loop\n\n**and /bold now** too\n\n| /cell | x |\n| --- | --- |\n| /row | y |"));
    expect(commandsIn(blocks)).toEqual(["/merge-pr", "/afk", "/loop", "/bold", "/cell", "/row"]);
    const first = blocks[0]!;
    expect(first.kind === "paragraph" && first.spans).toEqual([
      { kind: "text", text: "/merge-pr 260 please", commands: [{ start: 0, end: 9 }] },
    ]);
  });

  it("leaves code, links, files and a slash glued to markup alone, as the draft does", () => {
    const glued = "`/skill` [see /x](https://example.com) **x**/glued `a`/b /notes.md **and /bold** /end`code` /end**b**";
    expect(commandsIn(markSlashCommands(parseMarkdown(`${glued}\n\n\`\`\`\n/inside code\n\`\`\``)))).toEqual([]);
    expect(marked(glued)).toEqual([]);
  });
});
