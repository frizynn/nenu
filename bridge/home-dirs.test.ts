import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listHomeDirs } from "./home-dirs.ts";

let base: string;
let home: string;
let outside: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "home-dirs-")));
  home = join(base, "home");
  outside = join(base, "outside");
  for (const dir of ["code/nenu", "code/Website", "code/app10", "code/app9", ".hidden", ".ssh", ".config/tool", "Documents"]) mkdirSync(join(home, dir), { recursive: true });
  mkdirSync(join(outside, "secret"), { recursive: true });
  writeFileSync(join(home, "code", "notes.txt"), "file, not a folder");
  symlinkSync(outside, join(home, "code", "escape"));
  symlinkSync(join(home, "Documents"), join(home, "code", "docs"));
  symlinkSync(join(home, ".ssh"), join(home, "code", "keys"));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const list = (path: string | null, hidden = false) => listHomeDirs(path, { home, hidden });

describe("listHomeDirs", () => {
  test("lists home's folders by default, without dot-dirs or files", async () => {
    expect(await list(null)).toEqual({ path: home, home, entries: ["code", "Documents"], truncated: false });
    expect((await list("~")).entries).toEqual(["code", "Documents"]);
  });

  test("accepts ~/, relative and absolute spellings of the same folder, sorted naturally", async () => {
    const expected = { path: join(home, "code"), home, entries: ["app9", "app10", "docs", "nenu", "Website"], truncated: false };
    expect(await list("~/code")).toEqual(expected);
    expect(await list("code/")).toEqual(expected);
    expect(await list(join(home, "code"))).toEqual(expected);
  });

  test("shows dot-dirs only when asked, and never the private ones", async () => {
    expect((await list("~", true)).entries).toEqual([".hidden", "code", "Documents"]);
    await expect(list("~/.ssh", true)).rejects.toThrow("unavailable");
    await expect(list("~/.config/tool", true)).rejects.toThrow("unavailable");
  });

  test("a symlink is followed only when it lands inside home", async () => {
    expect((await list("~/code/docs")).path).toBe(join(home, "Documents"));
    await expect(list("~/code/escape")).rejects.toThrow("unavailable");
    await expect(list("~/code/escape/secret")).rejects.toThrow("unavailable");
    await expect(list("~/code/keys")).rejects.toThrow("unavailable");
  });

  test("never leaves home through .. or an absolute path", async () => {
    for (const path of ["..", "~/..", "~/code/../../outside", "../outside/secret", outside, "/", "/etc", base]) {
      await expect(list(path)).rejects.toThrow("unavailable");
    }
  });

  test("refuses files, missing folders, control characters and a home that is the filesystem root", async () => {
    for (const path of ["~/code/notes.txt", "~/nope", "~/co\nde", "x".repeat(5000)]) await expect(list(path)).rejects.toThrow();
    await expect(listHomeDirs("~", { home: "/" })).rejects.toThrow("unavailable");
  });

  test("caps a huge directory and says so", async () => {
    const big = join(home, "big");
    for (let i = 0; i < 520; i++) mkdirSync(join(big, `d${i}`), { recursive: true });
    const result = await list("~/big");
    expect(result.entries).toHaveLength(500);
    expect(result.truncated).toBe(true);
  });
});
