import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebAssetArchive } from "./web-assets.ts";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
test("an open client can still load its hashed module after the build is replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "nenu-assets-"));
  dirs.push(root);
  const dist = join(root, "dist");
  await mkdir(join(dist, "assets"), { recursive: true });
  await writeFile(join(dist, "build-info.json"), "first");
  await writeFile(join(dist, "assets/file-preview-abcdefgh.js"), "old module");
  const archive = new WebAssetArchive(join(root, "archive"));
  await archive.retain(dist);
  await rm(dist, { recursive: true });
  await mkdir(join(dist, "assets"), { recursive: true });
  await writeFile(join(dist, "build-info.json"), "second");
  await writeFile(join(dist, "assets/file-preview-ijklmnop.js"), "new module");
  await archive.retain(dist);
  expect(
    await Bun.file(
      (await archive.resolve("assets/file-preview-abcdefgh.js"))!,
    ).text(),
  ).toBe("old module");
  expect(await archive.resolve("assets/../../private.js")).toBeNull();
  expect(await archive.resolve("index.html")).toBeNull();
  const restarted = new WebAssetArchive(join(root, "archive"));
  expect(
    await restarted.resolve("assets/file-preview-abcdefgh.js"),
  ).not.toBeNull();
});

test("retained assets expire and symlinks never expose files outside the archive", async () => {
  const { symlink, utimes } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "nenu-assets-"));
  dirs.push(root);
  const dist = join(root, "dist"),
    cache = join(root, "archive");
  await mkdir(join(dist, "assets"), { recursive: true });
  await mkdir(cache);
  await writeFile(join(cache, "expired-abcdefgh.js"), "expired");
  await utimes(join(cache, "expired-abcdefgh.js"), new Date(0), new Date(0));
  const privateFile = join(root, "private");
  await writeFile(privateFile, "private");
  await symlink(privateFile, join(cache, "linked-abcdefgh.js"));
  await writeFile(join(dist, "build-info.json"), "current");
  await writeFile(join(dist, "assets/current-abcdefgh.js"), "current");
  const archive = new WebAssetArchive(cache);
  await archive.retain(dist);
  expect(await archive.resolve("assets/expired-abcdefgh.js")).toBeNull();
  expect(await archive.resolve("assets/linked-abcdefgh.js")).toBeNull();
  expect(await archive.resolve("assets/current-abcdefgh.js")).not.toBeNull();
});
