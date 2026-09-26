import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { containedRealpath } from "./journal/files.ts";
import { isPrivateProjectPath } from "./pane-files.ts";

/** One directory at a time, with the same containment and private-file policy as previews. */
export async function projectFiles(cwd: string | undefined, directory = ".") {
  if (
    !cwd ||
    !isAbsolute(cwd) ||
    directory.length > 4096 ||
    /[\x00-\x1f]/.test(directory) ||
    isPrivateProjectPath(directory)
  )
    throw new Error("Directory unavailable.");
  const root = await realpath(cwd);
  if (root === sep) throw new Error("Directory unavailable.");
  const path = await containedRealpath(resolve(root, directory), root);
  if (!path || isPrivateProjectPath(path))
    throw new Error("Directory unavailable.");
  const names = await readdir(path, { withFileTypes: true });
  const visible = names.filter(
    (entry) =>
      !isPrivateProjectPath(entry.name) &&
      !["node_modules", ".next", ".cache"].includes(entry.name),
  );
  visible.sort(
    (a, b) =>
      Number(b.isDirectory()) - Number(a.isDirectory()) ||
      a.name.localeCompare(b.name),
  );
  const files = (
    await Promise.all(
      visible.slice(0, 300).map(async (entry) => {
        const target = await containedRealpath(resolve(path, entry.name), root);
        if (!target || isPrivateProjectPath(target)) return null;
        const info = await stat(target).catch(() => null);
        if (!info || (!info.isFile() && !info.isDirectory())) return null;
        return {
          name: entry.name,
          path: relative(root, resolve(path, entry.name)),
          kind: info.isDirectory() ? "directory" : "file",
          size: info.size,
          updatedAt: info.mtime.toISOString(),
        };
      }),
    )
  ).filter((entry) => entry !== null);
  return {
    path: relative(root, path) || ".",
    files,
    truncated: visible.length > 300,
  };
}
