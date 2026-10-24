import { useRef } from "react";
import { render } from "@testing-library/react";

import { DraftChipLayer } from "./draft-chip-layer";
import { imageChip } from "@/lib/message-images";

// The layer under the draft paints a tinted pill behind each slash command, holding exactly the
// textarea's characters (so it wraps where the textarea does), next to the pictures' chips.

function Draft({ text, commands }: { text: string; commands?: boolean }) {
  const field = useRef<HTMLTextAreaElement>(null);
  return <div><DraftChipLayer text={text} field={field} commands={commands} /><textarea ref={field} value={text} readOnly /></div>;
}

const layerOf = (container: HTMLElement) => container.querySelector(".draft-chip-layer");

it("tints each slash command and leaves the rest of the draft as plain characters", () => {
  const text = "pero digo /skill que en el chat, y /merge-pr 260 en /Users/fran";
  const { container } = render(<Draft text={text} />);
  const layer = layerOf(container)!;
  expect([...layer.querySelectorAll(".slash-command")].map((el) => el.textContent)).toEqual(["/skill", "/merge-pr"]);
  // Same characters as the textarea, plus the zero-width space that gives a trailing newline its line.
  expect(layer.textContent).toBe(`${text}​`);
});

it("draws a command and a picture's chip side by side", () => {
  const text = `/review ${imageChip(1)} and /afk`;
  const { container } = render(<Draft text={text} />);
  const layer = layerOf(container)!;
  expect([...layer.querySelectorAll(".slash-command")].map((el) => el.textContent)).toEqual(["/review", "/afk"]);
  expect(layer.querySelectorAll(".draft-chip")).toHaveLength(1);
  expect(layer.textContent).toBe(`${text}​`);
});

it("draws nothing for a draft with no command and no picture", () => {
  const { container } = render(<Draft text="see https://x.dev/a and a/b or /tmp/x" />);
  expect(layerOf(container)).toBeNull();
});

it("tints no command when told not to (a shell, a masked password), and still draws a picture's chip", () => {
  const { container } = render(<Draft text={`/skill ${imageChip(1)}`} commands={false} />);
  expect(layerOf(container)!.querySelector(".slash-command")).toBeNull();
  expect(layerOf(container)!.querySelectorAll(".draft-chip")).toHaveLength(1);
});
