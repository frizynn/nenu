import { resolve } from "node:path";

import type { TranscriptEntry } from "./types.ts";

/**
 * Absolute paths Claude Code confirmed it delivered through SendUserFile — from the harness's own
 * structured result (`toolUseResult.attachments`, which the Claude parser puts on the call's result),
 * never from the model's prose or the call's input. A result without them (a log from before the
 * parser read them, or a version that stops writing them) falls back to the result text's
 * "  <path> → file_uuid: …" lines.
 */
export function deliveredFilePaths(entries: readonly TranscriptEntry[]): string[] {
  return entries.flatMap((entry) => entry.parts.flatMap((part) => {
    if (part.kind !== "tool" || part.name !== "SendUserFile" || !part.result || part.result.isError) return [];
    const files = (part.result.attachments ?? []).flatMap((a) => a.kind === "file" ? [a.path] : []);
    if (files.length) return files.map((path) => resolve(path));
    return [...part.result.text.matchAll(/^ {2}(\/.+) → file_uuid: /gm)].map((match) => resolve(match[1]!));
  }));
}
