import { localFilePath } from "./file-links";
import { parseMarkdown, type MdBlock, type MdSpan } from "./markdown";
import type { TranscriptEntry, TranscriptPart } from "./types";

export type ChatFileKind = "file" | "photo" | "video";

export interface ChatFileReference {
  path: string;
  name: string;
  kind: ChatFileKind;
  mentions: number;
  edited: boolean;
  firstSeen: { entryId: string; timestamp: string; role: TranscriptEntry["role"] };
}

const PHOTO_EXTENSION = /\.(?:png|jpe?g|gif|webp)$/i;
const QUOTED_CANDIDATE = /(["'`])([^"'`\n]{1,4096})\1/g;
// This deliberately recognises only the extensions already accepted by localFilePath. The bridge
// remains authoritative about whether the named file exists, is inside the pane cwd, is private,
// and is small enough to preview.
// Directory segments exclude separators so a missing extension cannot trigger exponential backtracking.
const BARE_CANDIDATE = /(?:^|[\s([{:;,=])((?:\.{0,2}\/|\/)?(?:[^\s"'`<>()[\]{}|\/\\]+\/)*[^\s"'`<>()[\]{}|\/\\]+\.(?:md|markdown|mdx|pdf|txt|log|csv|tsv|json|jsonc|jsonl|ya?ml|toml|xml|[cm]?js|jsx|ts|tsx|py|rb|sh|bash|zsh|s?css|html?|svg|sql|rs|go|java|kt|swift|c|h|cpp|hpp|graphql|prisma|diff|patch|ini|conf|rst|png|jpe?g|gif|webp|mp4|m4v|mov|webm)(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)?)(?=$|[\s),.;!?\]}])/gi;
const SPECIAL_NAME_CANDIDATE = /(?:^|[\s([{:;,=])((?:\.{0,2}\/|\/)?(?:[^\s"'`<>()[\]{}|\/\\]+\/)*(?:readme|licen[sc]e|dockerfile|makefile|\.gitignore|\.gitattributes|\.editorconfig)(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)?)(?=$|[\s),.;!?\]}])/gi;

function normalisePath(path: string): string {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.replace(/\/{2,}/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && parts.length > 0 && parts.at(-1) !== "..") parts.pop();
    else parts.push(part);
  }
  const joined = parts.join("/");
  return absolute ? `/${joined}` : joined || ".";
}

function markdownPaths(text: string): string[] {
  const paths: string[] = [];
  const spans = (items: MdSpan[]) => {
    for (const span of items) {
      if (span.kind === "file") paths.push(span.path);
      else if (span.kind === "bold" || span.kind === "italic" || span.kind === "link") spans(span.spans);
      else if (span.kind === "code") {
        const path = localFilePath(span.text);
        if (path) paths.push(path);
      }
    }
  };
  const block = (item: MdBlock) => {
    if (item.kind === "heading" || item.kind === "paragraph" || item.kind === "quote") spans(item.spans);
    else if (item.kind === "list") item.items.forEach(spans);
    else if (item.kind === "table") {
      item.header.forEach(spans);
      item.rows.flat().forEach(spans);
    }
  };
  parseMarkdown(text).forEach(block);
  return paths;
}

/** Extract previewable local-file mentions from prose and compact tool summaries/results. */
export function filePathsInText(text: string): string[] {
  const paths = markdownPaths(text);
  for (const match of text.matchAll(QUOTED_CANDIDATE)) {
    const path = localFilePath(match[2] ?? "");
    if (path) paths.push(path);
  }
  for (const match of text.matchAll(BARE_CANDIDATE)) {
    const path = localFilePath(match[1] ?? "");
    if (path) paths.push(path);
  }
  for (const match of text.matchAll(SPECIAL_NAME_CANDIDATE)) {
    const path = localFilePath(match[1] ?? "");
    if (path) paths.push(path);
  }
  return paths;
}

function textInPart(part: TranscriptPart): string[] {
  if (part.kind === "text" || part.kind === "thinking") return [part.text];
  return [part.summary, part.result?.text ?? ""];
}

/** Oldest-first input produces stable first-seen ordering; repeat mentions collapse by path. */
export function chatFileReferences(entries: TranscriptEntry[]): ChatFileReference[] {
  const references = new Map<string, ChatFileReference>();
  for (const entry of entries) {
    const perEntry = new Set<string>();
    for (const part of entry.parts) {
      for (const text of textInPart(part)) {
        for (const candidate of filePathsInText(text)) {
          const path = localFilePath(candidate);
          if (!path) continue;
          const normal = normalisePath(path);
          if (perEntry.has(normal)) {
            if (part.kind === "tool" && !part.result?.isError && /write|edit|patch|file.?change/i.test(part.name)) {
              const existing = references.get(normal);
              if (existing) existing.edited = true;
            }
            continue;
          }
          perEntry.add(normal);
          const existing = references.get(normal);
          const edited = part.kind === "tool" && !part.result?.isError && /write|edit|patch|file.?change/i.test(part.name);
          if (existing) {
            existing.edited ||= edited;
            existing.mentions++;
            continue;
          }
          references.set(normal, {
            path: normal,
            name: normal.split("/").at(-1) ?? normal,
            kind: PHOTO_EXTENSION.test(normal) ? "photo" : /\.(mp4|m4v|mov|webm)$/i.test(normal) ? "video" : "file",
            edited,
            mentions: 1,
            firstSeen: { entryId: entry.uuid, timestamp: entry.ts, role: entry.role },
          });
        }
      }
    }
  }
  return [...references.values()];
}
