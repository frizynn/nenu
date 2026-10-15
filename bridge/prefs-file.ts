import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * A bridge-wide setting kept as JSON in the state dir, so it survives the restart a backend change
 * needs. Whatever the file holds goes through `coerce`, so a missing file, a missing key or a wrong
 * type reads as the default. Written owner-only and atomically: a fresh 0600 temp file, then a rename.
 */
export class PrefsFile<T extends object> {
  private value: T;

  constructor(private readonly file: string, private readonly coerce: (raw: unknown) => T) {
    this.value = coerce(undefined);
  }

  async load(): Promise<void> {
    try {
      this.value = this.coerce(await Bun.file(this.file).json());
    } catch {
      /* none saved yet — keep defaults */
    }
  }

  /** A copy of the current value (never the internal object, so callers can't mutate our state). */
  current(): T {
    return { ...this.value };
  }

  async set(next: T): Promise<T> {
    this.value = { ...next };
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.value, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
    return this.current();
  }
}
