import { useState } from "react";
import { File as FileIcon, FileArchive, FileCode, FileImage, FileText, Pending, RotateCw, X, type IconComponent } from "@/components/ui/icon";

import type { Attachment } from "@/hooks/use-composer-attachments";
import { cn } from "@/lib/utils";

const ARCHIVE = /^(?:zip|gz|tgz|tar|bz2|xz|7z|rar|zst)$/;
const CODE = /^(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|sh|json|ya?ml|toml|html?|css|sql)$/;
const TEXT = /^(?:pdf|txt|md|csv|tsv|log|docx?|rtf)$/;

function extension(name: string): string | null {
  return /\.([A-Za-z0-9]{1,10})$/.exec(name)?.[1]!.toLowerCase() ?? null;
}

function fileIcon(item: Attachment, ext: string | null): IconComponent {
  if (item.image) return FileImage;
  if (ext && ARCHIVE.test(ext)) return FileArchive;
  if (ext && CODE.test(ext)) return FileCode;
  if (ext && TEXT.test(ext)) return FileText;
  return FileIcon;
}

/** "2.4 MB", "18 KB", "512 B". */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * The draft's files, inside the box above the text. A picture is a thumbnail with its number, "#N", the
 * one its chip in the text carries, and a round remove control at its corner; any other file is a 26px
 * tile with its icon, name, kind and size. Each remove control reaches 44px on a touch screen through
 * the shared .hit-area. One row; it scrolls sideways when it overflows.
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
  let pictures = 0;
  return (
    <ul aria-label="Attached files" className="composer-attachments flex gap-2.5 overflow-x-auto pr-2.5 pt-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {items.map((item) => item.image ? (
        <PictureTile key={item.id} item={item} number={++pictures} onRemove={() => onRemove(item.id)} onRetry={() => onRetry(item.id)} disabled={disabled} />
      ) : (
        <AttachmentChip
          key={item.id}
          item={item}
          label={item.name ?? "File"}
          onRemove={() => onRemove(item.id)}
          onRetry={() => onRetry(item.id)}
          disabled={disabled}
        />
      ))}
    </ul>
  );
}

/** A picture: its thumbnail, its number at the bottom left, remove at the top right. */
function PictureTile({ item, number, onRemove, onRetry, disabled }: { item: Attachment; number: number; onRemove: () => void; onRetry: () => void; disabled: boolean }) {
  const [broken, setBroken] = useState(false);
  const failed = item.status === "error";
  const label = `Image #${number}`;
  const frame = (
    <span className={cn("relative grid size-14 place-items-center overflow-hidden rounded-lg border bg-muted text-muted-foreground", failed ? "border-destructive/60" : "border-border/70")}>
      {item.url && !broken ? (
        <img src={item.url} alt="" className="size-full object-cover" onError={() => setBroken(true)} />
      ) : (
        <FileImage aria-hidden="true" className="size-4" />
      )}
      {item.status === "uploading" && (
        <span className="absolute inset-0 grid place-items-center bg-background/60">
          <Pending aria-hidden="true" className="size-4" />
        </span>
      )}
      {failed && (
        <span className="absolute inset-0 grid place-items-center bg-background/75 text-destructive">
          <RotateCw aria-hidden="true" className="size-4" />
        </span>
      )}
      <span aria-hidden="true" className="absolute bottom-1 left-1 rounded-sm bg-background/85 px-1 text-micro font-medium leading-4 text-foreground tabular-nums">#{number}</span>
    </span>
  );
  return (
    <li className="relative shrink-0" title={failed ? item.error : undefined}>
      {failed ? (
        <button type="button" className="block rounded-lg" onClick={onRetry} disabled={disabled} aria-label={`Retry ${label}${item.error ? `: ${item.error}` : ""}`}>
          {frame}
        </button>
      ) : (
        <span className="block" role="img" aria-label={item.status === "uploading" ? `${label}, uploading` : label} aria-busy={item.status === "uploading"}>
          {frame}
        </span>
      )}
      {/* .hit-area positions the button itself, so the corner is its wrapper's. */}
      <span className="absolute -right-1.5 -top-1.5">
        <button
          type="button"
          className="hit-area grid size-5 place-items-center rounded-full border border-border bg-background text-muted-foreground shadow-sm hover:text-foreground"
          onPointerDown={(e) => e.preventDefault()}
          onClick={onRemove}
          aria-label={`Remove ${label}`}
        >
          <X aria-hidden="true" className="size-3" />
        </button>
      </span>
    </li>
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
  const ext = item.name ? extension(item.name) : null;
  const Icon = fileIcon(item, ext);
  const kind = item.image ? "Photo" : ext?.toUpperCase() ?? "File";
  const meta = item.status === "uploading" ? "Uploading…" : failed ? "Failed · tap to retry" : [kind, item.size === undefined ? "" : formatSize(item.size)].filter(Boolean).join(" · ");
  const body = (
    <>
      <span className="relative grid size-[26px] shrink-0 place-items-center overflow-hidden rounded-md border border-border/70 bg-muted text-muted-foreground">
        {item.url && !broken ? (
          <img src={item.url} alt="" className="size-full object-cover" onError={() => setBroken(true)} />
        ) : (
          <Icon aria-hidden="true" className="size-3.5" />
        )}
        {item.status === "uploading" && (
          <span className="absolute inset-0 grid place-items-center bg-background/70">
            <Pending aria-hidden="true" className="size-3.5" />
          </span>
        )}
        {failed && (
          <span className="absolute inset-0 grid place-items-center bg-background/80 text-destructive">
            <RotateCw aria-hidden="true" className="size-3.5" />
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-col items-start leading-tight">
        <span className="max-w-40 truncate text-caption font-medium">{label}</span>
        <span className={cn("text-caption", failed ? "text-destructive" : "text-muted-foreground")}>{meta}</span>
      </span>
    </>
  );
  return (
    <li
      className={cn(
        "flex h-10 shrink-0 items-center gap-1 rounded-lg border bg-background pl-2 pr-1",
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
        className="hit-area grid size-6 place-items-center rounded-full text-muted-foreground hover:bg-hover hover:text-foreground"
        onPointerDown={(e) => e.preventDefault()}
        onClick={onRemove}
        aria-label={`Remove ${label}`}
      >
        <X aria-hidden="true" className="size-3" />
      </button>
    </li>
  );
}
