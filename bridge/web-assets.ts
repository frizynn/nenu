import { constants } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { containedRealpath } from "./journal/files.ts";

const ASSET =
  /^[\w.-]+-[\w-]{8,}\.(?:js|mjs|css|wasm|svg|png|jpe?g|webp|woff2?)$/;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Hashed public assets only. Survives restarts and linked-checkout changes. */
export class WebAssetArchive {
  private stamp = "";
  private pending: Promise<void> | null = null;
  constructor(private directory: string) {}

  async retain(webDir: string): Promise<void> {
    const info = await stat(join(webDir, "build-info.json")).catch(() => null);
    if (!info) return;
    const stamp = `${webDir}:${info.mtimeMs}:${info.size}`;
    if (this.pending) return this.pending;
    if (this.stamp === stamp) return;
    this.pending = this.copyAssets(webDir);
    try {
      await this.pending;
      this.stamp = stamp;
    } finally {
      this.pending = null;
    }
  }

  private async copyAssets(webDir: string) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const assets = join(webDir, "assets");
    const entries = await readdir(assets, { withFileTypes: true });
    const now = new Date();
    for (const entry of entries) {
      if (!entry.isFile() || !ASSET.test(entry.name)) continue;
      const source = join(assets, entry.name);
      const size = (await stat(source)).size;
      if (size > MAX_BYTES) continue;
      const target = join(this.directory, entry.name);
      const temporary = `${target}.${crypto.randomUUID()}.tmp`;
      try {
        await copyFile(source, temporary, constants.COPYFILE_EXCL);
        await rename(temporary, target);
      } finally {
        await unlink(temporary).catch(() => {});
      }
    }
    const saved = await readdir(this.directory, { withFileTypes: true });
    const files = await Promise.all(
      saved
        .filter((e) => e.isFile() && ASSET.test(e.name))
        .map(async (e) => {
          const path = join(this.directory, e.name);
          const info = await stat(path);
          return { path, size: info.size, modified: info.mtimeMs };
        }),
    );
    let total = 0;
    for (const file of files.sort((a, b) => b.modified - a.modified)) {
      total += file.size;
      if (total > MAX_BYTES || now.getTime() - file.modified > MAX_AGE_MS)
        await unlink(file.path);
    }
  }

  async resolve(relative: string): Promise<string | null> {
    if (!relative.startsWith("assets/")) return null;
    const name = relative.slice(7);
    if (!ASSET.test(name)) return null;
    const root = await realpath(this.directory).catch(() => null);
    if (!root) return null;
    const path = join(root, name);
    const safe = await containedRealpath(path, root);
    return safe === path &&
      (await stat(path)
        .then((s) => s.isFile())
        .catch(() => false))
      ? path
      : null;
  }
}
