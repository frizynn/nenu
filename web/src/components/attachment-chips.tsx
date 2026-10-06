import { useState } from "react";
import { ImageIcon, Loader2, RotateCw, X } from "lucide-react";

import type { Attachment } from "@/hooks/use-composer-attachments";
import { imageLabel } from "@/lib/message-images";
import { cn } from "@/lib/utils";

/**
 * The draft's images, above the text: a 40px thumbnail, "Image N", and a small remove control whose
 * hit area grows to 44px through a pseudo-element. One row; it scrolls sideways when it overflows.
 */
export function AttachmentChips({
  items,
  onRemove,
  onRetry,
  disabled = false,
}: {
  items: readonly Attachment[];
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  disabled?: boolean;
}) {
  if (!items.length) return null;
  return (
    <ul aria-label="Attached images" className="flex gap-1.5 overflow-x-auto px-1.5 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {items.map((item, index) => (
        <AttachmentChip
          key={item.id}
          item={item}
          label={imageLabel(index)}
          onRemove={() => onRemove(item.id)}
          onRetry={() => onRetry(item.id)}
          disabled={disabled}
        />
      ))}
    </ul>
  );
}

function AttachmentChip({
  item,
  label,
  onRemove,
  onRetry,
  disabled,
}: {
  item: Attachment;
  label: string;
  onRemove: () => void;
  onRetry: () => void;
  disabled: boolean;
}) {
  const [broken, setBroken] = useState(false);
  const failed = item.status === "error";
  const body = (
    <>
      <span className="relative grid size-10 shrink-0 place-items-center overflow-hidden rounded-l-[calc(var(--radius)-1px)] bg-muted">
        {broken ? (
          <ImageIcon aria-hidden="true" className="size-4 text-muted-foreground" />
        ) : (
          <img src={item.url} alt="" className="size-full object-cover" onError={() => setBroken(true)} />
        )}
        {item.status === "uploading" && (
          <span className="absolute inset-0 grid place-items-center bg-background/60">
            <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
          </span>
        )}
        {failed && (
          <span className="absolute inset-0 grid place-items-center bg-background/70 text-destructive">
            <RotateCw aria-hidden="true" className="size-4" />
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-col items-start leading-tight">
        <span className="text-xs font-medium">{label}</span>
        {item.status !== "ready" && (
          <span className={cn("text-[11px]", failed ? "text-destructive" : "text-muted-foreground")}>
            {failed ? "Failed · tap to retry" : "Uploading…"}
          </span>
        )}
      </span>
    </>
  );
  return (
    <li
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-lg border bg-background pr-1",
        failed ? "border-destructive/50" : "border-border/70",
      )}
      title={failed ? item.error : undefined}
    >
      {failed ? (
        <button
          type="button"
          className="flex h-full items-center gap-2 text-left"
          onClick={onRetry}
          disabled={disabled}
          aria-label={`Retry ${label}${item.error ? `: ${item.error}` : ""}`}
        >
          {body}
        </button>
      ) : (
        <span className="flex h-full items-center gap-2" aria-busy={item.status === "uploading"}>
          {body}
        </span>
      )}
      <button
        type="button"
        className="relative grid size-6 place-items-center rounded-full text-muted-foreground after:absolute after:-inset-2.5 after:content-[''] hover:bg-muted hover:text-foreground"
        onPointerDown={(e) => e.preventDefault()}
        onClick={onRemove}
        aria-label={`Remove ${label}`}
      >
        <X aria-hidden="true" className="size-3" />
      </button>
    </li>
  );
}
