import type { ArtifactMetadata } from "./api";
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
  delivered: boolean;
  lastSeen: { entryId: string; timestamp: string; order: number };
  firstSeen: { entryId: string; timestamp: string; role: TranscriptEntry["role"] };
}

const PHOTO_EXTENSION = /\.(?:png|jpe?g|gif|webp)$/i;
/** The same image-or-link shape the Markdown parser reads; group 1 is the target. */
const MARKDOWN_LINK = /!?\[[^\]\n]*\]\((<[^>\n]+>|[^)\s]+)\)/g;
const QUOTED_CANDIDATE =/(["'`])([^"'`\n]{1,4096})\1/g;
// The scheme is bounded so a long dotted word is not rescanned from each of its letters.
const SCHEME_URL = /\b[a-z][a-z\d+.-]{0,31}:\/\/[^\s"'`<>]*/gi;
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

/** Every inline span of a Markdown text, nested spans included, in reading order. */
function markdownSpans(text: string): MdSpan[] {
  const out: MdSpan[] = [];
  const spans = (items: MdSpan[]) => {
    for (const span of items) {
      out.push(span);
      if (span.kind === "bold" || span.kind === "italic" || span.kind === "link") spans(span.spans);
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
  return out;
}

function markdownPaths(text: string, includeCode = true): string[] {
  return markdownSpans(text).flatMap((span) => {
    if (span.kind === "file" || span.kind === "image") return [span.path];
    const path = span.kind === "code" && includeCode ? localFilePath(span.text) : null;
    return path ? [path] : [];
  });
}

/** The local images a text already shows in place, as `![alt](path)`. */
export function markdownImagePaths(text: string): string[] {
  return markdownSpans(text).flatMap((span) => span.kind === "image" ? [span.path] : []);
}

/** Extract previewable local-file mentions from prose and compact tool summaries/results. */
export function filePathsInText(text: string): string[] {
  const paths = markdownPaths(text);
  // A link to a local file names it by its target; its label ("report.html") is only a caption and
  // must not become a second, relative mention that resolves somewhere else.
  text = text.replace(MARKDOWN_LINK, (link, target: string) => localFilePath(target) ? " " : link);
  // A web URL names a page on another host: what follows its port (`:8443/page.html`) or sits in its
  // query (`?file=a.pdf`) is not a file in the pane's folder.
  text = text.replace(SCHEME_URL, (url) => localFilePath(url) ? url : " ");
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
  // Injected text (a skill's body, a notification) is not the conversation; its paths are not the chat's files.
  if (part.kind === "image" || part.kind === "context") return [];
  if (part.kind === "text" || part.kind === "thinking") return [part.text];
  return [part.summary, part.result?.text ?? ""];
}

/** Files the harness itself reports delivering (Claude's SendUserFile), as the tool result names them. */
export function sentFiles(part: TranscriptPart): string[] {
  return part.kind === "tool" ? (part.result?.attachments ?? []).flatMap((a) => a.kind === "file" ? [a.path] : []) : [];
}

/** Oldest-first input produces stable first-seen ordering; repeat mentions collapse by path. */
export function chatFileReferences(entries: TranscriptEntry[]): ChatFileReference[] {
  const references = new Map<string, ChatFileReference>();
  for (const [order, entry] of entries.entries()) {
    const perEntry = new Set<string>();
    for (const part of entry.parts) {
      const sent = sentFiles(part);
      const deliveredPaths = new Set(entry.role === "assistant" && part.kind === "text" ? markdownPaths(part.text, false).map(normalisePath) : sent.map(normalisePath));
      for (const text of textInPart(part)) {
        for (const candidate of [...filePathsInText(text), ...sent]) {
          const path = localFilePath(candidate);
          if (!path) continue;
          const normal = normalisePath(path);
          const delivered = deliveredPaths.has(normal);
          const known = references.get(normal);
          if (known) known.delivered ||= delivered;
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
            existing.lastSeen = { entryId: entry.uuid, timestamp: entry.ts, order };
            continue;
          }
          references.set(normal, {
            path: normal,
            name: normal.split("/").at(-1) ?? normal,
            kind: PHOTO_EXTENSION.test(normal) ? "photo" : /\.(mp4|m4v|mov|webm)$/i.test(normal) ? "video" : "file",
            edited,
            delivered,
            lastSeen: { entryId: entry.uuid, timestamp: entry.ts, order },
            mentions: 1,
            firstSeen: { entryId: entry.uuid, timestamp: entry.ts, role: entry.role },
          });
        }
      }
    }
  }
  return [...references.values()];
}

export function fileExtension(file: ChatFileReference): string {
  return file.name.includes(".") ? file.name.split(".").at(-1)!.toLowerCase() : "no extension";
}
export type ArtifactKind = "designboard" | "document" | "media";
export function artifactKind(file: ChatFileReference, designboard: boolean): ArtifactKind | null {
  if (designboard) return "designboard";
  if (!file.delivered || !/\.(pdf|md|markdown|csv|tsv|png|jpe?g|gif|webp|svg|mp4|m4v|mov|webm)$/i.test(file.path)) return null;
  return file.kind === "file" ? "document" : "media";
}

/** Whether the Artifacts list needs the bridge's answer (`inspect`) before it can place a name. */
export function artifactCandidate(file: ChatFileReference): boolean {
  return /\.html?$/i.test(file.path) || (file.kind === "photo" && (file.firstSeen.role !== "user" || file.delivered));
}

export interface ArtifactSections {
  /** Designboards, documents and videos the agent delivered, newest first. */
  delivered: ChatFileReference[];
  /** Images the agent delivered or wrote that Nenu can serve, with the path it serves them by. */
  images: Array<ChatFileReference & { src: string }>;
  /** Images the agent named beyond the pane's folder: no preview, only the confirmed Open (ADR 0063). */
  outside: ChatFileReference[];
}

/**
 * What the agent made and handed over, placed by what the bridge said about each name. An image gets
 * a thumbnail only when the bridge can serve it; one beyond the folder waits behind the confirmed
 * Open. An image only named inside the folder is not an artifact (Project lists it), and the
 * operator's own images never are.
 */
export function artifactSections(references: ChatFileReference[], found: ReadonlyMap<string, ArtifactMetadata>): ArtifactSections {
  const sections: ArtifactSections = { delivered: [], images: [], outside: [] };
  for (const file of [...references].sort((a, b) => b.lastSeen.order - a.lastSeen.order)) {
    const known = found.get(file.path);
    if (file.kind !== "photo") {
      if (artifactKind(file, known?.state === "preview" && Boolean(known.designboard))) sections.delivered.push(file);
    } else if (artifactCandidate(file)) {
      if (known?.state === "outside") sections.outside.push(file);
      else if (known?.state === "preview" && (file.delivered || file.edited)) sections.images.push({ ...file, src: known.resolved ?? file.path });
    }
  }
  return sections;
}
