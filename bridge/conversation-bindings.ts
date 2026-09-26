import { readFileSync, statSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import { isCodexSessionId } from "./journal/codex.ts";

interface Binding { id: string; process: string; hook: string }

/** Only ids and process hashes are stored. Every use revalidates the live terminal. */
export class ConversationBindings {
  private values = new Map<string, Binding>();
  private writing: Promise<void> = Promise.resolve();
  constructor(private readonly file?: string) {
    if (!file) return;
    try {
      if (statSync(file).size > 256_000) return;
      const data: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(data)) return;
      for (const row of data.slice(-200)) {
        if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== "string") continue;
        const value: unknown = row[1];
        if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string" || !isCodexSessionId(value.id) ||
          !("process" in value) || typeof value.process !== "string" || !("hook" in value) || typeof value.hook !== "string") continue;
        this.values.set(row[0], { id: value.id, process: value.process, hook: value.hook });
      }
    } catch { /* Missing or invalid state requires explicit recovery again. */ }
  }
  has(key: string): boolean { return this.values.has(key); }
  get(key: string, process: string, hook: string): string | null {
    const binding = this.values.get(key);
    if (!binding) return null;
    if (binding.process !== process || binding.hook !== hook) { this.values.delete(key); return null; }
    return binding.id;
  }
  set(key: string, value: Binding): Promise<void> {
    const write = this.writing.catch(() => {}).then(async () => {
      const next = new Map(this.values);
      next.delete(key);
      next.set(key, value);
      if (next.size > 200) next.delete(next.keys().next().value!);
      if (this.file) {
        const temp = `${this.file}.${crypto.randomUUID()}.tmp`;
        await writeFile(temp, JSON.stringify([...next]), { mode: 0o600 });
        await rename(temp, this.file);
      }
      this.values = next;
    });
    this.writing = write;
    return write;
  }
}
