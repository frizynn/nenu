import { parseMarkdown, type MdBlock, type MdSpan } from "./markdown";
import { markSlashCommands, slashCommands } from "./slash-command";

const marked = (text: string) => slashCommands(text).map(({ start, end }) => text.slice(start, end));

/** Every span the pass marked, in reading order. */
function commandsIn(blocks: MdBlock[]): string[] {
  const spans = (list: MdSpan[]): string[] => list.flatMap((span) =>
    span.kind === "text" ? (span.command ? [span.text] : []) : "spans" in span ? spans(span.spans) : []);
  return blocks.flatMap((block) => block.kind === "list"
    ? block.items.flatMap((item) => spans(item.spans))
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
  });

  it("never marks a path, a URL, a slash inside a word or a lone slash", () => {
    for (const text of [
      "/Users/fran/notes", "open /tmp/x", "a/b", "and/or", "/x/y", "see /notes.md", "/etc/hosts:12",
      "https://github.com/frizynn/nenu/pull/260", "file:///Users/fran", "//comment", "pongo con la barra /",
      "1/2", "/2026", "(/skill)", "`/skill`", "/-flag", "$HOME/bin",
    ]) expect(marked(text), text).toEqual([]);
  });

  it("does not count the text's start as a boundary when the text continues a word", () => {
    expect(slashCommands("/skill", false)).toEqual([]);
    expect(slashCommands("/a /b", false)).toEqual([{ start: 3, end: 5 }]);
  });
});

describe("markSlashCommands", () => {
  it("marks commands in a message's paragraphs, lists, quotes and emphasis, keeping every other character", () => {
    const blocks = markSlashCommands(parseMarkdown("/merge-pr 260 please\n\n- try /afk\n\n> quoted /loop\n\n**and /bold** too"));
    expect(commandsIn(blocks)).toEqual(["/merge-pr", "/afk", "/loop", "/bold"]);
    const first = blocks[0]!;
    expect(first.kind === "paragraph" && first.spans).toEqual([
      { kind: "text", text: "/merge-pr", command: true },
      { kind: "text", text: " 260 please" },
    ]);
  });

  it("leaves code, links, files and a slash glued to markup alone", () => {
    const blocks = markSlashCommands(parseMarkdown("`/skill` [see /x](https://example.com) **x**/glued `a`/b /notes.md\n\n```\n/inside code\n```"));
    expect(commandsIn(blocks)).toEqual([]);
  });
});
