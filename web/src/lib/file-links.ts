/** Local document references are actions, never browser navigation URLs. The bridge applies the
 * authoritative realpath/access checks; this only recognizes links in agent prose. */
export function localFilePath(raw: string): string | null {
  let path = raw.trim();
  if (path.startsWith("<") && path.endsWith(">")) path = path.slice(1, -1);
  path = path.replace(/(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/, "");
  // Agents link host files as `file:///abs/path`. Read it as the absolute path it names; a file URL
  // for another host, or with a query or fragment left over, is not a local document.
  if (/^file:/i.test(path)) {
    const local = /^file:\/\/(?:localhost)?(\/[^?#]*)$/i.exec(path);
    if (!local) return null;
    path = local[1]!;
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith("//") || /[\x00-\x1f\\]/.test(path)) return null;
  try { path = decodeURIComponent(path); } catch { return null; }
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith("//") || /[\x00-\x1f\\]/.test(path)) return null;
  path = path.replace(/(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/, "");
  return /\.(?:md|markdown|mdx|pdf|txt|log|csv|tsv|json|jsonc|jsonl|ya?ml|toml|xml|[cm]?js|jsx|ts|tsx|py|rb|sh|bash|zsh|s?css|html?|svg|sql|rs|go|java|kt|swift|c|h|cpp|hpp|graphql|prisma|diff|patch|ini|conf|rst|png|jpe?g|gif|webp|mp4|m4v|mov|webm)$/i.test(path) || /(?:^|\/)(?:readme|licen[sc]e|dockerfile|makefile|\.gitignore|\.gitattributes|\.editorconfig)$/i.test(path) ? path : null;
}

/** A live pane's folder, as the file viewer needs it to find who may open a path. */
export interface PaneRoot { paneId: string; cwd?: string; label: string }

/**
 * The pane whose folder holds an absolute `path`, deepest folder first, other than `except`. The
 * bridge still checks containment against that pane's own cwd; this only picks whom to ask.
 */
export function paneOwningPath(panes: readonly PaneRoot[], path: string, except: string): PaneRoot | undefined {
  if (!path.startsWith("/")) return undefined;
  return panes
    .filter((pane) => pane.paneId !== except && pane.cwd && pane.cwd !== "/" && path.startsWith(pane.cwd.replace(/\/+$/, "") + "/"))
    .sort((a, b) => b.cwd!.length - a.cwd!.length)[0];
}
