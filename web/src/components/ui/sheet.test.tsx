import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { BottomSheet, SideSheet, useSheetStep } from "./sheet";

// Focus + labelling: the sheets are role=dialog/aria-modal, so they should be named by their title,
// move focus inside on open, restore it on close, and expose exactly ONE accessible "Close" (the
// header ✕) — the full-screen backdrop stays tappable but is hidden from assistive tech.
describe("sheet — focus & labelling", () => {
  it("labels the dialog with its title (aria-labelledby)", () => {
    render(
      <BottomSheet open onClose={vi.fn()} title="Keys">
        body
      </BottomSheet>,
    );
    expect(screen.getByRole("dialog", { name: "Keys" })).toBeInTheDocument();
  });

  it("exposes a single accessible Close (✕); the backdrop is aria-hidden but still dismisses on a real tap (down+up on it)", () => {
    const onClose = vi.fn();
    const { container } = render(
      <SideSheet open onClose={onClose} title="Navigate">
        body
      </SideSheet>,
    );
    // Only the header ✕ is in the a11y tree now — no giant duplicate "Close" from the backdrop.
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
    // ...but the backdrop still closes on a genuine press-and-release on it.
    const backdrop = container.querySelector('button[aria-hidden="true"]');
    expect(backdrop).not.toBeNull();
    fireEvent.pointerDown(backdrop!);
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves focus into the panel on open and restores it to the opener on close", () => {
    const opener = document.createElement("button");
    opener.textContent = "open";
    document.body.appendChild(opener);
    opener.focus();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    expect(document.activeElement).toBe(opener);

    const { rerender } = render(
      <BottomSheet open onClose={vi.fn()} title="Keys">
        body
      </BottomSheet>,
    );
    // Focus is now inside the dialog panel (not left on the opener behind the modal).
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(opener);
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });

    rerender(
      <BottomSheet open={false} onClose={vi.fn()} title="Keys">
        body
      </BottomSheet>,
    );
    expect(document.activeElement).toBe(opener);
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    focus.mockRestore();
    opener.remove();
  });
});

it("does not dismiss a sheet while scrolling a nested list or selecting input text", () => {
  const onClose = vi.fn();
  render(<BottomSheet open onClose={onClose} title="Workspaces">
    <div data-testid="nested" style={{ overflowY: "auto" }}>Long list</div>
    <textarea aria-label="Draft" />
  </BottomSheet>);
  const list = screen.getByTestId("nested");
  list.scrollTop = 120;
  for (const target of [list, screen.getByRole("textbox")]) {
    fireEvent.touchStart(target, { touches: [{ clientY: 100 }] });
    fireEvent.touchMove(target, { touches: [{ clientY: 240 }] });
    fireEvent.touchEnd(target, { touches: [] });
    expect(onClose).not.toHaveBeenCalled();
  }
  // Pulling from the sheet's own header still dismisses it.
  const header = screen.getByText("Workspaces");
  fireEvent.touchStart(header, { touches: [{ clientY: 100 }] });
  fireEvent.touchMove(header, { touches: [{ clientY: 240 }] });
  fireEvent.touchEnd(header, { touches: [] });
  expect(onClose).toHaveBeenCalledOnce();
});

