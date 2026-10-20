import { render, screen } from "@testing-library/react";
import { createRef } from "react";

import { ChatInput } from "@/components/ui/chat/chat-input";

// Safari before 26.2 has no `field-sizing: content`, so the composer stayed one line tall over a
// four-line draft. jsdom lays nothing out: a row is 24px of scrollHeight here, plus 20px of padding.
const LINE = 24;
const PADDING = 20;

beforeEach(() => {
  Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLTextAreaElement) {
      return this.value.split("\n").length * LINE + PADDING;
    },
  });
});
afterEach(() => {
  delete (HTMLTextAreaElement.prototype as { scrollHeight?: number }).scrollHeight;
  vi.unstubAllGlobals();
});

const fieldSizing = (supported: boolean) => vi.stubGlobal("CSS", { supports: (property: string, value: string) => supported && property === "field-sizing" && value === "content" });
const draft = (lines: number) => Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n");

describe("the composer's box without field-sizing", () => {
  it("grows to its draft, and goes back to its own height once the draft is cleared", () => {
    fieldSizing(false);
    const { rerender } = render(<ChatInput value={draft(4)} onChange={() => {}} />);
    const box = screen.getByRole("textbox");
    expect(box.style.height).toBe(`${4 * LINE + PADDING}px`);
    rerender(<ChatInput value={draft(2)} onChange={() => {}} />);
    expect(box.style.height).toBe(`${2 * LINE + PADDING}px`);
    rerender(<ChatInput value="" onChange={() => {}} />);
    expect(box.style.height).toBe("");
  });

  it("leaves the height to the stylesheet where the browser sizes the field itself", () => {
    fieldSizing(true);
    render(<ChatInput value={draft(4)} onChange={() => {}} />);
    expect(screen.getByRole("textbox").style.height).toBe("");
  });

  it("still hands the caller its textarea", () => {
    fieldSizing(false);
    const ref = createRef<HTMLTextAreaElement>();
    render(<ChatInput ref={ref} value={draft(3)} onChange={() => {}} />);
    expect(ref.current).toBe(screen.getByRole("textbox"));
  });
});
