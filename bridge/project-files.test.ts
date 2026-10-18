import { test, expect } from "bun:test";
import { mkdtemp, mkdir, realpath, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { projectFiles } from "./project-files.ts";
import { nenuDirs } from "./uploads.ts";
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

test("lists no credential files, Mac secret stores or Nenu's own state, even from a home folder", async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "nenu-tree-")));
  const home = join(temp, "home");
  const state = join(home, ".local", "state", "collie");
  try {
    await mkdir(join(state, "uploads"), { recursive: true });
    await writeFile(join(state, "uploads", "w1_p1-mv8g-0a1b2c3d-notes.txt"), "uploaded");
    await mkdir(join(home, ".local", "state", "nenu", "uploads"), { recursive: true });
    await writeFile(join(home, ".local", "state", "nenu", "uploads", "w1_p1-mv8g-0a1b2c3e-notes.txt"), "uploaded");
    await mkdir(join(home, "Library", "Keychains"), { recursive: true });
    await mkdir(join(home, "Library", "Fonts"));
    await mkdir(join(home, ".docker"));
    await writeFile(join(home, ".docker", "config.json"), "{}");
    await writeFile(join(home, ".claude.json"), "{}");
    await writeFile(join(home, ".zsh_history"), "export TOKEN=1");
    await writeFile(join(home, "notes.md"), "fine");
    await symlink(join(state, "uploads"), join(home, "attached"));
    await symlink(join(home, "Library", "Keychains"), join(home, "keys"));
    const own = nenuDirs(state, home);
    const names = async (directory: string) => (await projectFiles(home, directory, own)).files.map((f) => f.name);
    expect(await names(".")).toEqual([".local", "Library", "notes.md"]);
    expect(await names("Library")).toEqual(["Fonts"]);
    expect(await names(".local/state")).toEqual(["nenu"]);
    expect(await names(".local/state/nenu")).toEqual([]);
    for (const directory of ["Library/Keychains", "keys", ".docker", ".local/state/collie", ".local/state/collie/uploads",
      ".local/state/nenu/uploads", "attached"])
      await expect(projectFiles(home, directory, own)).rejects.toThrow("unavailable");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
