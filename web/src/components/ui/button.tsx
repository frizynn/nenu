import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// The primary action is ink (foreground fill, background label), one per surface; the blue accent is
// for focus, links and on-states. Unavailable comes from its own tokens rather than opacity, which
// made a disabled primary the brightest block on a dark screen. A button disabled only while its own
// action runs says aria-busy and keeps its look. Focus is the app-wide ring (index.css).
// Heights live in the ui-button-* classes (index.css, components layer): 44px on a coarse pointer,
// and a caller's own h-* or size-* still wins. `block` is the large primary of a card or a sheet. The
// label is on the type scale: footnote at a desk, subhead on a coarse pointer, body for the large ones.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-footnote coarse:text-subhead font-medium transition-[color,background-color,border-color,opacity,scale] duration-120 ease-out motion-reduce:transition-none disabled:pointer-events-none disabled:not-aria-busy:text-disabled-foreground [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 active:scale-[0.96] motion-reduce:active:scale-100 select-none",
  {
    variants: {
      variant: {
        default: "bg-foreground text-background hover:bg-foreground/90 disabled:not-aria-busy:bg-disabled",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:not-aria-busy:bg-disabled",
        outline: "border bg-background hover:bg-hover hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80 disabled:not-aria-busy:bg-disabled",
        ghost: "hover:bg-hover hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "ui-button-default px-4 py-2 has-[>svg]:px-3",
        sm: "ui-button-sm rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "ui-button-lg rounded-md px-6 has-[>svg]:px-4 text-body coarse:text-body",
        icon: "ui-button-icon",
        // A card's or a sheet's one commit (Submit 3, Choose Boxy, Answer in thread): full width, the
        // option rows' radius and type, so the action and the choices above it read as one family.
        // min-h, not h: a long label wraps instead of running past the card. Its press is 0.98: the
        // base 0.96 visibly jumps a bar this wide.
        block: "min-h-10 w-full whitespace-normal rounded-lg px-4 py-2 text-center text-body coarse:text-body coarse:min-h-11 has-[>svg]:px-4 active:scale-[0.98]",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

function Button({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
  return (
    <button
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

// `buttonVariants` is exported so a real <a> can wear the button's clothes where a navigation, not a
// click handler, is the point — see the access-refused banner's "Sign in".
export { Button, buttonVariants };
