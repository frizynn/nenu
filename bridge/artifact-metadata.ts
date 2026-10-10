import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { designboardTitleFromHead } from "./designboard.ts";
import type { TranscriptEntry } from "./journal/types.ts";
import { FILE_STATE_HEADER, openPaneFile, readPaneBytes, type PaneFile } from "./pane-files.ts";

/**
 * What a file name in the conversation leads to, asked before the chat offers to open it. `preview`
 * opens in Nenu's viewer, `outside` only through the confirmed Open (ADR 0063), and `missing`
 * reaches nothing this device may look at.
 */
export type ArtifactMetadata = { path: string } & Located;
/** `resolved` is the absolute file the name leads to, when the name alone would not find it. */
type Located =
  | { state: "preview"; resolved?: string; /** The canvas title, when the file is a designboard. */ designboard?: string }
  | { state: "outside"; resolved?: string }
  | { state: "missing" };

/** Where else a name may live, from the pane's own journal and the device asking. */
export interface MentionScope {
  /** Files the agent delivered with SendUserFile: the preview's own exception (pane-files.ts). */
  delivered?: () => Promise<readonly string[]>;
  /** Folders the conversation names, newest first ({@link mentionedFolders}). */
  folders?: () => Promise<readonly string[]>;
  /**
   * The real path of a file outside the pane's folder, when the device asking could open it through
   * a confirmed link anyway (ADR 0063). Absent for any other device, which then learns nothing about
   * files there.
   */
  openable?: (path: string) => Promise<string | null>;
  /** What `~/` means: the bridge user's home. */
  home?: string;
}

/** Canvas templates put the embedded document within the first ~15 KB; the rest is artboards. */
const HEAD_BYTES = 64 * 1024;
const CACHE_MAX = 256;
/** Title (or null) per file identity, so the files browser re-listing a folder costs only opens. */
const titles = new Map<string, string | null>();
/** A path in prose: absolute or under ~, up to whitespace, a quote, a bracket, a comma or a semicolon. */
const PROSE_PATH = /(?:^|[\s`'"([{=:])(~?\/[^\s`'"()<>[\]{}|,;]+)/g;
const MAX_FOLDERS = 64;

const expandHome = (name: string, home: string) => name.startsWith("~/") ? join(home, name.slice(2)) : name;

async function titleOf(file: PaneFile): Promise<string | null> {
  const key = `${file.path}\0${file.etag}`;
  if (titles.has(key)) return titles.get(key)!;
  const head = await readPaneBytes(file, HEAD_BYTES);
  const title = head.includes(0) ? null : designboardTitleFromHead(head.toString("utf8"), head.length >= file.size);
  titles.set(key, title);
  if (titles.size > CACHE_MAX) titles.delete(titles.keys().next().value!);
  return title;
}

/** A file the preview may show, with its canvas title when it is one. Closes the handle. */
async function previewed(file: PaneFile, resolved: string | undefined): Promise<Located> {
  try {
    const title = /\.html?$/i.test(file.path) ? await titleOf(file).catch(() => null) : null;
    return { state: "preview", ...(resolved ? { resolved } : {}), ...(title ? { designboard: title } : {}) };
  } finally {
    await file.handle.close();
  }
}

/**
 * The folders a conversation names, newest first: where a file name it mentions may live when the
 * pane's folder lacks it (a summary recapping work in a skill repo, a scratchpad). A path to a file
 * gives its folder. Only prose and tool summaries count, since tool output can list a whole disk; a
 * URL's host (`//host/…`) and an elided path (`/Users/.../x`) name no folder.
 */
export function mentionedFolders(entries: readonly TranscriptEntry[], home = homedir()): string[] {
  const folders = new Set<string>();
  for (let index = entries.length - 1; index >= 0 && folders.size < MAX_FOLDERS; index--) {
    for (const part of entries[index]!.parts) {
      const text = part.kind === "text" ? part.text : part.kind === "tool" ? part.summary : "";
      for (const match of text.matchAll(PROSE_PATH)) {
        const raw = match[1]!.replace(/[.:]+$/, "");
        if (/^\/\/(?!\/)/.test(raw) || raw.includes("...") || raw.includes("*")) continue;
        const path = resolve(expandHome(raw, home));
        const folder = /^[^.].*\.[a-z\d]{1,10}$/i.test(basename(path)) ? dirname(path) : path;
        if (folder !== sep) folders.add(folder);
      }
    }
  }
  return [...folders].slice(0, MAX_FOLDERS);
}

/**
 * Follow one name: as given (`~/` is the bridge user's home), then under each folder the
 * conversation names, without climbing out of it. Inside the pane's folder the preview's own checks
 * decide; outside it only a device that could open the file anyway may look.
 */
async function locate(cwd: string | undefined, name: string, scope: MentionScope): Promise<Located> {
  if (!cwd) return { state: "missing" };
  const own = expandHome(name, scope.home ?? homedir());
  async function* candidates() {
    yield own;
    if (isAbsolute(own)) return;
    for (const folder of await scope.folders?.() ?? []) {
      const candidate = resolve(folder, own);
      if (candidate.startsWith(folder + sep)) yield candidate;
    }
  }
  let outsideByName = false;
  for await (const candidate of candidates()) {
    const moved = candidate !== name;
    const file = await openPaneFile(cwd, candidate, candidate === own ? scope.delivered : undefined);
    if (!(file instanceof Response)) return previewed(file, moved ? file.path : undefined);
    // Too large, or a type with no viewer: it is there, and the viewer offers the confirmed Open.
    if (file.status === 413 || file.status === 415) return { state: "preview", ...(moved && { resolved: candidate }) };
    if (file.headers.get(FILE_STATE_HEADER) !== "outside-project") continue;
    if (!scope.openable) { outsideByName ||= candidate === own; continue; }
    const real = await scope.openable(resolve(cwd, candidate));
    if (real) return { state: "outside", resolved: real };
  }
  // The preview's own answer for a path beyond the folder, decided from the name alone.
  return outsideByName ? { state: "outside", ...(own !== name && { resolved: own }) } : { state: "missing" };
}

/** One small answer per name, so the chat never transfers whole canvases to draw its cards. */
export async function artifactMetadata(
  cwd: string | undefined,
  paths: string[],
  scope: MentionScope = {},
): Promise<ArtifactMetadata[]> {
  if (paths.length > 20) throw new Error("At most 20 paths per request.");
  return Promise.all([...new Set(paths)].map(async (path): Promise<ArtifactMetadata> =>
    ({ path, ...await locate(cwd, path, scope).catch((): Located => ({ state: "missing" })) })));
}
