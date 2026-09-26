/** Local document references are actions, never browser navigation URLs. The bridge applies the
 * authoritative realpath/access checks; this only recognizes links in agent prose. */
export function localFilePath(raw: string): string | null {
  let path = raw.trim();
  if (path.startsWith("<") && path.endsWith(">")) path = path.slice(1, -1);
  path = path.replace(/(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/, "");
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith("//") || /[\x00-\x1f\\]/.test(path)) return null;
  try { path = decodeURIComponent(path); } catch { return null; }
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith("//") || /[\x00-\x1f\\]/.test(path)) return null;
  path = path.replace(/(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/, "");
  return /\.(?:md|markdown|mdx|pdf|txt|log|csv|tsv|json|jsonc|jsonl|ya?ml|toml|xml|[cm]?js|jsx|ts|tsx|py|rb|sh|bash|zsh|s?css|html?|svg|sql|rs|go|java|kt|swift|c|h|cpp|hpp|graphql|prisma|diff|patch|ini|conf|rst|png|jpe?g|gif|webp|mp4|m4v|mov|webm)$/i.test(path) || /(?:^|\/)(?:readme|licen[sc]e|dockerfile|makefile|\.gitignore|\.gitattributes|\.editorconfig)$/i.test(path) ? path : null;
}
