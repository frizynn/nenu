import { lineText, type StyledLine } from "../../blocks";
import { parseKeyHintFooter } from "../menu-hints";
import type { MenuModel } from "../menu-model";
import { isHorizontalRule } from "./markers";

/** A bounded, numbered menu whose closing rule also starts the still-visible editor. */
export function detectOverlayMenu(
  lines: StyledLine[],
): { startLine: number; endLine: number; model: MenuModel } | null {
  const texts = lines.map(lineText);
  for (
    let footer = texts.length - 4;
    footer >= Math.max(0, texts.length - 60);
    footer--
  ) {
    if (
      !isHorizontalRule(texts[footer + 1]!) ||
      !/^❯(?:\s|$)/.test(texts[footer + 2]!.trim()) ||
      !isHorizontalRule(texts[footer + 3]!)
    )
      continue;
    const actions = parseKeyHintFooter(texts[footer]!);
    if (
      !actions.some((a) => a.keys.includes("Enter")) ||
      !actions.some((a) => a.keys.includes("Escape"))
    )
      continue;
    let top = footer - 1;
    while (top >= Math.max(0, footer - 30) && !isHorizontalRule(texts[top]!))
      top--;
    if (top < Math.max(0, footer - 30)) continue;
    const body = texts.slice(top + 1, footer);
    const options = body
      .map((t) => /^\s*(❯)?\s+([1-9]\d*)\.\s+\S/.exec(t))
      .filter((m) => m !== null);
    if (
      options.length < 2 ||
      options.filter((m) => m[1]).length !== 1 ||
      !options.every((m, i) => Number(m[2]) === i + 1)
    )
      continue;
    const title = body.find((t) => t.trim())?.trim();
    if (!title || /^❯?\s*\d+\./.test(title)) continue;
    return {
      startLine: top,
      endLine: footer + 1,
      model: {
        title,
        actions,
        nav: { upDown: true },
        signature: texts.slice(top, footer + 1).join("\n"),
      },
    };
  }
  return null;
}
