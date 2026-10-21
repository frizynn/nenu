import { describe, expect, test } from "vitest";
import { shellTokens, type ShellTokenKind } from "./shell-tokens";

const kinds = (line: string) => shellTokens(line).filter((t) => t.kind !== "space").map((t) => [t.kind, t.text] as [ShellTokenKind, string]);

describe("shellTokens", () => {
  test("joins back to the command exactly", () => {
    for (const line of ["pwd && ls -la", "echo \"Hola 👋\" && for i in 1 2 3; do echo \"línea $i\"; done", "FOO=1 bun test 2>&1 | tail -5 # last", "echo 'unclosed"]) {
      expect(shellTokens(line).map((t) => t.text).join("")).toBe(line);
    }
  });

  test("each program after an operator, its flags and arguments", () => {
    expect(kinds("date && uname -a && sw_vers")).toEqual([
      ["command", "date"], ["operator", "&&"], ["command", "uname"], ["flag", "-a"], ["operator", "&&"], ["command", "sw_vers"],
    ]);
    expect(kinds("ls /carpeta-que-no-existe")).toEqual([["command", "ls"], ["argument", "/carpeta-que-no-existe"]]);
  });

  test("a loop's keywords, its name, strings and variables", () => {
    expect(kinds("for i in 1 2 3; do echo \"línea $i\"; done")).toEqual([
      ["keyword", "for"], ["argument", "i"], ["keyword", "in"], ["argument", "1"], ["argument", "2"], ["argument", "3"], ["operator", ";"],
      ["keyword", "do"], ["command", "echo"], ["string", "\"línea $i\""], ["operator", ";"], ["keyword", "done"],
    ]);
  });

  test("an assignment before the program, a redirect's file and a comment", () => {
    expect(kinds("FOO=1 bun test > out.txt # note")).toEqual([
      ["variable", "FOO=1"], ["command", "bun"], ["argument", "test"], ["operator", ">"], ["argument", "out.txt"], ["comment", "# note"],
    ]);
    expect(kinds("cat $HOME/x | grep -n y")).toEqual([["command", "cat"], ["variable", "$HOME/x"], ["operator", "|"], ["command", "grep"], ["flag", "-n"], ["argument", "y"]]);
  });
});
