import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { projectFiles } from "./project-files.ts";
test("browses project folders but refuses private files and escaping symlinks", async () => {
  const temp = await mkdtemp(join(tmpdir(), "nenu-tree-"));
  const root = join(temp, "project");
  try {
    await mkdir(root);
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "demo.html"), "hello");
    await writeFile(join(root, ".env"), "private");
    await writeFile(join(temp, "outside.txt"), "outside");
    await symlink(join(temp, "outside.txt"), join(root, "leak.txt"));
    const page = await projectFiles(root);
    expect(page.files.map((f) => f.name)).toEqual(["docs", "demo.html"]);
    await expect(projectFiles(root, "..")).rejects.toThrow();
    expect((await projectFiles(root, "docs")).files).toEqual([]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
