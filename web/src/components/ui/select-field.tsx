import type { ComponentProps } from "react";
import { ChevronDown } from "lucide-react";

import { inputField } from "@/components/ui/field";
import { cn } from "@/lib/utils";

/**
 * A native select in the field look, so a phone still opens its own picker. WebKit draws a bare
 * select as its own control (a double arrow, no padding, 26 px tall whatever the min-height), so the
 * control is drawn here instead: no native appearance, and a chevron that a tap passes through.
 * `className` places the field; the look is the same everywhere.
 */
export function SelectField({ className, ...props }: ComponentProps<"select">) {
  return (
    <span className={cn("relative flex w-full min-w-0", className)}>
      <select className={cn(inputField, "min-w-0 appearance-none pr-9 disabled:text-disabled-foreground")} {...props} />
      <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground" />
    </span>
  );
}
