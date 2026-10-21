import { ChatCircleText, X } from "@/components/ui/icon";

import type { DiffComment } from "@/lib/diff-comments";

/**
 * The comments made on a diff for this pane, over its composer: one chip each, `file:line`, the
 * comment in its tooltip and a remove control. They go out first with the next message.
 */
export function DiffCommentChips({ comments, onRemove }: { comments: readonly DiffComment[]; onRemove: (comment: DiffComment) => void }) {
  if (!comments.length) return null;
  return (
    <ul aria-label="Comments on the diff" className="flex gap-1.5 overflow-x-auto px-1.5 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {comments.map((comment) => {
        const at = `${comment.path}:${comment.line}`;
        return (
          <li key={`${comment.side}${at}`} title={`${at}: ${comment.text}`} className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border/70 bg-background pl-2 pr-1 text-caption">
            <ChatCircleText aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="max-w-40 truncate font-mono">{comment.path.slice(comment.path.lastIndexOf("/") + 1)}:{comment.line}</span>
            <button
              type="button"
              className="hit-area grid size-6 place-items-center rounded-full text-muted-foreground hover:bg-hover hover:text-foreground"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => onRemove(comment)}
              aria-label={`Remove comment on ${comment.side === "-" ? "removed " : ""}${at}`}
            >
              <X aria-hidden="true" className="size-3" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
