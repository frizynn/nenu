import { lineText, type StyledLine } from "../../blocks";
import type { MenuModel } from "../menu-model";

/** The update widget advertises Escape as Skip; no updater or numbered shortcut is inferred. */
export function detectUpdateMenu(lines: StyledLine[]): MenuModel | null {
  const texts = lines.map(lineText).map((t) => t.trimEnd());
  const title = texts.findIndex((t) =>
    /^  Update available · \S+ → \S+$/.test(t),
  );
  const footer = texts.findIndex(
    (t) => t.trim() === "enter continue · esc skip",
  );
  if (
    title < 0 ||
    footer <= title ||
    footer - title > 15 ||
    texts.slice(footer + 1).some((t) => t.trim())
  )
    return null;
  const options = texts
    .slice(title + 1, footer)
    .filter((t) => /^ ?(?:›| ) [1-3]\. /.test(t));
  if (
    options.length !== 3 ||
    options.filter((t) => t.startsWith("›")).length !== 1
  )
    return null;
  return {
    title: texts[title]!.trim(),
    actions: [
      { label: "Continue", keys: ["Enter"] },
      { label: "Skip", keys: ["Escape"], cancel: true },
    ],
    nav: { upDown: true },
    signature: texts.slice(title, footer + 1).join("\n"),
  };
}
