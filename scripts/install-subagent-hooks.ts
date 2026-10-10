import { join } from "node:path";
import { object } from "../bridge/subagent-files.ts";
import { loadConfig } from "../bridge/config.ts";
import { defaultSettingsPath, pluginRoot, updateClaudeSettings } from "./install-claude-hooks.ts";

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
  const settingsPath = process.argv[2] ?? defaultSettingsPath();
  const stateDir = process.argv[3] ?? loadConfig().stateDir;
  const script = join(pluginRoot("subagent-hook.ts"), "scripts", "subagent-hook.ts");
  const command = [process.execPath, script, stateDir].map(quote).join(" ");
  await updateClaudeSettings(settingsPath, (settings) => subagentHookSettings(settings, command), "nenu-backup");
  console.log(`Nenu subagent hooks installed from ${script}; existing hooks preserved.`);
}
