import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines, type StyledLine } from "../../blocks";
import { extractInputDraft, hasInputBox } from "./chrome";
import { claudeAdapter } from "./index";

// A message with images reaches Claude as prose plus absolute image paths (serializeMessage). When the
// bytes arrive as one paste, Claude 2.1.299 attaches each path and draws the box as
// `[Image #N] [Image #N+1]<prose>`. Both captures are real: a disposable Herdr 0.9.3, Claude Code
// 2.1.299, the text sent with pane.send_text as the bridge does (2026-10-14).

const fixture = (name: string): StyledLine[] =>
  splitLines(parseAnsi(readFileSync(join(import.meta.dirname, "fixtures", `${name}-v2299.txt`), "utf8")));

// Paths the operator typed, not Nenu's uploads: an upload now goes piece by piece, pasted alone in its
// place (ADR 0104), so this one-paste shape is what a long message with typed image paths still makes.
const RED = "/tmp/nsh/work/shots/photo-red.png";
const BLUE = "/tmp/nsh/work/shots/photo-blue.png";
const PROSE = [
  "Hay un problema en la vista de prueba que quiero que en lugar de mostrar dos botones muestre una lista con el agente que sea y el nivel de permisos, porque si no es imposible elegir bien desde el telefono cuando estoy lejos del escritorio y sin la notebook a mano para nada",
  "despues en los proyectos hay un retoque abajo de lo que aparece todo el rato que no deberia aparecer, sino que en otra pestana y falta implementar los diffs que no se implementaron todavia en ninguna parte del producto",
  "para eso crea un tab que cada agente tenga su propia tarea y que se meta bajo nivel, a investigar y debugear todo primero y luego implemente para hacerlo lo mas eficiente y rapido posible y que consuma la menor memoria posible",
];
/** What the composer sent for the first capture: three paragraphs, then both paths. */
const SENT = `${PROSE.join("\n\n")} ${RED} ${BLUE}`;

const carries = (sent: string, draft: string) => claudeAdapter.draftCarriesSend!(sent, draft);

describe("a send with images, as Claude 2.1.299 draws it", () => {
  it("finds the box while Claude shows its five-second 'ctrl+g to edit in Vim' hint", () => {
    const lines = fixture("draft-images-editor-hint");
    expect(hasInputBox(lines)).toBe(true);
    expect(extractInputDraft(lines)).toMatch(/^\[Image #3\] \[Image #4\]Hay un problema/);
  });

  it("accepts the image tokens followed by the whole prose as the message just typed", () => {
    const draft = extractInputDraft(fixture("draft-images-editor-hint"))!;
    expect(carries(SENT, draft)).toBe(true);
  });

  it("accepts an image token beside the paste token Claude made of the prose", () => {
    // Claude split the prose at every " /" (18 of them) and collapsed the 18 lines it made.
    const sent = `${"x".repeat(20)} ${"una ruta /usr/local/bin y un comando /model dentro del texto que sigue un rato largo ".repeat(9)} ${RED}`;
    const draft = extractInputDraft(fixture("draft-image-paste-collapsed"))!;
    expect(draft).toBe("[Image #6][Pasted text #7 +18 lines]");
    expect(carries(sent, draft)).toBe(true);
  });

  it("accepts an images-only send drawn as exactly its tokens", () => {
    expect(carries(`${RED} ${BLUE}`, "[Image #1] [Image #2]")).toBe(true);
  });
});

describe("a send with images: what stays refused", () => {
  const draftFor = (prose: string[]) => `[Image #1] [Image #2]${prose.join(" ")}`;

  it("refuses prose that is not the message", () => {
    expect(carries(SENT, draftFor([PROSE[0]!, PROSE[1]!.replace("diffs", "tests"), PROSE[2]!]))).toBe(false);
  });

  it("refuses prose that stops short of the end of the message", () => {
    expect(carries(SENT, draftFor([PROSE[0]!, PROSE[1]!]))).toBe(false);
    expect(carries(SENT, draftFor(PROSE).slice(0, -12))).toBe(false);
  });

  it("refuses a token count that is not the message's image count", () => {
    expect(carries(SENT, `[Image #1]${PROSE.join(" ")}`)).toBe(false);
    expect(carries(SENT, `[Image #1] [Image #2] [Image #3]${PROSE.join(" ")}`)).toBe(false);
    expect(carries(`${RED} ${BLUE}`, "[Image #1]")).toBe(false);
  });

  it("refuses image tokens for a message that carried no image", () => {
    expect(carries(PROSE.join("\n\n"), draftFor(PROSE))).toBe(false);
  });

  it("refuses the tokens alone when the message also had prose", () => {
    expect(carries(SENT, "[Image #1] [Image #2]")).toBe(false);
  });

  it("refuses a collapsed prose whose line count is not the one Claude made", () => {
    expect(carries(`${PROSE.join("\n\n")} ${RED}`, "[Image #1][Pasted text #2 +4 lines]")).toBe(false);
    expect(carries(`${PROSE.join("\n\n")} ${RED}`, "[Image #1][Pasted text #2 +2 lines]")).toBe(true);
  });

  it("still refuses a box with the plan dialog's footer, which carries the same words beside its file", () => {
    const rule = "─".repeat(80);
    const lines = splitLines(
      parseAnsi([rule, "❯ hello there", rule, "  ctrl+g to edit in Vim · ~/.claude/plans/mossy-enchanting-pony.md"].join("\n")),
    );
    expect(hasInputBox(lines)).toBe(false);
  });

  it("refuses the hint row when it also names another key", () => {
    const rule = "─".repeat(80);
    const lines = splitLines(parseAnsi([rule, "❯ hello there", rule, "  ctrl+g to edit in Vim · Esc to cancel"].join("\n")));
    expect(hasInputBox(lines)).toBe(false);
  });

  it("finds the box when the hint is the statusline row's only field", () => {
    const rule = "─".repeat(80);
    const lines = splitLines(parseAnsi([rule, "❯ hello there", rule, `${" ".repeat(60)}ctrl+g to edit in Vim`].join("\n")));
    expect(hasInputBox(lines)).toBe(true);
    expect(extractInputDraft(lines)).toBe("hello there");
  });
});
