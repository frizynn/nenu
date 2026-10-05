import { parseAnsi } from "../../ansi";

export function hasCodexInterruptCue(text: string): boolean {
  return text.split(/\r\n?|\n/).some((rawLine) => {
    const plain = parseAnsi(rawLine).map((segment) => segment.text).join("").trimEnd();
    if (!/^• Working \([^\r\n)]* • esc to interrupt\)(?: · [^\r\n]+)?$/i.test(plain)) return false;
    // The same words can occur in transcript prose. Bind the cue to Codex's renderer paint: bold
    // bullet and dim hint glue; current Codex paints Working muted and Escape bold. A copied/plain historical line fails.
    const painted: Array<{ char: string; bold: boolean; dim: boolean }> = [];
    let bold = false;
    let dim = false;
    let cursor = 0;
    const sgr = /\x1b\[([0-9;?]*)m/g;
    for (let match = sgr.exec(rawLine); match !== null; match = sgr.exec(rawLine)) {
      for (const char of rawLine.slice(cursor, match.index)) painted.push({ char, bold, dim });
      const codes = match[1]!.split(";").map((value) => Number.parseInt(value.replace("?", ""), 10));
      for (const code of codes) {
        if (code === 0 || Number.isNaN(code)) { bold = false; dim = false; }
        else if (code === 1) bold = true;
        else if (code === 2) dim = true;
        else if (code === 22) { bold = false; dim = false; }
      }
      cursor = sgr.lastIndex;
    }
    for (const char of rawLine.slice(cursor)) painted.push({ char, bold, dim });
    const visible = painted.map((entry) => entry.char).join("").trimEnd();
    if (visible !== plain) return false;
    const hint = plain.indexOf("(");
    return painted[0]?.bold === true &&
      hint >= 0 && painted[hint]?.dim === true &&
      painted.slice(plain.indexOf(" to interrupt"), plain.indexOf(")") + 1).every((entry) => entry.dim);
  });
}

