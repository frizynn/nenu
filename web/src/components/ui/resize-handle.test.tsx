import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { ResizeHandle, type WidthRange } from "@/components/ui/resize-handle";

const RANGE: WidthRange = { min: 200, initial: 300, max: 500, step: 16 };

/** A column of `width` px whose edge is the handle; jsdom lays nothing out, so the column reports its inline width. */
function Column({ width, onChange }: { width: number; onChange: (width: number) => void }) {
  return (
    <aside style={{ width }} ref={(element) => {
      if (element) element.getBoundingClientRect = () => ({ width: parseFloat(element.style.width) }) as DOMRect;
    }}>
      <ResizeHandle label="Resize column" edge="end" width={width} range={RANGE} onChange={onChange} />
    </aside>
  );
}

afterEach(() => {
  delete document.documentElement.dataset.resizing;
});

function press(handle: HTMLElement, x: number) {
  handle.setPointerCapture = vi.fn();
  handle.hasPointerCapture = () => true;
  fireEvent.pointerDown(handle, { button: 0, clientX: x, pointerId: 1 });
}

it("a drag writes the column's width as it moves and hands the end over once, within the range", () => {
  const onChange = vi.fn();
  render(<Column width={300} onChange={onChange} />);
  const handle = screen.getByRole("separator", { name: "Resize column" });
  press(handle, 100);
  expect(document.documentElement.dataset.resizing).toBe("");
  fireEvent.pointerMove(handle, { clientX: 160, pointerId: 1 });
  expect(handle.parentElement!.style.width).toBe("360px");
  fireEvent.pointerMove(handle, { clientX: 900, pointerId: 1 });
  expect(handle.parentElement!.style.width).toBe("500px");
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.pointerUp(handle, { pointerId: 1 });
  fireEvent(handle, new Event("lostpointercapture", { bubbles: true }));
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith(500);
  expect(document.documentElement.dataset.resizing).toBeUndefined();
});

it("a press that moves nothing chooses no width", () => {
  const onChange = vi.fn();
  render(<Column width={300} onChange={onChange} />);
  const handle = screen.getByRole("separator", { name: "Resize column" });
  press(handle, 100);
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(onChange).not.toHaveBeenCalled();
});

it("a column that leaves mid-drag gives the page its cursor and its selection back", () => {
  const onChange = vi.fn();
  const { unmount } = render(<Column width={300} onChange={onChange} />);
  const handle = screen.getByRole("separator", { name: "Resize column" });
  press(handle, 100);
  fireEvent.pointerMove(handle, { clientX: 140, pointerId: 1 });
  unmount();
  expect(document.documentElement.dataset.resizing).toBeUndefined();
  expect(onChange).not.toHaveBeenCalled();
});
