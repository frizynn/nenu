import { useContext, useId, useState } from "react";
import { ChevronRight, TriangleAlert, Wrench } from "lucide-react";
import { FileMediaContext } from "@/lib/file-preview-context";
import { localFilePath } from "@/lib/file-links";
import { IMAGE_EXTENSION, imageLabel } from "@/lib/message-images";
import { splitHighlight } from "@/lib/transcript-search";
import type { TranscriptPart } from "@/lib/types";
import { MediaViewerContext, type MediaViewer } from "./file-preview-provider";
import { ImageStrip, type StripImage } from "./message-images";

type ToolPart = Extract<TranscriptPart, { kind: "tool" }>;
interface Props {
  /** `owner` is the entry the call sits in, which addresses the images its result carries. */
  calls: Array<{ id: string; part: ToolPart; entryId?: string; owner?: string }>;
  query?: string;
  active?: boolean;
  focusedEntryId?: string;
}

function matches(part: ToolPart, query: string) {
  const needle = query.trim().toLowerCase();
  return !!needle && [part.name, part.summary, part.result?.text ?? ""].some((text) => text.toLowerCase().includes(needle));
}

function Highlight({ text, query }: { text: string; query: string }) {
  return <>{splitHighlight(text, query).map((piece, index) => piece.hit
    ? <mark key={index} className="rounded-sm bg-amber-300/70 text-inherit dark:bg-amber-500/40">{piece.text}</mark>
    : <span key={index}>{piece.text}</span>)}</>;
}

// Tools that show the model an image by path; their summary is the path they read.
const VIEW_TOOL = /^(read|view_?image|read_?file|view)$/i;

/**
 * What a call showed the agent: images its result carries in the journal, image files it delivered,
 * or the image a read tool opened by path. Journal images need their entry (`owner`) and the viewer.
 */
function toolImages(part: ToolPart, owner: string | undefined, viewer: MediaViewer | null, url: ((path: string) => string) | null): StripImage[] {
  const attachments = part.result?.attachments ?? [];
  const inline = attachments.flatMap((a) => a.kind === "image" ? [a] : []);
  if (inline.length) return owner ? inline.map(({ index }, i) => ({
    src: viewer?.journalUrl(owner, index), label: imageLabel(i), item: { kind: "journal", entry: owner, index, label: imageLabel(i) },
  })) : [];
  const read = VIEW_TOOL.test(part.name) && !part.result?.isError ? localFilePath(part.summary) : null;
  const files = [...attachments.flatMap((a) => a.kind === "file" ? [a.path] : []), ...(read ? [read] : [])].filter((path) => IMAGE_EXTENSION.test(path));
  return url ? files.map((path) => ({ src: url(path), label: path.split("/").at(-1) ?? path, item: { kind: "file", path } })) : [];
}

/** One gallery across several calls numbers its images once, in order. */
export function relabel(images: StripImage[]): StripImage[] {
  return images.map((image, i) => image.item.kind === "journal"
    ? { ...image, label: imageLabel(i), item: { ...image.item, label: imageLabel(i) } }
    : image);
}

export function useToolImages() {
  const viewer = useContext(MediaViewerContext);
  const url = useContext(FileMediaContext);
  return (part: ToolPart, owner?: string) => toolImages(part, owner, viewer, url);
}

function ToolRow({ id, part, entryId, owner, query, active, focused }: { id: string; part: ToolPart; entryId?: string; owner?: string; query: string; active: boolean; focused: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const images = useToolImages();
  const open = expanded || focused || matches(part, query);
  const status = part.result?.isError ? "Failed" : !part.result ? active ? "Running…" : "No output recorded" : null;
  return (
    <div data-tool={id} data-turn={entryId} className="min-w-0">
      <button
        type="button"
        data-work-toggle
        aria-label={[part.name, part.summary, status, part.result?.truncated ? "Truncated" : null].filter(Boolean).join(" ")}
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setExpanded((value) => !value)}
        className="flex min-h-11 w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-1 text-left text-xs leading-5 outline-none hover:bg-accent/20 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 md:min-h-7"
      >
        <ChevronRight aria-hidden="true" className={`size-3.5 shrink-0 text-muted-foreground/65 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`} />
        <span className="max-w-[45%] shrink-0 truncate font-medium"><Highlight text={part.name} query={query} /></span>
        {part.summary && <span className="min-w-0 flex-1 truncate text-muted-foreground/65"><Highlight text={part.summary} query={query} /></span>}
        {status && <span className={`shrink-0 text-[11px] ${part.result?.isError ? "text-destructive" : "text-muted-foreground"}`}>{status}</span>}
        {part.result?.truncated && <span className="shrink-0 text-[11px] text-muted-foreground">Truncated</span>}
      </button>
      <ImageStrip images={images(part, owner)} label="Images the tool returned" className="px-6 pb-1" />
      {open && <div id={contentId} className="min-w-0 space-y-2 px-6 pb-2 text-xs">
        {part.summary && <pre className="min-w-0 font-mono text-[11px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]"><Highlight text={part.summary} query={query} /></pre>}
        {part.result ? <pre className="min-w-0 font-mono text-[11px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]"><Highlight text={part.result.text} query={query} />{part.result.truncated && <span className="text-muted-foreground">{"\n… output truncated"}</span>}</pre>
          : <p className="text-muted-foreground">{active ? "Running…" : "No output recorded"}</p>}
      </div>}
    </div>
  );
}

/** Consecutive tool activity; the parent assigns entry markers only to their first tool part. */
export function WorkLogTools({ calls, query = "", active = false, focusedEntryId }: Props) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const images = useToolImages();
  if (calls.length === 0) return null;
  const open = expanded || calls.some(({ part, entryId }) => matches(part, query) || (!!focusedEntryId && entryId === focusedEntryId));
  const names = [...new Set(calls.map(({ part }) => part.name))];
  const errors = calls.filter(({ part }) => part.result?.isError).length;
  const truncated = calls.filter(({ part }) => part.result?.truncated).length;
  const label = `${calls.length} tool ${calls.length === 1 ? "call" : "calls"} · ${names.slice(0, 3).join(", ")}${names.length > 3 ? `, +${names.length - 3} more` : ""}`;
  return (
    <div className="work-log-tools min-w-0 text-foreground/85">
      <button
        type="button"
        data-work-toggle
        aria-label={[label, errors ? `${errors} ${errors === 1 ? "error" : "errors"}` : null, truncated ? `${truncated} truncated` : null].filter(Boolean).join(", ")}
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setExpanded((value) => !value)}
        className="flex min-h-11 w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-1 text-left text-xs leading-5 outline-none hover:bg-accent/20 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 md:min-h-7"
      >
        <ChevronRight aria-hidden="true" className={`size-3.5 shrink-0 text-muted-foreground/65 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`} />
        <Wrench aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground/65" />
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{label}</span>
        {!!errors && <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-destructive"><TriangleAlert aria-hidden="true" className="size-3" />{errors} {errors === 1 ? "error" : "errors"}</span>}
        {!!truncated && <span className="shrink-0 text-[11px] text-muted-foreground">{truncated} truncated</span>}
      </button>
      {!open && <ImageStrip images={relabel(calls.flatMap(({ part, owner }) => images(part, owner)))} label="Images the tools returned" className="px-6 pb-1" />}
      {open && <div id={contentId} className="min-w-0 pl-3">
        {calls.map(({ id, part, entryId, owner }) => <ToolRow key={id} id={id} part={part} entryId={entryId} owner={owner} query={query} active={active} focused={!!focusedEntryId && entryId === focusedEntryId} />)}
      </div>}
    </div>
  );
}
