import { opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { containedRealpath } from "./journal/files.ts";
import { isPrivateProjectPath } from "./pane-files.ts";

// The new-chat folder picker. It is the one listing not anchored to a pane: it walks the operator's
// home directory, so it answers with directory NAMES only (no files, sizes or dates), never leaves
// home after symlink resolution, refuses the private directories previews refuse, and stops reading
// a huge directory early (.adr/0055).

const MAX_ENTRIES = 500;
const MAX_SCANNED = 5_000;

export interface HomeDirListing {
  /** The listed directory's real absolute path: what a new tab or workspace is created in. */
  path: string;
  /** The real home directory, so the client can show `~/…`. */
  home: string;
  entries: string[];
  truncated: boolean;
}

export interface HomeDirOptions {
  home?: string;
  hidden?: boolean;
}

const unavailable = () => new Error("Directory unavailable.");

/** `~`, `~/x`, a path relative to home, or an absolute path; listed only if it is really under home. */
export async function listHomeDirs(requested: string | null, { home = homedir(), hidden = false }: HomeDirOptions = {}): Promise<HomeDirListing> {
  const raw = (requested ?? "").trim() || "~";
  if (raw.length > 4096 || /[\x00-\x1f]/.test(raw)) throw unavailable();
  const root = await containedRealpath(home, home);
  if (!root || root === sep) throw unavailable();
  const candidate = raw === "~" || raw.startsWith("~/") ? join(root, raw.slice(1)) : isAbsolute(raw) ? raw : resolve(root, raw);
  const path = await containedRealpath(candidate, root);
  if (!path || isPrivateProjectPath(relative(root, path)) || !(await stat(path)).isDirectory()) throw unavailable();

  const entries: string[] = [];
  let scanned = 0;
  let truncated = false;
  for await (const entry of await opendir(path)) {
    if (++scanned > MAX_SCANNED || entries.length === MAX_ENTRIES) {
      truncated = true;
      break;
    }
    if ((!hidden && entry.name.startsWith(".")) || isPrivateProjectPath(entry.name)) continue;
    if (entry.isDirectory() || (entry.isSymbolicLink() && (await linkedDirIn(join(path, entry.name), root)))) entries.push(entry.name);
  }
  entries.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
  return { path, home: root, entries, truncated };
}

/** A symlink is listed only when it lands on a directory that is itself inside home. */
async function linkedDirIn(link: string, root: string): Promise<boolean> {
  const target = await containedRealpath(link, root);
  return target !== null && !isPrivateProjectPath(relative(root, target)) && (await stat(target).catch(() => null))?.isDirectory() === true;
}
