import { designboardTitle } from "./designboard.ts";
import { paneFileResponse } from "./pane-files.ts";

export interface ArtifactMetadata {
  path: string;
  kind: "designboard";
  title: string;
}

/** Small metadata replies avoid transferring whole canvases just to populate the list. */
export async function artifactMetadata(
  cwd: string | undefined,
  paths: string[],
): Promise<ArtifactMetadata[]> {
  if (paths.length > 20) throw new Error("At most 20 paths per request.");
  const result: ArtifactMetadata[] = [];
  for (const path of new Set(paths)) {
    if (!/\.html?$/i.test(path)) continue;
    const response = await paneFileResponse(cwd, path);
    if (!response.ok) continue;
    const title = designboardTitle(await response.text());
    if (title) result.push({ path, kind: "designboard", title });
  }
  return result;
}
