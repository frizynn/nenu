import { render } from "@testing-library/react";

import { resting, StateMark, StatusDot, type MarkState } from "./status-badge";

const mark = (state: MarkState) => render(<StateMark state={state} />).container.firstElementChild!;

describe("StateMark", () => {
  // Each state by its shape, so a list reads in grey too: the 1.38 dots told needs, working and
  // review apart only by colour (marcas-alternativas-gris.png).
  it("draws a different glyph for every state that is alive", () => {
    const glyphs = (["needs", "review", "working", "limit"] as const).map((state) => mark(state).getAttribute("class")!.match(/icon-[a-z-]+/)?.[0]);
    expect(glyphs).toEqual(["icon-circle-alert", "icon-circle-check", "icon-circle-dashed", "icon-hourglass"]);
  });

  it("colours only what asks something of you", () => {
    expect(mark("needs")).toHaveClass("text-status-blocked");
    expect(mark("review")).toHaveClass("text-primary");
    // A usage limit resumes by itself at its reset: it asks nothing of you (ADR 0120).
    for (const state of ["working", "limit"] as const) expect(mark(state)).toHaveClass("text-muted-foreground");
  });

  it("draws nothing for a resting agent, keeping its box so names stay in line", () => {
    const idle = mark("idle");
    expect(idle.tagName).toBe("SPAN");
    expect(idle.childNodes).toHaveLength(0);
    expect(idle).toHaveClass("size-3.5");
  });

  it("stays still: a state that lasts is never an animation", () => {
    const { container } = render(<><StateMark state="working" /><StateMark state="needs" /></>);
    expect(container.querySelector("[class*=animate-]")).toBeNull();
  });
});

describe("StatusDot", () => {
  it("draws an agent's status as its state's glyph", () => {
    const glyph = (status: Parameters<typeof StatusDot>[0]["status"]) => render(<StatusDot status={status} />).container.firstElementChild!.getAttribute("data-node-state");
    expect([glyph("blocked"), glyph("working"), glyph("done"), glyph("idle"), glyph("unknown")]).toEqual(["needs", "working", "review", "idle", "idle"]);
  });
});

describe("resting", () => {
  it("names the statuses that draw nothing, for places with no column to keep", () => {
    expect((["blocked", "working", "done", "idle", "unknown"] as const).filter(resting)).toEqual(["idle", "unknown"]);
  });
});
