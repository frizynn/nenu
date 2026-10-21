// A command line as a shell reads it, for colour only: which word is the program, which are its flags
// and arguments, where a string or a variable sits. It never decides anything and is never run; a line
// it misreads only draws in the wrong hue. The pieces join back to the input exactly, so a find hit or
// a copy reads the command as written.

export type ShellTokenKind = "command" | "flag" | "argument" | "string" | "variable" | "keyword" | "operator" | "comment" | "space";
export interface ShellToken {
  kind: ShellTokenKind;
  text: string;
}

// Words that start a clause and keep the next word in a program's place.
const OPENERS = new Set(["do", "then", "else", "elif", "if", "while", "until", "time", "!", "{", "sudo", "exec", "xargs", "env"]);
const KEYWORDS = new Set(["for", "in", "do", "done", "if", "then", "else", "elif", "fi", "while", "until", "case", "esac", "function", "select", "time"]);
// After these the next word is a program again: a pipe, a list, a subshell.
const OPERATOR = /^(?:&&|\|\||;;|\$\(|[|;&()]|\d?>>?|<<?<?|>&\d?)/;
const ASSIGNMENT = /^[A-Za-z_]\w*=/;

export function shellTokens(line: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  const push = (kind: ShellTokenKind, text: string) => {
    const last = tokens.at(-1);
    if (last?.kind === "space" && kind === "space") last.text += text;
    else tokens.push({ kind, text });
  };
  let program = true;
  // `for x in`: the loop's name is a word, never a program.
  let loopName = false;
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    const space = /^\s+/.exec(rest);
    if (space) {
      if (space[0].includes("\n")) program = true;
      push("space", space[0]);
      i += space[0].length;
      continue;
    }
    if (rest[0] === "#" && (i === 0 || /\s/.test(line[i - 1]!))) {
      const end = rest.indexOf("\n");
      const text = end < 0 ? rest : rest.slice(0, end);
      push("comment", text);
      i += text.length;
      continue;
    }
    const op = OPERATOR.exec(rest);
    if (op) {
      push("operator", op[0]);
      // A redirect names a file next; anything else hands the line to a new program.
      if (!/[<>]/.test(op[0])) program = true;
      i += op[0].length;
      continue;
    }
    const word = readWord(rest);
    i += word.length;
    if (loopName) {
      push("argument", word);
      loopName = false;
    } else if (program && KEYWORDS.has(word)) {
      push("keyword", word);
      loopName = word === "for" || word === "select";
      program = OPENERS.has(word) || word === "done" || word === "fi" || word === "esac";
    } else if (!program && word === "in" && tokens.some((t) => t.kind === "keyword" && (t.text === "for" || t.text === "case" || t.text === "select"))) {
      push("keyword", word);
    } else if (program && ASSIGNMENT.test(word)) {
      push("variable", word);
    } else if (program) {
      push("command", word);
      program = OPENERS.has(word);
    } else if (/^["']/.test(word)) {
      push("string", word);
    } else if (word.startsWith("$")) {
      push("variable", word);
    } else if (word.startsWith("-")) {
      push("flag", word);
    } else {
      push("argument", word);
    }
  }
  return tokens;
}

/** One word: up to unquoted space or an operator, its quotes whole (an unclosed one runs to the end). */
function readWord(text: string): string {
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\\") { i += 2; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += c === '"' && text[j] === "\\" ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (/[\s|;&()<>]/.test(c)) break;
    i++;
  }
  // A character no rule takes (a lone `>` the operators missed) is a word of its own, so the scan moves on.
  return text.slice(0, Math.max(1, i));
}
