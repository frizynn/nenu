import { designboardTitleFromHead } from "./designboard.ts";
import { openPaneFile, readPaneBytes } from "./pane-files.ts";

export interface ArtifactMetadata {
  path: string;
  kind: "designboard";
  title: string;
}

/** Canvas templates put the embedded document within the first ~15 KB; the rest is artboards. */
const HEAD_BYTES = 64 * 1024;
const CACHE_MAX = 256;
/** Title (or null) per file identity, so the files browser re-listing a folder costs only opens. */
const titles = new Map<string, string | null>();

async function titleOf(cwd: string | undefined, path: string): Promise<string | null> {
  const file = await openPaneFile(cwd, path);
  if (file instanceof Response) return null;
  try {
    const key = `${file.path}\0${file.etag}`;
    if (titles.has(key)) return titles.get(key)!;
    const head = await readPaneBytes(file, HEAD_BYTES);
    const title = head.includes(0) ? null : designboardTitleFromHead(head.toString("utf8"), head.length >= file.size);
    titles.set(key, title);
    if (titles.size > CACHE_MAX) titles.delete(titles.keys().next().value!);
    return title;
  } finally {
    await file.handle.close();
  }
}

/** Small metadata replies avoid transferring whole canvases just to populate the list. */
export async function artifactMetadata(
  cwd: string | undefined,
  paths: string[],
): Promise<ArtifactMetadata[]> {
  if (paths.length > 20) throw new Error("At most 20 paths per request.");
  const html = [...new Set(paths)].filter((path) => /\.html?$/i.test(path));
  const found = await Promise.all(html.map(async (path) => {
    const title = await titleOf(cwd, path).catch(() => null);
    return title ? { path, kind: "designboard" as const, title } : null;
  }));
  return found.filter((entry) => entry !== null);
}
