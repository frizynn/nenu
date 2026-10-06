import { useState } from "react";
import { ImageIcon, Loader2, RotateCw, X } from "lucide-react";

import type { Attachment } from "@/hooks/use-composer-attachments";
import { imageLabel } from "@/lib/message-images";
import { cn } from "@/lib/utils";

/** The draft's images, above the text: thumbnail, "Image N", and a remove control per chip. */
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
    <ul aria-label="Attached images" className="flex flex-wrap gap-1.5 px-1.5 pt-1.5">
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
      <span className="relative grid size-8 shrink-0 place-items-center overflow-hidden rounded-md bg-muted">
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
        "flex h-11 shrink-0 items-center rounded-lg border bg-background pl-1.5",
        failed ? "border-destructive/50" : "border-border/70",
      )}
      title={failed ? item.error : undefined}
    >
      {failed ? (
        <button
          type="button"
          className="flex h-full items-center gap-2 pr-1 text-left"
          onClick={onRetry}
          disabled={disabled}
          aria-label={`Retry ${label}${item.error ? `: ${item.error}` : ""}`}
        >
          {body}
        </button>
      ) : (
        <span className="flex h-full items-center gap-2 pr-1" aria-busy={item.status === "uploading"}>
          {body}
        </span>
      )}
      <button
        type="button"
        className="grid h-full w-11 place-items-center rounded-r-lg text-muted-foreground hover:text-foreground"
        onPointerDown={(e) => e.preventDefault()}
        onClick={onRemove}
        aria-label={`Remove ${label}`}
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </li>
  );
}
