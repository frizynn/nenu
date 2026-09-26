import { readFile, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { object } from "../bridge/subagent-files.ts";
import { loadConfig } from "../bridge/config.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function subagentHookSettings(settings: unknown, command: string): Record<string, unknown> {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Invalid Claude settings object.");
  const source = object(settings);
  if (source.hooks !== undefined && (!source.hooks || typeof source.hooks !== "object" || Array.isArray(source.hooks))) throw new Error("Invalid Claude hooks object.");
  const hooks = { ...object(source.hooks) };
  for (const event of ["SubagentStart", "SubagentStop"]) {
    const existing = hooks[event];
    if (existing !== undefined && !Array.isArray(existing)) throw new Error(`Invalid ${event} hooks.`);
    const other = (Array.isArray(existing) ? existing : []).flatMap((entry) => {
      const row = object(entry);
      if (!Array.isArray(row.hooks)) throw new Error(`Invalid ${event} hook row.`);
      const kept = row.hooks.filter((hook) => !(typeof object(hook).command === "string" && String(object(hook).command).includes("/scripts/subagent-hook.ts")));
      return kept.length ? [{ ...row, hooks: kept }] : [];
    });
    hooks[event] = [...other, { hooks: [{ type: "command", command, timeout: 5 }] }];
  }
  return { ...source, hooks };
}

if (import.meta.main) {
  const settingsPath = process.argv[2] ?? join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");
  const stateDir = process.argv[3] ?? loadConfig().stateDir;
  const command = [process.execPath, resolve(import.meta.dir, "subagent-hook.ts"), stateDir].map(quote).join(" ");
  const before = await readFile(settingsPath, "utf8");
  const next = JSON.stringify(subagentHookSettings(JSON.parse(before), command), null, 2) + "\n";
  if (next !== before) {
    await writeFile(`${settingsPath}.nenu-backup-${Date.now()}`, before, { mode: 0o600, flag: "wx" });
    const temporary = `${settingsPath}.nenu-${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, next, { mode: 0o600, flag: "wx" });
    if (await readFile(settingsPath, "utf8") !== before) throw new Error("Claude settings changed; retry installation.");
    await rename(temporary, settingsPath);
  }
  console.log("Nenu subagent hooks installed; existing hooks preserved.");
}
