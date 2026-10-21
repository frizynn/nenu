import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";

import { declarations } from "@/test/css-rules";
import { Button, buttonVariants } from "./button";

// jsdom compiles no Tailwind, so these pin the classes and rules the bench then measures:
// 44px on a coarse pointer, ink for the primary action, disabled from tokens, one focus ring.
const indexCss = readFileSync(resolve(import.meta.dirname, "../../index.css"), "utf8");
const COMPONENTS = "@layer components";
const COARSE = "@media (pointer: coarse)";
const variants = ["default", "destructive", "outline", "secondary", "ghost", "link"] as const;

describe("Button", () => {
  it("fills the primary action with ink and keeps the accent for focus and links", () => {
    render(<Button>Start coordinator</Button>);
    const button = screen.getByRole("button", { name: "Start coordinator" });
    expect(button).toHaveClass("bg-foreground", "text-background");
    expect(button).not.toHaveClass("bg-primary");
  });

  it("gives default, sm and icon buttons a 44 by 44 target on a coarse pointer, unless the caller sizes them", () => {
    for (const size of ["default", "sm", "icon"] as const) {
      expect(buttonVariants({ size })).toContain(`ui-button-${size}`);
      const coarse = declarations(indexCss, `.ui-button-${size}`, [COMPONENTS, COARSE]);
      expect(coarse.height, size).toBe("2.75rem");
      // Width too: "1h" alone measured 39 wide.
      expect(coarse["min-width"] ?? coarse.width, size).toBe("2.75rem");
    }
    // The sizes sit in the components layer, so a caller's h-6 or size-9 still wins.
    expect(declarations(indexCss, ".ui-button-default", [COMPONENTS]).height).toBe("2.25rem");
  });

  it("has one large primary for a card or a sheet: full width, 40 fine and 44 coarse, its label centred at body 500, radius lg", () => {
    // The same family as the option rows above it (lg, body/500), so a card's commit and its
    // choices read as one system instead of a pill, a slab and a row (QA 1).
    render(<Button size="block">Submit 3</Button>);
    const button = screen.getByRole("button", { name: "Submit 3" });
    expect(button).toHaveClass("bg-foreground", "w-full", "min-h-10", "coarse:min-h-11", "rounded-lg", "text-body", "font-medium", "justify-center", "text-center");
    // A long label wraps inside the button instead of running past the card's edge.
    expect(button).toHaveClass("whitespace-normal");
    for (const replaced of ["rounded-md", "text-footnote", "whitespace-nowrap"]) expect(button).not.toHaveClass(replaced);
    // A press on a bar this wide stays a nudge (direction.md: 0.97 to 0.98), not the base's 0.96.
    expect(button).toHaveClass("active:scale-[0.98]");
    expect(button).not.toHaveClass("active:scale-[0.96]");
  });

  it("draws unavailable from its own tokens, never as opacity over a fill", () => {
    for (const variant of variants) {
      const classes = buttonVariants({ variant }).split(" ");
      expect(classes.join(" "), variant).not.toMatch(/disabled:opacity/);
      expect(classes, variant).toContain("disabled:not-aria-busy:text-disabled-foreground");
    }
    for (const variant of ["default", "destructive", "secondary"] as const) expect(buttonVariants({ variant }).split(" ")).toContain("disabled:not-aria-busy:bg-disabled");
  });

  it("leaves a busy button its own look: disabled while it works, but not greyed out", () => {
    // A tapped quick reply or a "Creating…" submit is disabled so it cannot fire twice. Marked
    // aria-busy, it keeps its fill instead of reading as the faintest control on the screen.
    for (const variant of variants) expect(buttonVariants({ variant }).split(" "), variant).not.toContain("disabled:text-disabled-foreground");
    for (const variant of ["default", "destructive", "secondary"] as const) expect(buttonVariants({ variant }).split(" ")).not.toContain("disabled:bg-disabled");
  });

  it("sits flat on its surface: shadows belong to floating layers", () => {
    for (const variant of variants) expect(buttonVariants({ variant }), variant).not.toMatch(/(^|\s)shadow-/);
  });

  it("leaves focus to the one app-wide ring", () => {
    for (const variant of variants) expect(buttonVariants({ variant })).not.toMatch(/ring-\[3px\]|outline-none/);
  });
});
