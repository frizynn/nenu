import * as React from "react";

import { useAutosize } from "@/hooks/use-autosize";
import { cn } from "@/lib/utils";

// Auto-growing message composer. It's just a styled textarea, so the phone's native keyboard —
// including voice dictation via the keyboard mic — works for free. Auto-capitalization is off: this
// drives a terminal (shell commands, slash-commands, agent replies) where a forced leading capital
// is usually wrong. (Callers can still override via props.)
function ChatInput({ className, ref, ...props }: React.ComponentProps<"textarea">) {
  const field = React.useRef<HTMLTextAreaElement | null>(null);
  useAutosize(field, props.value);
  const setRef = React.useCallback((node: HTMLTextAreaElement | null) => {
    field.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  }, [ref]);
  return (
    <textarea
      ref={setRef}
      data-slot="chat-input"
      autoComplete="off"
      autoCapitalize="none"
      className={cn(
        "field-sizing-content max-h-[min(28dvh,10rem)] min-h-11 w-full resize-none overflow-y-auto rounded-md border border-input bg-transparent px-3 py-2.5 text-base shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { ChatInput };
