// Pure helpers for the new-chat folder picker. Its one text field holds a path, the way T3 Code's
// project browser does: everything up to the last "/" is the folder being listed, and whatever
// follows filters that folder's subfolders.

/** `/Users/me/code` → `~/code` when it is under `home`; any other path unchanged. */
export function tildePath(path: string, home: string): string {
  if (!home || home === "/") return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** `~/code` → `/Users/me/code`; absolute paths unchanged. */
export function expandPath(path: string, home: string): string {
  return path === "~" || path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
}

export function baseName(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}

/** The listed folder (as typed, up to the last "/") and the filter after it. "~" alone is home. */
export function parseQuery(query: string): { dir: string; filter: string } {
  if (query === "~") return { dir: "~", filter: "" };
  const cut = query.lastIndexOf("/") + 1;
  return { dir: query.slice(0, cut), filter: query.slice(cut) };
}

/** Prefix matches first, then names that merely contain the filter; case-insensitive. */
export function matchDirs(entries: readonly string[], filter: string): string[] {
  const needle = filter.toLowerCase();
  if (!needle) return [...entries];
  const starts = entries.filter((e) => e.toLowerCase().startsWith(needle));
  return [...starts, ...entries.filter((e) => !starts.includes(e) && e.toLowerCase().includes(needle))];
}

/** Each ancestor of a `~/…` or absolute folder as a tappable step, ending in a "/" ready to list. */
export function crumbs(folder: string): Array<{ label: string; query: string }> {
  const [head, ...rest] = folder.split("/");
  const steps = [{ label: head || "/", query: `${head}/` }];
  for (const part of rest.filter(Boolean)) steps.push({ label: part, query: `${steps[steps.length - 1]!.query}${part}/` });
  return steps;
}
