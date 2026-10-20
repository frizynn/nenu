import { cn } from "@/lib/utils";

// The form fields' one look. Its own colour and weight: a Field's label is muted and medium, and a
// control inherits both.
export const inputField =
  "h-10 w-full rounded-lg border border-border bg-background px-3 text-body font-normal text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring coarse:h-11";

/** A text area grows from its rows, not the input's height. */
export const textField = cn(inputField, "h-auto resize-none py-2 coarse:h-auto");
