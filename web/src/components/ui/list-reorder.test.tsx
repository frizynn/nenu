import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";

import { useListReorder } from "./list-reorder";

const ROW = 50;

/** A list of rows ROW tall, the dragged ones following their handle, drawn in `order`. */
function List({ initial, onMove }: { initial: string[]; onMove?: (order: string[], key: string) => void }) {
  const [order, setOrder] = useState(initial);
  const list = useRef<HTMLUListElement>(null);
  const reorder = useListReorder({ list, keys: order, enabled: true, onMove: (next, key) => { setOrder(next); onMove?.(next, key); } });
  return (
    <>
      <button type="button" onClick={() => setOrder((prev) => prev.slice(1))}>Close the first</button>
      <ul ref={list} aria-label="rows">
        {order.map((key) => <li key={key} data-reorder-key={key}><button type="button" aria-label={`Move ${key}`} {...reorder.handle(key)} /></li>)}
      </ul>
    </>
  );
}

beforeEach(() => {
  // jsdom lays nothing out: each row sits at its index, the list at 0.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const row = this.closest("li");
    const index = row ? [...row.parentElement!.children].indexOf(row) : 0;
    const top = row ? index * ROW : 0;
    return { top, bottom: top + ROW, height: ROW, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
  // A frame never runs on its own: a drop places the rows itself.
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
});
afterEach(() => vi.restoreAllMocks());

const rows = () => screen.getAllByRole("button", { name: /^Move / }).map((handle) => handle.getAttribute("aria-label")!.slice(5));
const press = (key: string, y: number) => fireEvent.pointerDown(screen.getByRole("button", { name: `Move ${key}` }), { pointerId: 1, isPrimary: true, clientY: y, pointerType: "touch" });
const to = (y: number, type: "pointerMove" | "pointerUp" = "pointerMove") => act(() => { fireEvent[type](window, { pointerId: 1, clientY: y }); });

it("drops a row dragged by its handle past the rows whose middle it crossed", () => {
  const onMove = vi.fn();
  render(<List initial={["a", "b", "c", "d"]} onMove={onMove} />);
  press("a", 25);
  to(60);
  to(140);
  to(140, "pointerUp");
  expect(rows()).toEqual(["b", "c", "a", "d"]);
  expect(onMove).toHaveBeenCalledWith(["b", "c", "a", "d"], "a");
  expect(screen.getByRole("list").dataset.reordering).toBeUndefined();
});

it("moves nothing for a press that never travelled", () => {
  const onMove = vi.fn();
  render(<List initial={["a", "b"]} onMove={onMove} />);
  press("a", 25);
  to(27);
  to(27, "pointerUp");
  expect(onMove).not.toHaveBeenCalled();
});

it("ends a drag whose row went away, and the next one works", () => {
  render(<List initial={["a", "b", "c"]} />);
  press("a", 25);
  to(80);
  fireEvent.click(screen.getByRole("button", { name: "Close the first" }));
  expect(screen.getByRole("list").dataset.reordering).toBeUndefined();
  for (const row of screen.getAllByRole("listitem")) expect(row.style.translate).toBe("");
  to(80, "pointerUp");
  expect(rows()).toEqual(["b", "c"]);
  press("b", 25);
  to(80);
  to(80, "pointerUp");
  expect(rows()).toEqual(["c", "b"]);
});

it("ends a drag over rows that changed under it, so the drop never lands where it wasn't shown", () => {
  const onMove = vi.fn();
  render(<List initial={["a", "b", "c", "d"]} onMove={onMove} />);
  press("b", 75);
  to(140);
  fireEvent.click(screen.getByRole("button", { name: "Close the first" }));
  to(140, "pointerUp");
  expect(onMove).not.toHaveBeenCalled();
  expect(rows()).toEqual(["b", "c", "d"]);
});

it("puts a row back where it was when the system takes the pointer", () => {
  render(<List initial={["a", "b"]} />);
  press("a", 25);
  to(80);
  act(() => { fireEvent.pointerCancel(window, { pointerId: 1 }); });
  expect(rows()).toEqual(["a", "b"]);
  expect(screen.getAllByRole("listitem")[0]!.style.translate).toBe("");
});

it("moves a row one place with its arrow keys", () => {
  render(<List initial={["a", "b", "c"]} />);
  fireEvent.keyDown(screen.getByRole("button", { name: "Move c" }), { key: "ArrowUp" });
  expect(rows()).toEqual(["a", "c", "b"]);
  fireEvent.keyDown(screen.getByRole("button", { name: "Move a" }), { key: "ArrowUp" });
  expect(rows()).toEqual(["a", "c", "b"]);
});