// The on-device bug: a long-press that opens the sheet leaves the finger down at mount time: the
// browser's release `click` lands wherever the finger now is, which is the backdrop — and closing on
// ANY backdrop click meant the sheet closed in the same instant it opened. The fix arms the dismiss
// only when the pointer went DOWN on the backdrop too (press AND release on it), so a click whose
// pointerdown started elsewhere (the pill, in the real gesture) is ignored.
describe("BottomSheet — backdrop dismiss requires press AND release on the backdrop", () => {
  it("stays open when pointerdown happened elsewhere (not the backdrop) and only the click lands on it", () => {
    const onClose = vi.fn();
    const { container } = render(
      <BottomSheet open onClose={onClose} title="Actions">
        body
      </BottomSheet>,
    );
    // Simulate the pointerdown landing on something other than the backdrop (e.g. the pane pill that
    // triggered the long-press), then the release click landing on the backdrop.
    fireEvent.pointerDown(document.body);
    const backdrop = container.querySelector('button[aria-hidden="true"]')!;
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes when both pointerdown and click land on the backdrop (a genuine backdrop tap)", () => {
    const onClose = vi.fn();
    const { container } = render(
      <BottomSheet open onClose={onClose} title="Actions">
        body
      </BottomSheet>,
    );
    const backdrop = container.querySelector('button[aria-hidden="true"]')!;
    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the ✕ button still closes regardless of the backdrop arm state", () => {
    const onClose = vi.fn();
    render(
      <BottomSheet open onClose={onClose} title="Actions">
        body
      </BottomSheet>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape still closes regardless of the backdrop arm state", () => {
    const onClose = vi.fn();
    render(
      <BottomSheet open onClose={onClose} title="Actions">
        body
      </BottomSheet>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("re-arms per open: a stale arm from a previous open doesn't leak into the next one", () => {
    const onClose = vi.fn();
    const { container, rerender } = render(
      <BottomSheet open onClose={onClose} title="Actions">
        body
      </BottomSheet>,
    );
    const backdrop = () => container.querySelector('button[aria-hidden="true"]')!;
    fireEvent.pointerDown(backdrop());
    // Close via Escape instead of the (now-armed) backdrop click, leaving the arm flag set to true.
    fireEvent.keyDown(window, { key: "Escape" });
    rerender(
      <BottomSheet open={false} onClose={onClose} title="Actions">
        body
      </BottomSheet>,
    );
    rerender(
      <BottomSheet open onClose={onClose} title="Actions">
        body
      </BottomSheet>,
    );
    onClose.mockClear();
    // A click with no pointerdown in this new open should NOT close, even though a stale arm from the
    // previous open was left set to true.
    fireEvent.click(backdrop());
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("SideSheet — swipe to dismiss", () => {
  function swipe(panel: Element, path: Array<[number, number]>) {
    const touch = ([clientX, clientY]: [number, number]) => ({ clientX, clientY, identifier: 0, target: panel });
    fireEvent.touchStart(panel, { touches: [touch(path[0]!)] });
    for (const point of path.slice(1)) fireEvent.touchMove(panel, { touches: [touch(point)] });
    fireEvent.touchEnd(panel, { touches: [] });
  }

  it("closes on a swipe toward its edge, and not on a scroll or a short drag", () => {
    const onClose = vi.fn();
    render(<SideSheet open onClose={onClose} title="Navigation">body</SideSheet>);
    const panel = document.querySelector(".side-sheet-panel")!;
    swipe(panel, [[200, 300], [200, 360], [120, 420]]);
    expect(onClose).not.toHaveBeenCalled();
    swipe(panel, [[200, 300], [170, 302], [150, 303]]);
    expect(onClose).not.toHaveBeenCalled();
    swipe(panel, [[200, 300], [180, 302], [100, 306]]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

/**
 * A stand-in for the browser's exit animation, which jsdom does not run: the test decides when it
 * ends. Anything else running in the layer (a spinner) comes along with a name of its own.
 */
function stubExitAnimation(...others: Array<{ animationName: string }>) {
  let end!: () => void;
  const finished = new Promise<void>((resolve) => { end = resolve; });
  const forever = new Promise<void>(() => {});
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [{ animationName: "exit", finished }, ...others.map((other) => ({ ...other, finished: forever }))],
  });
  return async () => {
    end();
    await act(async () => { await finished; });
  };
}
afterEach(() => { delete (Element.prototype as { getAnimations?: unknown }).getAnimations; });

/** The pointer the page reports, for the media queries the sheets read. */
function pointer(kind: "fine" | "coarse") {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === `(pointer: ${kind})`, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
}
afterEach(() => vi.unstubAllGlobals());

describe("closing animates out", () => {
  it("keeps a closing sheet on screen, out of reach, showing what it showed, until its exit ends", async () => {
    const finish = stubExitAnimation();
    const { container, rerender } = render(
      <BottomSheet open onClose={vi.fn()} title="Close “review”?"><p>Its pane closes.</p></BottomSheet>,
    );
    // The owner falls back to its first view as it closes; what slides away is what was on screen.
    rerender(<BottomSheet open={false} onClose={vi.fn()} title="review"><p>Rename</p></BottomSheet>);
    const layer = container.querySelector('[role="dialog"]');
    expect(layer).not.toBeNull();
    expect(layer).toHaveAttribute("inert");
    expect(screen.getByText("Its pane closes.")).toBeInTheDocument();
    expect(screen.getByText("Close “review”?")).toBeInTheDocument();
    expect(screen.queryByText("Rename")).toBeNull();

    await finish();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("stays open when it is reopened before its exit ends", async () => {
    const finish = stubExitAnimation();
    const { container, rerender } = render(<BottomSheet open onClose={vi.fn()} title="Actions">first</BottomSheet>);
    rerender(<BottomSheet open={false} onClose={vi.fn()} title="Actions">first</BottomSheet>);
    rerender(<BottomSheet open onClose={vi.fn()} title="Actions">second</BottomSheet>);
    await finish();
    const layer = screen.getByRole("dialog", { name: "Actions" });
    expect(layer).not.toHaveAttribute("inert");
    expect(screen.getByText("second")).toBeInTheDocument();
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });

  it("waits for the exit only, never for an endless animation inside the sheet", async () => {
    // "Scanning the full conversation…" spins forever; the sheet must still go when its exit ends.
    const finish = stubExitAnimation({ animationName: "spin" });
    const { container, rerender } = render(<BottomSheet open onClose={vi.fn()} title="Files">body</BottomSheet>);
    rerender(<BottomSheet open={false} onClose={vi.fn()} title="Files">body</BottomSheet>);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    await finish();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("drops a closed sheet at once where nothing animates its exit", () => {
    Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
    const { container, rerender } = render(<BottomSheet open onClose={vi.fn()} title="Keys">body</BottomSheet>);
    rerender(<BottomSheet open={false} onClose={vi.fn()} title="Keys">body</BottomSheet>);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("tells its owner once it is gone, not while it is still leaving", async () => {
    const finish = stubExitAnimation();
    const onExited = vi.fn();
    const { rerender } = render(<BottomSheet open onClose={vi.fn()} title="New" onExited={onExited}>body</BottomSheet>);
    rerender(<BottomSheet open={false} onClose={vi.fn()} title="New" onExited={onExited}>body</BottomSheet>);
    expect(onExited).not.toHaveBeenCalled();
    await finish();
    expect(onExited).toHaveBeenCalledTimes(1);
  });

  it("comes in from where it leaves to: the bottom sheet from below the screen, the drawer from past its edge", () => {
    render(<BottomSheet open onClose={vi.fn()} title="Actions">body</BottomSheet>);
    render(<SideSheet open onClose={vi.fn()} title="Navigation">rows</SideSheet>);
    expect(document.querySelector(".sheet-bottom-panel")).toHaveClass("slide-in-from-bottom");
    expect(document.querySelector(".side-sheet-panel")).toHaveClass("slide-in-from-left");
  });

  it("slides the side drawer out the same way", async () => {
    const finish = stubExitAnimation();
    const { container, rerender } = render(<SideSheet open onClose={vi.fn()} title="Navigation">rows</SideSheet>);
    rerender(<SideSheet open={false} onClose={vi.fn()} title="Navigation">rows</SideSheet>);
    expect(container.querySelector(".side-sheet-panel")).not.toBeNull();
    expect(container.querySelector('[role="dialog"]')).toHaveAttribute("inert");
    await finish();
    expect(container.querySelector(".side-sheet-panel")).toBeNull();
  });
});

describe("first focus", () => {
  it("puts the cursor in the field the sheet marks where typing raises no on-screen keyboard", () => {
    pointer("fine");
    render(<BottomSheet open onClose={vi.fn()} title="Agent commands"><input aria-label="Search" data-autofocus /></BottomSheet>);
    expect(screen.getByRole("textbox", { name: "Search" })).toHaveFocus();
  });

  it("keeps the keyboard down on a touch screen: the panel takes focus, not the field", () => {
    pointer("coarse");
    render(<BottomSheet open onClose={vi.fn()} title="Agent commands"><input aria-label="Search" data-autofocus /></BottomSheet>);
    expect(screen.getByRole("textbox", { name: "Search" })).not.toHaveFocus();
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
  });
});

// One header for every bottom sheet and its desk panel: the title in the title style at the start,
// a chevron back before it on a sheet with steps, the ✕ at the end. A step drawn inside the sheet
// (a rename, a confirmation) names the sheet while it shows instead of drawing a second header.
describe("one header", () => {
  const order = (a: Element, b: Element) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;

  it("titles the sheet at the start of its header in the title style, with Close at the end and no Back", () => {
    render(<BottomSheet open onClose={vi.fn()} title="Navigation">rows</BottomSheet>);
    const dialog = screen.getByRole("dialog", { name: "Navigation" });
    const heading = within(dialog).getByRole("heading", { name: "Navigation" });
    expect(heading).toHaveClass("text-title");
    expect(within(dialog).getAllByRole("heading")).toHaveLength(1);
    expect(order(heading, within(dialog).getByRole("button", { name: "Close" }))).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("steps back from a chevron before the title on a sheet with steps", () => {
    const onBack = vi.fn();
    render(<BottomSheet open onClose={vi.fn()} title="New tab" onBack={onBack}>form</BottomSheet>);
    const back = screen.getByRole("button", { name: "Back" });
    expect(order(back, screen.getByRole("heading", { name: "New tab" }))).toBeTruthy();
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalledOnce();
  });

  function Step({ title, onBack }: { title: string; onBack?: () => void }) {
    useSheetStep(title, onBack);
    return <p>{title} body</p>;
  }

  it("lets the step on screen name the sheet and step back, then gives the header back when it goes", () => {
    const onBack = vi.fn();
    const { rerender } = render(
      <BottomSheet open onClose={vi.fn()} title="review"><Step title="Rename tab" onBack={onBack} /></BottomSheet>,
    );
    const dialog = screen.getByRole("dialog", { name: "Rename tab" });
    expect(within(dialog).getAllByRole("heading").map((h) => h.textContent)).toEqual(["Rename tab"]);
    expect(within(dialog).getAllByRole("button", { name: "Close" })).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledOnce();

    rerender(<BottomSheet open onClose={vi.fn()} title="review"><Step title="Close “review”?" /></BottomSheet>);
    expect(screen.getByRole("dialog", { name: "Close “review”?" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();

    rerender(<BottomSheet open onClose={vi.fn()} title="review"><p>Rename</p></BottomSheet>);
    expect(screen.getByRole("dialog", { name: "review" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual(["review"]);
  });

  it("is the only way a screen restyles a sheet's header: no stylesheet or class reaches into it", () => {
    const src = resolve(import.meta.dirname, "../..");
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return files(path);
      return /\.(tsx|css)$/.test(entry.name) && !entry.name.includes(".test.") ? [path] : [];
    });
    /** Every `<BottomSheet …>` opening tag in a file, read up to the `>` that closes it. */
    const sheetTags = (text: string) => [...text.matchAll(/<BottomSheet\b/g)].map(({ index }) => {
      let depth = 0;
      let quote = "";
      for (let i = index; i < text.length; i++) {
        const ch = text[i]!;
        if (quote) quote = ch === quote ? "" : quote;
        else if (ch === "{") depth++;
        else if (ch === "}") depth--;
        else if (depth === 0 && (ch === '"' || ch === "'")) quote = ch;
        else if (depth === 0 && ch === ">") return text.slice(index, i + 1);
      }
      return text.slice(index);
    });
    const offenders = files(src)
      .filter((file) => !file.endsWith("index.css") && !file.endsWith(join("ui", "sheet.tsx")))
      .flatMap((file) => {
        const text = readFileSync(file, "utf8");
        const reaches = /\.sheet-bottom-panel|data-sheet-edit-header/.test(text) || sheetTags(text).some((tag) => /\[&>/.test(tag));
        return reaches ? [relative(src, file)] : [];
      });
    expect(offenders).toEqual([]);
  });
});
